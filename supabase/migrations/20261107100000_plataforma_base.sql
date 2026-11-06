-- Aura IA · Fase 1: base da plataforma e canal WhatsApp.
-- Produtos (Clinova, Agenda+, Belariz) -> empresas -> canal (número) -> contatos -> conversas -> mensagens.
-- Ninguém acessa estas tabelas direto: tudo passa pelas funções de servidor (service_role).
-- Lógica de entrada de mensagens trazida do Clinova (testada em 2026-11-06).

CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC;

-- Produto que usa a Aura IA. A chave de API é guardada só como hash.
CREATE TABLE public.apps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]{2,40}$'),
  name text NOT NULL,
  api_key_hash text UNIQUE,
  api_key_prefix text,
  webhook_url text CHECK (webhook_url IS NULL OR webhook_url ~ '^https://'),
  webhook_secret text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Empresa (clínica, consultório, estúdio) dentro de um produto. external_id = id dela no produto.
CREATE TABLE public.workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES public.apps(id) ON DELETE CASCADE,
  external_id text NOT NULL,
  name text NOT NULL,
  timezone text NOT NULL DEFAULT 'America/Sao_Paulo',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, external_id)
);

-- Número de WhatsApp da empresa (um por empresa, por enquanto).
CREATE TABLE public.channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL UNIQUE REFERENCES public.workspaces(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'zernio' CHECK (provider IN ('zernio')),
  provider_profile_id text,
  provider_account_id text UNIQUE,
  phone_number text,
  display_name text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'connected', 'disconnected')),
  connected_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Pessoa do outro lado. Quem ela é no negócio (lead, paciente, cliente) o produto informa em external_*.
CREATE TABLE public.contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  phone text NOT NULL,
  phone_key text NOT NULL,
  name text,
  external_type text,
  external_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, phone_key)
);
CREATE INDEX contacts_external_idx ON public.contacts (workspace_id, external_type, external_ref) WHERE external_ref IS NOT NULL;

CREATE TABLE public.conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  channel_id uuid REFERENCES public.channels(id) ON DELETE SET NULL,
  contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  provider_conversation_id text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'archived')),
  last_message_at timestamptz,
  last_message_preview text,
  last_message_direction text,
  last_incoming_at timestamptz,
  unread_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, provider_conversation_id)
);
CREATE INDEX conversations_list_idx ON public.conversations (workspace_id, last_message_at DESC NULLS LAST);
CREATE INDEX conversations_contact_idx ON public.conversations (contact_id);

CREATE TABLE public.messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  provider_message_id text,
  direction text NOT NULL CHECK (direction IN ('incoming', 'outgoing')),
  source text NOT NULL DEFAULT 'contact' CHECK (source IN ('contact', 'human', 'ai', 'template', 'external')),
  sent_by text,
  body text,
  attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'sent' CHECK (status IN ('received', 'sending', 'sent', 'delivered', 'read', 'failed')),
  error text,
  sent_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, provider_message_id)
);
CREATE INDEX messages_conversation_idx ON public.messages (conversation_id, sent_at);

-- Avisos do provedor já processados (o provedor pode repetir).
CREATE TABLE private.provider_events (
  event_id text PRIMARY KEY,
  event text,
  received_at timestamptz NOT NULL DEFAULT now()
);

-- Avisos da Aura IA para os produtos (fila com novas tentativas).
CREATE TABLE public.app_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES public.apps(id) ON DELETE CASCADE,
  workspace_id uuid REFERENCES public.workspaces(id) ON DELETE CASCADE,
  type text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz
);
CREATE INDEX app_events_due_idx ON public.app_events (next_attempt_at) WHERE status = 'pending';

-- Tudo fechado para o público: só o servidor (service_role) lê e grava.
ALTER TABLE public.apps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.apps, public.workspaces, public.channels, public.contacts, public.conversations,
  public.messages, public.app_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON private.provider_events FROM PUBLIC, anon, authenticated;

-- ---------- Telefone ----------

-- Chave para comparar números do Brasil com e sem o 9: DDD + últimos 8 dígitos.
CREATE FUNCTION private.phone_key(p_phone text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  d text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
BEGIN
  IF length(d) IN (12, 13) AND left(d, 2) = '55' THEN d := substr(d, 3); END IF;
  IF length(d) IN (10, 11) THEN RETURN left(d, 2) || right(d, 8); END IF;
  IF length(d) < 8 THEN RETURN NULL; END IF;
  RETURN d;
END;
$$;

-- ---------- Avisos para o produto ----------

CREATE FUNCTION private.enqueue_app_event(p_workspace_id uuid, p_type text, p_payload jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  w public.workspaces%ROWTYPE;
  a public.apps%ROWTYPE;
BEGIN
  SELECT * INTO w FROM public.workspaces WHERE id = p_workspace_id;
  SELECT * INTO a FROM public.apps WHERE id = w.app_id;
  IF a.id IS NULL OR a.webhook_url IS NULL OR NOT a.is_active THEN RETURN; END IF;
  INSERT INTO public.app_events (app_id, workspace_id, type, payload)
  VALUES (a.id, w.id, p_type, p_payload || jsonb_build_object('workspace', jsonb_build_object('id', w.id, 'external_id', w.external_id)));
END;
$$;

CREATE FUNCTION private.contact_json(p_contact_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object('id', c.id, 'phone', c.phone, 'name', c.name, 'external_type', c.external_type, 'external_ref', c.external_ref)
  FROM public.contacts c WHERE c.id = p_contact_id
$$;

-- ---------- Entrada: avisos do provedor (Zernio) ----------

CREATE FUNCTION public.aura_ingest_provider_event(p_event jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_event text := p_event ->> 'event';
  v_event_id text := p_event ->> 'id';
  v_account text := coalesce(p_event #>> '{account,accountId}', p_event #>> '{account,id}');
  v_msg jsonb := p_event -> 'message';
  v_conv jsonb := p_event -> 'conversation';
  ch public.channels%ROWTYPE;
  v_contact_id uuid;
  v_new_contact boolean := false;
  v_conv_id uuid;
  v_msg_id uuid;
  v_direction text;
  v_body text;
  v_at timestamptz;
  v_phone text;
  v_name text;
  v_new_status text;
  v_rows integer;
BEGIN
  IF v_event_id IS NULL OR v_event IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_event');
  END IF;
  IF v_event = 'webhook.test' OR coalesce((p_event ->> 'test')::boolean, false) THEN
    RETURN jsonb_build_object('ok', true, 'ignored', 'test');
  END IF;
  IF coalesce(v_msg ->> 'platform', 'whatsapp') <> 'whatsapp' THEN
    RETURN jsonb_build_object('ok', true, 'ignored', 'platform');
  END IF;

  SELECT * INTO ch FROM public.channels WHERE provider_account_id = v_account;
  IF ch.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'unknown_account'); END IF;

  INSERT INTO private.provider_events (event_id, event) VALUES (v_event_id, v_event) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN RETURN jsonb_build_object('ok', true, 'duplicate', true); END IF;

  IF v_event IN ('message.received', 'message.sent') THEN
    v_direction := CASE WHEN v_event = 'message.received' THEN 'incoming' ELSE coalesce(v_msg ->> 'direction', 'outgoing') END;
    v_body := v_msg ->> 'text';
    v_at := coalesce((v_msg ->> 'sentAt')::timestamptz, now());
    v_phone := regexp_replace(coalesce(v_conv ->> 'participantId',
      CASE WHEN v_direction = 'incoming' THEN coalesce(v_msg #>> '{sender,phoneNumber}', v_msg #>> '{sender,id}') END, ''), '\D', '', 'g');
    v_name := coalesce(nullif(v_conv ->> 'participantName', ''), CASE WHEN v_direction = 'incoming' THEN v_msg #>> '{sender,name}' END);
    IF private.phone_key(v_phone) IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'no_phone');
    END IF;

    -- Contato
    INSERT INTO public.contacts (workspace_id, phone, phone_key, name)
    VALUES (ch.workspace_id, v_phone, private.phone_key(v_phone), v_name)
    ON CONFLICT (workspace_id, phone_key) DO NOTHING
    RETURNING id INTO v_contact_id;
    IF v_contact_id IS NOT NULL THEN
      v_new_contact := true;
    ELSE
      SELECT id INTO v_contact_id FROM public.contacts WHERE workspace_id = ch.workspace_id AND phone_key = private.phone_key(v_phone);
      UPDATE public.contacts SET name = coalesce(name, v_name) WHERE id = v_contact_id;
    END IF;

    -- Conversa
    INSERT INTO public.conversations (workspace_id, channel_id, contact_id, provider_conversation_id)
    VALUES (ch.workspace_id, ch.id, v_contact_id, coalesce(v_conv ->> 'id', v_msg ->> 'conversationId'))
    ON CONFLICT (workspace_id, provider_conversation_id) DO UPDATE SET channel_id = EXCLUDED.channel_id
    RETURNING id INTO v_conv_id;

    -- Mensagem (a enviada pela Aura já foi gravada: o eco do provedor não duplica)
    INSERT INTO public.messages (workspace_id, conversation_id, provider_message_id, direction, source, body, attachments, status, sent_at)
    VALUES (ch.workspace_id, v_conv_id, v_msg ->> 'platformMessageId', v_direction,
      CASE WHEN v_direction = 'incoming' THEN 'contact' ELSE 'external' END,
      v_body, coalesce(v_msg -> 'attachments', '[]'::jsonb),
      CASE WHEN v_direction = 'incoming' THEN 'received' ELSE 'sent' END, v_at)
    ON CONFLICT (workspace_id, provider_message_id) DO NOTHING
    RETURNING id INTO v_msg_id;

    IF v_msg_id IS NOT NULL THEN
      UPDATE public.conversations SET
        last_message_at = greatest(coalesce(last_message_at, v_at), v_at),
        last_message_preview = CASE WHEN last_message_at IS NULL OR v_at >= last_message_at
          THEN left(coalesce(nullif(v_body, ''), '📎 Anexo'), 140) ELSE last_message_preview END,
        last_message_direction = CASE WHEN last_message_at IS NULL OR v_at >= last_message_at THEN v_direction ELSE last_message_direction END,
        last_incoming_at = CASE WHEN v_direction = 'incoming' THEN greatest(coalesce(last_incoming_at, v_at), v_at) ELSE last_incoming_at END,
        unread_count = unread_count + CASE WHEN v_direction = 'incoming' THEN 1 ELSE 0 END
      WHERE id = v_conv_id;

      IF v_new_contact THEN
        PERFORM private.enqueue_app_event(ch.workspace_id, 'contact.created', jsonb_build_object('contact', private.contact_json(v_contact_id)));
      END IF;
      PERFORM private.enqueue_app_event(ch.workspace_id,
        CASE WHEN v_direction = 'incoming' THEN 'message.received' ELSE 'message.sent' END,
        jsonb_build_object(
          'conversation_id', v_conv_id,
          'contact', private.contact_json(v_contact_id),
          'message', jsonb_build_object('id', v_msg_id, 'direction', v_direction, 'body', v_body,
            'attachments', coalesce(v_msg -> 'attachments', '[]'::jsonb), 'sent_at', v_at)));
    END IF;
    RETURN jsonb_build_object('ok', true, 'conversation_id', v_conv_id, 'contact_id', v_contact_id);
  END IF;

  IF v_event IN ('message.delivered', 'message.read', 'message.failed') THEN
    v_new_status := CASE v_event WHEN 'message.delivered' THEN 'delivered' WHEN 'message.read' THEN 'read' ELSE 'failed' END;
    UPDATE public.messages SET
      status = v_new_status,
      error = CASE WHEN v_new_status = 'failed'
        THEN left(coalesce(p_event #>> '{error,message}', p_event ->> 'error', 'Falha no envio'), 500) ELSE error END
    WHERE workspace_id = ch.workspace_id AND provider_message_id = v_msg ->> 'platformMessageId'
      AND (v_new_status = 'failed'
        OR array_position(ARRAY['sending', 'sent', 'delivered', 'read'], status) < array_position(ARRAY['sending', 'sent', 'delivered', 'read'], v_new_status))
    RETURNING id, conversation_id INTO v_msg_id, v_conv_id;
    IF v_msg_id IS NOT NULL THEN
      PERFORM private.enqueue_app_event(ch.workspace_id, 'message.status',
        jsonb_build_object('conversation_id', v_conv_id, 'message', jsonb_build_object('id', v_msg_id, 'status', v_new_status)));
    END IF;
    RETURN jsonb_build_object('ok', true);
  END IF;

  RETURN jsonb_build_object('ok', true, 'ignored', v_event);
END;
$$;

-- ---------- Saída: mensagem enviada pela Aura (humano, IA ou modelo) ----------

CREATE FUNCTION public.aura_record_outgoing(p_conversation_id uuid, p_provider_message_id text, p_body text, p_source text, p_sent_by text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  c public.conversations%ROWTYPE;
  v_id uuid;
BEGIN
  SELECT * INTO c FROM public.conversations WHERE id = p_conversation_id;
  IF c.id IS NULL THEN RAISE EXCEPTION 'conversation_not_found' USING ERRCODE = '22023'; END IF;
  INSERT INTO public.messages (workspace_id, conversation_id, provider_message_id, direction, source, sent_by, body, status)
  VALUES (c.workspace_id, c.id, p_provider_message_id, 'outgoing', p_source, p_sent_by, p_body, 'sent')
  ON CONFLICT (workspace_id, provider_message_id) DO UPDATE
    SET source = EXCLUDED.source, sent_by = coalesce(public.messages.sent_by, EXCLUDED.sent_by),
        body = coalesce(public.messages.body, EXCLUDED.body)
  RETURNING id INTO v_id;
  UPDATE public.conversations SET last_message_at = now(), last_message_preview = left(p_body, 140),
    last_message_direction = 'outgoing', unread_count = 0
  WHERE id = c.id;
  RETURN v_id;
END;
$$;

-- ---------- Fila de avisos para os produtos ----------

-- Pega avisos vencidos (sem dois entregadores pegarem o mesmo).
CREATE FUNCTION public.aura_claim_app_events(p_limit integer DEFAULT 20)
RETURNS TABLE (id uuid, type text, payload jsonb, webhook_url text, webhook_secret text, attempts integer, created_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT e.id FROM public.app_events e
    WHERE e.status = 'pending' AND e.next_attempt_at <= now()
    ORDER BY e.created_at
    LIMIT greatest(1, least(p_limit, 100))
    FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE public.app_events e SET attempts = e.attempts + 1, next_attempt_at = now() + interval '2 minutes'
    FROM due WHERE e.id = due.id
    RETURNING e.id, e.type, e.payload, e.app_id, e.attempts, e.created_at
  )
  SELECT c.id, c.type, c.payload, a.webhook_url, a.webhook_secret, c.attempts, c.created_at
  FROM claimed c JOIN public.apps a ON a.id = c.app_id;
END;
$$;

-- Resultado da entrega: ok ou nova tentativa (1, 5, 15, 60 min, 6h; desiste após 8 tentativas).
CREATE FUNCTION public.aura_finish_app_event(p_id uuid, p_ok boolean, p_error text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_attempts integer;
BEGIN
  SELECT attempts INTO v_attempts FROM public.app_events WHERE id = p_id;
  IF p_ok THEN
    UPDATE public.app_events SET status = 'delivered', delivered_at = now(), last_error = NULL WHERE id = p_id;
  ELSIF v_attempts >= 8 THEN
    UPDATE public.app_events SET status = 'failed', last_error = left(p_error, 500) WHERE id = p_id;
  ELSE
    UPDATE public.app_events SET last_error = left(p_error, 500),
      next_attempt_at = now() + (ARRAY[1, 5, 15, 60, 360, 360, 360, 360])[greatest(1, v_attempts)] * interval '1 minute'
    WHERE id = p_id;
  END IF;
END;
$$;

-- ---------- Cadastro de produto (feito pela Kynovia, no SQL do servidor) ----------

-- Cria ou atualiza o produto e devolve a chave de API UMA vez (só o hash fica guardado).
CREATE FUNCTION private.create_app_key(p_slug text, p_name text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_key text := 'aura_' || replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
BEGIN
  INSERT INTO public.apps (slug, name, api_key_hash, api_key_prefix)
  VALUES (p_slug, p_name, encode(sha256(convert_to(v_key, 'UTF8')), 'hex'), left(v_key, 12))
  ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, api_key_hash = EXCLUDED.api_key_hash, api_key_prefix = EXCLUDED.api_key_prefix;
  RETURN v_key;
END;
$$;

CREATE FUNCTION public.aura_app_by_key(p_key text)
RETURNS public.apps
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT * FROM public.apps WHERE api_key_hash = encode(sha256(convert_to(coalesce(p_key, ''), 'UTF8')), 'hex') AND is_active
$$;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA private FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.aura_ingest_provider_event(jsonb), public.aura_record_outgoing(uuid, text, text, text, text),
  public.aura_claim_app_events(integer), public.aura_finish_app_event(uuid, boolean, text), public.aura_app_by_key(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.aura_ingest_provider_event(jsonb), public.aura_record_outgoing(uuid, text, text, text, text),
  public.aura_claim_app_events(integer), public.aura_finish_app_event(uuid, boolean, text), public.aura_app_by_key(text)
  TO service_role;
