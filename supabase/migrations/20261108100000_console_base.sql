-- Aura IA · Console: medição de uso e custo de IA, créditos por empresa (pacotes), saúde dos números
-- e dos produtos, alertas, chaves de IA no cofre e usuários do Console (equipe Kynovia).
-- Tudo fechado ao público: o Console fala com a função console-api, que confere o login e usa o servidor.

-- ---------- Configurações da plataforma ----------
CREATE TABLE public.platform_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);
INSERT INTO public.platform_settings (key, value) VALUES
  -- 1 crédito = US$ 0,001 de custo real de IA (1.000 créditos = US$ 1). O preço de venda dos pacotes é definido à parte.
  ('credits_per_usd', '1000'),
  -- Alerta quando a carteira de uma empresa fica abaixo deste % do último pacote comprado.
  ('wallet_low_percent', '20'),
  ('alert_emails', '[]');

-- ---------- Equipe Kynovia com acesso ao Console ----------
CREATE TABLE public.console_users (
  user_id uuid PRIMARY KEY,
  email text NOT NULL,
  role text NOT NULL DEFAULT 'operator' CHECK (role IN ('owner', 'operator', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor uuid,
  actor_email text,
  action text NOT NULL,
  target_type text,
  target_id text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_created_idx ON public.audit_log (created_at DESC);

-- ---------- Provedores de IA (a chave fica no cofre do Supabase) ----------
CREATE TABLE public.ai_providers (
  provider text PRIMARY KEY CHECK (provider IN ('anthropic', 'openai')),
  enabled boolean NOT NULL DEFAULT false,
  key_secret_id uuid,
  key_hint text,
  status text NOT NULL DEFAULT 'not_configured' CHECK (status IN ('not_configured', 'ok', 'error')),
  last_check_at timestamptz,
  last_ok_at timestamptz,
  last_error text,
  -- Saldo: os provedores não informam por API. Quem recarrega registra o valor; a Aura desconta o que consome.
  balance_usd numeric(12, 4),
  balance_set_at timestamptz,
  low_balance_usd numeric(12, 2) NOT NULL DEFAULT 10,
  recharge_url text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.ai_providers (provider, recharge_url) VALUES
  ('anthropic', 'https://console.anthropic.com/settings/billing'),
  ('openai', 'https://platform.openai.com/settings/organization/billing/overview');

-- Preço de cada modelo (US$ por milhão de tokens), usado para calcular o custo de cada uso.
CREATE TABLE public.model_prices (
  provider text NOT NULL REFERENCES public.ai_providers(provider),
  model text NOT NULL,
  label text NOT NULL,
  input_per_mtok numeric(10, 4) NOT NULL,
  cached_input_per_mtok numeric(10, 4) NOT NULL,
  output_per_mtok numeric(10, 4) NOT NULL,
  active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, model)
);
-- Preços oficiais em 2026-11-06 (Anthropic: tabela oficial; OpenAI: developers.openai.com/api/docs/pricing, uso padrão).
INSERT INTO public.model_prices (provider, model, label, input_per_mtok, cached_input_per_mtok, output_per_mtok) VALUES
  ('anthropic', 'claude-haiku-5-5', 'Claude Haiku 5.5', 0.10, 0.01, 0.50),
  ('anthropic', 'claude-sonnet-5-5', 'Claude Sonnet 5.5', 2.00, 0.20, 10.00),
  ('anthropic', 'claude-opus-5-5', 'Claude Opus 5.5', 4.00, 0.20, 20.00),
  ('openai', 'gpt-6-luna', 'GPT-6 Luna', 0.10, 0.01, 0.50),
  ('openai', 'gpt-6.1-terra', 'GPT-6.1 Terra', 1.00, 0.05, 5.00),
  ('openai', 'gpt-6.1-sol', 'GPT-6.1 Sol', 2.00, 0.10, 10.00);

-- ---------- Uso de IA (cada chamada) ----------
CREATE TABLE public.ai_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES public.workspaces(id) ON DELETE SET NULL,
  app_id uuid REFERENCES public.apps(id) ON DELETE SET NULL,
  conversation_id uuid REFERENCES public.conversations(id) ON DELETE SET NULL,
  feature text NOT NULL CHECK (feature IN ('copilot', 'auto', 'eval', 'ping', 'other')),
  provider text NOT NULL,
  model text NOT NULL,
  input_tokens integer NOT NULL DEFAULT 0,
  cached_input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  cost_usd numeric(14, 6) NOT NULL DEFAULT 0,
  credits numeric(14, 3) NOT NULL DEFAULT 0,
  latency_ms integer,
  outcome text NOT NULL DEFAULT 'ok' CHECK (outcome IN ('ok', 'error', 'refused', 'blocked')),
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_usage_workspace_idx ON public.ai_usage (workspace_id, created_at DESC);
CREATE INDEX ai_usage_created_idx ON public.ai_usage (created_at DESC);

-- ---------- Créditos por empresa (pacotes) ----------
CREATE TABLE public.credit_packages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  credits numeric(14, 3) NOT NULL CHECK (credits > 0),
  price_brl numeric(12, 2) NOT NULL CHECK (price_brl >= 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.credit_wallets (
  workspace_id uuid PRIMARY KEY REFERENCES public.workspaces(id) ON DELETE CASCADE,
  balance numeric(14, 3) NOT NULL DEFAULT 0,
  -- Sem crédito: bloqueia a IA (true) ou deixa negativar (false, ex.: cliente com contrato).
  hard_stop boolean NOT NULL DEFAULT true,
  last_grant numeric(14, 3),
  low_alerted_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.credit_ledger (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('purchase', 'bonus', 'adjustment', 'usage')),
  amount numeric(14, 3) NOT NULL,
  balance_after numeric(14, 3) NOT NULL,
  package_id uuid REFERENCES public.credit_packages(id) ON DELETE SET NULL,
  usage_id uuid REFERENCES public.ai_usage(id) ON DELETE SET NULL,
  note text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX credit_ledger_workspace_idx ON public.credit_ledger (workspace_id, created_at DESC);

-- ---------- Saúde ----------
ALTER TABLE public.channels
  ADD COLUMN health text NOT NULL DEFAULT 'unknown' CHECK (health IN ('unknown', 'healthy', 'warning', 'error', 'disconnected')),
  ADD COLUMN health_detail text,
  ADD COLUMN health_checked_at timestamptz,
  ADD COLUMN last_inbound_at timestamptz,
  ADD COLUMN last_outbound_at timestamptz,
  ADD COLUMN last_error_at timestamptz,
  ADD COLUMN last_error text;

ALTER TABLE public.apps
  ADD COLUMN last_delivery_ok_at timestamptz,
  ADD COLUMN last_delivery_error_at timestamptz,
  ADD COLUMN last_delivery_error text;

-- Alertas e incidentes. Um alerta aberto por tipo + alvo (não repete enquanto não resolver).
CREATE TABLE public.alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  severity text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  kind text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  workspace_id uuid REFERENCES public.workspaces(id) ON DELETE CASCADE,
  title text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  occurrences integer NOT NULL DEFAULT 1,
  notified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE UNIQUE INDEX alerts_open_unique ON public.alerts (kind, target_type, target_id) WHERE status = 'open';
CREATE INDEX alerts_status_idx ON public.alerts (status, created_at DESC);

ALTER TABLE public.platform_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.console_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.model_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credit_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credit_wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credit_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.alerts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.platform_settings, public.console_users, public.audit_log, public.ai_providers, public.model_prices,
  public.ai_usage, public.credit_packages, public.credit_wallets, public.credit_ledger, public.alerts FROM PUBLIC, anon, authenticated;

-- ---------- Funções: alertas ----------

-- Abre (ou atualiza) um alerta. Devolve true se é novo (para avisar por e-mail só uma vez).
CREATE FUNCTION public.aura_raise_alert(p_kind text, p_severity text, p_target_type text, p_target_id text,
  p_workspace_id uuid, p_title text, p_detail jsonb DEFAULT '{}'::jsonb)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_rows integer;
BEGIN
  UPDATE public.alerts SET occurrences = occurrences + 1, last_seen_at = now(), detail = p_detail, title = p_title, severity = p_severity
  WHERE kind = p_kind AND target_type = p_target_type AND target_id = p_target_id AND status = 'open';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows > 0 THEN RETURN false; END IF;
  INSERT INTO public.alerts (kind, severity, target_type, target_id, workspace_id, title, detail)
  VALUES (p_kind, p_severity, p_target_type, p_target_id, p_workspace_id, p_title, p_detail);
  RETURN true;
END;
$$;

CREATE FUNCTION public.aura_resolve_alert(p_kind text, p_target_type text, p_target_id text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE public.alerts SET status = 'resolved', resolved_at = now()
  WHERE kind = p_kind AND target_type = p_target_type AND target_id = p_target_id AND status = 'open'
$$;

-- ---------- Funções: créditos e uso ----------

-- Credita um pacote, bônus ou ajuste na carteira da empresa.
CREATE FUNCTION public.aura_grant_credits(p_workspace_id uuid, p_amount numeric, p_kind text, p_package_id uuid, p_note text, p_actor uuid)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_balance numeric;
BEGIN
  IF p_kind NOT IN ('purchase', 'bonus', 'adjustment') THEN RAISE EXCEPTION 'invalid_kind' USING ERRCODE = '22023'; END IF;
  IF p_kind <> 'adjustment' AND p_amount <= 0 THEN RAISE EXCEPTION 'invalid_amount' USING ERRCODE = '22023'; END IF;
  INSERT INTO public.credit_wallets (workspace_id, balance, last_grant)
  VALUES (p_workspace_id, p_amount, CASE WHEN p_amount > 0 THEN p_amount END)
  ON CONFLICT (workspace_id) DO UPDATE SET
    balance = public.credit_wallets.balance + p_amount,
    last_grant = CASE WHEN p_amount > 0 THEN p_amount ELSE public.credit_wallets.last_grant END,
    low_alerted_at = CASE WHEN p_amount > 0 THEN NULL ELSE public.credit_wallets.low_alerted_at END,
    updated_at = now()
  RETURNING balance INTO v_balance;
  INSERT INTO public.credit_ledger (workspace_id, kind, amount, balance_after, package_id, note, created_by)
  VALUES (p_workspace_id, p_kind, p_amount, v_balance, p_package_id, p_note, p_actor);
  IF v_balance > 0 THEN PERFORM public.aura_resolve_alert('wallet_empty', 'workspace', p_workspace_id::text); END IF;
  RETURN v_balance;
END;
$$;

-- A empresa pode usar IA agora? (carteira com saldo, ou sem bloqueio)
CREATE FUNCTION public.aura_ai_allowed(p_workspace_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT coalesce((SELECT balance > 0 OR NOT hard_stop FROM public.credit_wallets WHERE workspace_id = p_workspace_id), false)
$$;

-- Registra um uso de IA: calcula custo pelo preço do modelo, converte em créditos e desconta da carteira.
CREATE FUNCTION public.aura_record_ai_usage(p_workspace_id uuid, p_conversation_id uuid, p_feature text, p_provider text, p_model text,
  p_input integer, p_cached integer, p_output integer, p_latency_ms integer, p_outcome text, p_error_code text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  mp public.model_prices%ROWTYPE;
  v_cost numeric := 0;
  v_credits numeric := 0;
  v_rate numeric;
  v_id uuid;
  v_app uuid;
  w public.credit_wallets%ROWTYPE;
  v_low_pct numeric;
BEGIN
  SELECT * INTO mp FROM public.model_prices WHERE provider = p_provider AND model = p_model;
  IF mp.model IS NOT NULL THEN
    v_cost := (greatest(coalesce(p_input, 0) - coalesce(p_cached, 0), 0) * mp.input_per_mtok
             + coalesce(p_cached, 0) * mp.cached_input_per_mtok
             + coalesce(p_output, 0) * mp.output_per_mtok) / 1000000.0;
  END IF;
  SELECT (value #>> '{}')::numeric INTO v_rate FROM public.platform_settings WHERE key = 'credits_per_usd';
  -- Teste de chave (ping) e avaliação interna não cobram da empresa.
  v_credits := CASE WHEN p_feature IN ('ping', 'eval') OR p_workspace_id IS NULL THEN 0 ELSE round(v_cost * coalesce(v_rate, 1000), 3) END;
  SELECT app_id INTO v_app FROM public.workspaces WHERE id = p_workspace_id;

  INSERT INTO public.ai_usage (workspace_id, app_id, conversation_id, feature, provider, model, input_tokens, cached_input_tokens,
    output_tokens, cost_usd, credits, latency_ms, outcome, error_code)
  VALUES (p_workspace_id, v_app, p_conversation_id, p_feature, p_provider, p_model, coalesce(p_input, 0), coalesce(p_cached, 0),
    coalesce(p_output, 0), v_cost, v_credits, p_latency_ms, coalesce(p_outcome, 'ok'), p_error_code)
  RETURNING id INTO v_id;

  -- Saldo estimado do provedor (registrado na última recarga).
  UPDATE public.ai_providers SET balance_usd = balance_usd - v_cost WHERE provider = p_provider AND balance_usd IS NOT NULL;

  IF v_credits > 0 THEN
    UPDATE public.credit_wallets SET balance = balance - v_credits, updated_at = now()
    WHERE workspace_id = p_workspace_id RETURNING * INTO w;
    IF w.workspace_id IS NULL THEN
      INSERT INTO public.credit_wallets (workspace_id, balance) VALUES (p_workspace_id, -v_credits) RETURNING * INTO w;
    END IF;
    INSERT INTO public.credit_ledger (workspace_id, kind, amount, balance_after, usage_id)
    VALUES (p_workspace_id, 'usage', -v_credits, w.balance, v_id);

    SELECT (value #>> '{}')::numeric INTO v_low_pct FROM public.platform_settings WHERE key = 'wallet_low_percent';
    IF w.balance <= 0 THEN
      PERFORM public.aura_raise_alert('wallet_empty', 'critical', 'workspace', p_workspace_id::text, p_workspace_id,
        'Créditos de IA esgotados', jsonb_build_object('balance', w.balance));
    ELSIF w.last_grant IS NOT NULL AND w.balance < w.last_grant * coalesce(v_low_pct, 20) / 100 AND w.low_alerted_at IS NULL THEN
      UPDATE public.credit_wallets SET low_alerted_at = now() WHERE workspace_id = p_workspace_id;
      PERFORM public.aura_raise_alert('wallet_low', 'warning', 'workspace', p_workspace_id::text, p_workspace_id,
        'Créditos de IA acabando', jsonb_build_object('balance', w.balance, 'last_grant', w.last_grant));
    END IF;
  END IF;
  RETURN jsonb_build_object('usage_id', v_id, 'cost_usd', v_cost, 'credits', v_credits, 'balance', w.balance);
END;
$$;

-- ---------- Funções: chaves de IA no cofre ----------

CREATE FUNCTION public.aura_set_provider_key(p_provider text, p_key text, p_actor uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF length(coalesce(p_key, '')) < 20 THEN RAISE EXCEPTION 'invalid_key' USING ERRCODE = '22023'; END IF;
  SELECT key_secret_id INTO v_id FROM public.ai_providers WHERE provider = p_provider;
  IF v_id IS NULL THEN
    v_id := vault.create_secret(p_key, 'aura_ai_key_' || p_provider, 'Chave de IA da Aura (' || p_provider || ')');
  ELSE
    PERFORM vault.update_secret(v_id, p_key);
  END IF;
  UPDATE public.ai_providers SET key_secret_id = v_id, key_hint = '…' || right(p_key, 4), status = 'not_configured',
    last_error = NULL, updated_at = now() WHERE provider = p_provider;
  INSERT INTO public.audit_log (actor, action, target_type, target_id) VALUES (p_actor, 'provider_key_set', 'ai_provider', p_provider);
END;
$$;

CREATE FUNCTION public.aura_get_provider_key(p_provider text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT s.decrypted_secret FROM public.ai_providers p JOIN vault.decrypted_secrets s ON s.id = p.key_secret_id
  WHERE p.provider = p_provider
$$;

-- ---------- Saúde: atualizar a partir dos eventos ----------

-- Avisos da Zernio sobre o número (conectado, desconectado, permissões).
CREATE FUNCTION private.handle_account_event(p_event jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_event text := p_event ->> 'event';
  ch public.channels%ROWTYPE;
BEGIN
  SELECT * INTO ch FROM public.channels WHERE provider_account_id = coalesce(p_event #>> '{account,accountId}', p_event #>> '{account,id}');
  IF ch.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'unknown_account'); END IF;
  IF v_event = 'account.disconnected' THEN
    UPDATE public.channels SET status = 'disconnected', health = 'disconnected', health_detail = p_event #>> '{account,reason}',
      health_checked_at = now(), updated_at = now() WHERE id = ch.id;
    PERFORM public.aura_raise_alert('channel_disconnected', 'critical', 'channel', ch.id::text, ch.workspace_id,
      'WhatsApp desconectado', jsonb_build_object('reason', p_event #>> '{account,reason}', 'type', p_event #>> '{account,disconnectionType}'));
  ELSIF v_event = 'account.connected' THEN
    UPDATE public.channels SET status = 'connected', health = 'healthy', health_detail = NULL, health_checked_at = now(), updated_at = now()
    WHERE id = ch.id;
    PERFORM public.aura_resolve_alert('channel_disconnected', 'channel', ch.id::text);
  ELSIF v_event = 'account.permissions_changed' THEN
    UPDATE public.channels SET health = 'warning', health_detail = 'Permissões do número mudaram', health_checked_at = now() WHERE id = ch.id;
    PERFORM public.aura_raise_alert('channel_permissions', 'warning', 'channel', ch.id::text, ch.workspace_id,
      'Permissões do WhatsApp mudaram', p_event -> 'account');
  END IF;
  RETURN jsonb_build_object('ok', true);
END;
$$;

-- Resultado da verificação periódica de saúde do número (feita pela função health-check).
CREATE FUNCTION public.aura_set_channel_health(p_channel_id uuid, p_health text, p_detail text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  ch public.channels%ROWTYPE;
BEGIN
  UPDATE public.channels SET health = p_health, health_detail = p_detail, health_checked_at = now() WHERE id = p_channel_id RETURNING * INTO ch;
  IF ch.id IS NULL THEN RETURN; END IF;
  IF p_health IN ('error', 'disconnected') THEN
    PERFORM public.aura_raise_alert('channel_unhealthy', 'critical', 'channel', ch.id::text, ch.workspace_id, 'Número de WhatsApp com problema',
      jsonb_build_object('detail', p_detail));
  ELSIF p_health = 'healthy' THEN
    PERFORM public.aura_resolve_alert('channel_unhealthy', 'channel', ch.id::text);
  END IF;
END;
$$;

-- Resultado do teste de chave de IA (ping).
CREATE FUNCTION public.aura_set_provider_status(p_provider text, p_ok boolean, p_error text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  p public.ai_providers%ROWTYPE;
BEGIN
  UPDATE public.ai_providers SET status = CASE WHEN p_ok THEN 'ok' ELSE 'error' END, last_check_at = now(),
    last_ok_at = CASE WHEN p_ok THEN now() ELSE last_ok_at END, last_error = CASE WHEN p_ok THEN NULL ELSE left(p_error, 500) END
  WHERE provider = p_provider RETURNING * INTO p;
  IF NOT p_ok AND p.enabled THEN
    PERFORM public.aura_raise_alert('provider_error', 'critical', 'ai_provider', p_provider, NULL, 'Chave de IA com erro', jsonb_build_object('error', p_error));
  ELSIF p_ok THEN
    PERFORM public.aura_resolve_alert('provider_error', 'ai_provider', p_provider);
  END IF;
  IF p.enabled AND p.balance_usd IS NOT NULL AND p.balance_usd < p.low_balance_usd THEN
    PERFORM public.aura_raise_alert('provider_low_balance', 'warning', 'ai_provider', p_provider, NULL, 'Créditos do provedor de IA acabando',
      jsonb_build_object('balance_usd', p.balance_usd, 'recharge_url', p.recharge_url));
  ELSIF p.balance_usd IS NOT NULL AND p.balance_usd >= p.low_balance_usd THEN
    PERFORM public.aura_resolve_alert('provider_low_balance', 'ai_provider', p_provider);
  END IF;
END;
$$;

-- Entrada da Zernio passa a tratar também os avisos de conta e a registrar o último movimento do número.
CREATE OR REPLACE FUNCTION public.aura_ingest_provider_event(p_event jsonb)
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
  IF v_event LIKE 'account.%' THEN
    INSERT INTO private.provider_events (event_id, event) VALUES (v_event_id, v_event) ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows = 0 THEN RETURN jsonb_build_object('ok', true, 'duplicate', true); END IF;
    RETURN private.handle_account_event(p_event);
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

    UPDATE public.channels SET
      last_inbound_at = CASE WHEN v_direction = 'incoming' THEN greatest(coalesce(last_inbound_at, v_at), v_at) ELSE last_inbound_at END,
      last_outbound_at = CASE WHEN v_direction = 'outgoing' THEN greatest(coalesce(last_outbound_at, v_at), v_at) ELSE last_outbound_at END,
      health = CASE WHEN health IN ('unknown', 'disconnected') THEN 'healthy' ELSE health END
    WHERE id = ch.id;

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

    INSERT INTO public.conversations (workspace_id, channel_id, contact_id, provider_conversation_id)
    VALUES (ch.workspace_id, ch.id, v_contact_id, coalesce(v_conv ->> 'id', v_msg ->> 'conversationId'))
    ON CONFLICT (workspace_id, provider_conversation_id) DO UPDATE SET channel_id = EXCLUDED.channel_id
    RETURNING id INTO v_conv_id;

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
    IF v_new_status = 'failed' THEN
      UPDATE public.channels SET last_error_at = now(),
        last_error = left(coalesce(p_event #>> '{error,message}', p_event ->> 'error', 'Falha no envio'), 500) WHERE id = ch.id;
    END IF;
    IF v_msg_id IS NOT NULL THEN
      PERFORM private.enqueue_app_event(ch.workspace_id, 'message.status',
        jsonb_build_object('conversation_id', v_conv_id, 'message', jsonb_build_object('id', v_msg_id, 'status', v_new_status)));
    END IF;
    RETURN jsonb_build_object('ok', true);
  END IF;

  RETURN jsonb_build_object('ok', true, 'ignored', v_event);
END;
$$;

-- Entrega de avisos aos produtos: registra a saúde do produto e alerta quando um aviso desiste.
CREATE OR REPLACE FUNCTION public.aura_finish_app_event(p_id uuid, p_ok boolean, p_error text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  e public.app_events%ROWTYPE;
BEGIN
  SELECT * INTO e FROM public.app_events WHERE id = p_id;
  IF e.id IS NULL THEN RETURN; END IF;
  IF p_ok THEN
    UPDATE public.app_events SET status = 'delivered', delivered_at = now(), last_error = NULL WHERE id = p_id;
    UPDATE public.apps SET last_delivery_ok_at = now() WHERE id = e.app_id;
    PERFORM public.aura_resolve_alert('app_delivery_failing', 'app', e.app_id::text);
    RETURN;
  END IF;
  UPDATE public.apps SET last_delivery_error_at = now(), last_delivery_error = left(p_error, 500) WHERE id = e.app_id;
  IF e.attempts >= 8 THEN
    UPDATE public.app_events SET status = 'failed', last_error = left(p_error, 500) WHERE id = p_id;
  ELSE
    UPDATE public.app_events SET last_error = left(p_error, 500),
      next_attempt_at = now() + (ARRAY[1, 5, 15, 60, 360, 360, 360, 360])[greatest(1, e.attempts)] * interval '1 minute'
    WHERE id = p_id;
  END IF;
  IF e.attempts >= 3 THEN
    PERFORM public.aura_raise_alert('app_delivery_failing', 'critical', 'app', e.app_id::text, NULL,
      'Produto não está recebendo os avisos', jsonb_build_object('error', p_error, 'event_id', p_id));
  END IF;
END;
$$;

-- Reenviar avisos que desistiram (botão no Console).
CREATE FUNCTION public.aura_retry_failed_events(p_app_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_rows integer;
BEGIN
  UPDATE public.app_events SET status = 'pending', attempts = 0, next_attempt_at = now()
  WHERE status = 'failed' AND (p_app_id IS NULL OR app_id = p_app_id);
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END;
$$;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA private FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.aura_raise_alert(text, text, text, text, uuid, text, jsonb), public.aura_resolve_alert(text, text, text),
  public.aura_grant_credits(uuid, numeric, text, uuid, text, uuid), public.aura_ai_allowed(uuid),
  public.aura_record_ai_usage(uuid, uuid, text, text, text, integer, integer, integer, integer, text, text),
  public.aura_set_provider_key(text, text, uuid), public.aura_get_provider_key(text),
  public.aura_set_channel_health(uuid, text, text), public.aura_set_provider_status(text, boolean, text),
  public.aura_retry_failed_events(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.aura_raise_alert(text, text, text, text, uuid, text, jsonb), public.aura_resolve_alert(text, text, text),
  public.aura_grant_credits(uuid, numeric, text, uuid, text, uuid), public.aura_ai_allowed(uuid),
  public.aura_record_ai_usage(uuid, uuid, text, text, text, integer, integer, integer, integer, text, text),
  public.aura_set_provider_key(text, text, uuid), public.aura_get_provider_key(text),
  public.aura_set_channel_health(uuid, text, text), public.aura_set_provider_status(text, boolean, text),
  public.aura_retry_failed_events(uuid) TO service_role;

-- ---------- Produtos (aplicações conectadas) pelo Console ----------

-- Cria o produto e devolve a chave de API e a senha dos avisos UMA vez.
CREATE FUNCTION public.aura_create_app(p_slug text, p_name text, p_webhook_url text, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_key text;
  v_secret text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
BEGIN
  IF EXISTS (SELECT 1 FROM public.apps WHERE slug = p_slug) THEN RAISE EXCEPTION 'slug_in_use' USING ERRCODE = '23505'; END IF;
  v_key := private.create_app_key(p_slug, p_name);
  UPDATE public.apps SET webhook_url = nullif(p_webhook_url, ''), webhook_secret = v_secret WHERE slug = p_slug;
  INSERT INTO public.audit_log (actor, action, target_type, target_id) VALUES (p_actor, 'app_created', 'app', p_slug);
  RETURN jsonb_build_object('api_key', v_key, 'webhook_secret', v_secret);
END;
$$;

-- Nova chave de API (a antiga para de funcionar na hora).
CREATE FUNCTION public.aura_rotate_app_key(p_app_id uuid, p_actor uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  a public.apps%ROWTYPE;
  v_key text;
BEGIN
  SELECT * INTO a FROM public.apps WHERE id = p_app_id;
  IF a.id IS NULL THEN RAISE EXCEPTION 'app_not_found' USING ERRCODE = '22023'; END IF;
  v_key := private.create_app_key(a.slug, a.name);
  INSERT INTO public.audit_log (actor, action, target_type, target_id) VALUES (p_actor, 'app_key_rotated', 'app', a.slug);
  RETURN v_key;
END;
$$;

-- ---------- Números do Console ----------

CREATE FUNCTION public.aura_console_overview()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'apps', (SELECT count(*) FROM public.apps WHERE is_active),
    'workspaces', (SELECT count(*) FROM public.workspaces WHERE status = 'active'),
    'channels_connected', (SELECT count(*) FROM public.channels WHERE status = 'connected'),
    'channels_problem', (SELECT count(*) FROM public.channels WHERE status = 'disconnected' OR health IN ('error', 'disconnected', 'warning')),
    'messages_today', (SELECT count(*) FROM public.messages WHERE sent_at >= date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo'),
    'messages_in_today', (SELECT count(*) FROM public.messages WHERE direction = 'incoming' AND sent_at >= date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo'),
    'ai_cost_month_usd', (SELECT coalesce(sum(cost_usd), 0) FROM public.ai_usage WHERE created_at >= date_trunc('month', now())),
    'ai_credits_month', (SELECT coalesce(sum(credits), 0) FROM public.ai_usage WHERE created_at >= date_trunc('month', now())),
    'ai_calls_month', (SELECT count(*) FROM public.ai_usage WHERE created_at >= date_trunc('month', now()) AND feature NOT IN ('ping')),
    'alerts_open', (SELECT count(*) FROM public.alerts WHERE status = 'open'),
    'alerts_critical', (SELECT count(*) FROM public.alerts WHERE status = 'open' AND severity = 'critical'),
    'events_pending', (SELECT count(*) FROM public.app_events WHERE status = 'pending'),
    'events_failed', (SELECT count(*) FROM public.app_events WHERE status = 'failed'),
    'wallets_empty', (SELECT count(*) FROM public.credit_wallets WHERE balance <= 0)
  )
$$;

-- Uma linha por empresa: produto, número, saúde, movimento, custo de IA do mês e créditos.
CREATE FUNCTION public.aura_console_workspaces()
RETURNS TABLE (
  id uuid, name text, external_id text, status text, created_at timestamptz,
  app_id uuid, app_name text, app_slug text,
  channel_id uuid, channel_status text, health text, health_detail text, phone_number text, display_name text,
  last_inbound_at timestamptz, last_outbound_at timestamptz, last_error text, last_error_at timestamptz,
  conversations integer, messages_month integer,
  ai_cost_month_usd numeric, ai_credits_month numeric, ai_calls_month integer,
  credit_balance numeric, hard_stop boolean, alerts_open integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT w.id, w.name, w.external_id, w.status, w.created_at,
    a.id, a.name, a.slug,
    c.id, coalesce(c.status, 'not_started'), coalesce(c.health, 'unknown'), c.health_detail, c.phone_number, c.display_name,
    c.last_inbound_at, c.last_outbound_at, c.last_error, c.last_error_at,
    (SELECT count(*)::int FROM public.conversations cv WHERE cv.workspace_id = w.id),
    (SELECT count(*)::int FROM public.messages m WHERE m.workspace_id = w.id AND m.sent_at >= date_trunc('month', now())),
    (SELECT coalesce(sum(u.cost_usd), 0) FROM public.ai_usage u WHERE u.workspace_id = w.id AND u.created_at >= date_trunc('month', now())),
    (SELECT coalesce(sum(u.credits), 0) FROM public.ai_usage u WHERE u.workspace_id = w.id AND u.created_at >= date_trunc('month', now())),
    (SELECT count(*)::int FROM public.ai_usage u WHERE u.workspace_id = w.id AND u.created_at >= date_trunc('month', now())),
    cw.balance, coalesce(cw.hard_stop, true),
    (SELECT count(*)::int FROM public.alerts al WHERE al.workspace_id = w.id AND al.status = 'open')
  FROM public.workspaces w
  JOIN public.apps a ON a.id = w.app_id
  LEFT JOIN public.channels c ON c.workspace_id = w.id
  LEFT JOIN public.credit_wallets cw ON cw.workspace_id = w.id
  ORDER BY w.name
$$;

-- Uso de IA por dia (últimos N dias), geral ou de uma empresa.
CREATE FUNCTION public.aura_console_usage_daily(p_workspace_id uuid, p_days integer DEFAULT 30)
RETURNS TABLE (day date, calls integer, cost_usd numeric, credits numeric, input_tokens bigint, output_tokens bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT d::date, count(u.id)::int, coalesce(sum(u.cost_usd), 0), coalesce(sum(u.credits), 0),
    coalesce(sum(u.input_tokens), 0), coalesce(sum(u.output_tokens), 0)
  FROM generate_series((now() AT TIME ZONE 'America/Sao_Paulo')::date - (greatest(p_days, 1) - 1), (now() AT TIME ZONE 'America/Sao_Paulo')::date, interval '1 day') d
  LEFT JOIN public.ai_usage u ON (u.created_at AT TIME ZONE 'America/Sao_Paulo')::date = d::date
    AND u.feature <> 'ping' AND (p_workspace_id IS NULL OR u.workspace_id = p_workspace_id)
  GROUP BY d ORDER BY d
$$;

-- ---------- Despertador (verificações automáticas) ----------

-- Senha que o agendador usa para chamar as funções de verificação. Gerada aqui e guardada no cofre.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'aura_cron_secret') THEN
    PERFORM vault.create_secret(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'aura_cron_secret', 'Senha do agendador da Aura IA');
  END IF;
END;
$$;

CREATE FUNCTION public.aura_cron_secret_ok(p_secret text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(p_secret, '') <> '' AND EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'aura_cron_secret' AND decrypted_secret = p_secret)
$$;

REVOKE EXECUTE ON FUNCTION public.aura_create_app(text, text, text, uuid), public.aura_rotate_app_key(uuid, uuid),
  public.aura_console_overview(), public.aura_console_workspaces(), public.aura_console_usage_daily(uuid, integer),
  public.aura_cron_secret_ok(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.aura_create_app(text, text, text, uuid), public.aura_rotate_app_key(uuid, uuid),
  public.aura_console_overview(), public.aura_console_workspaces(), public.aura_console_usage_daily(uuid, integer),
  public.aura_cron_secret_ok(text) TO service_role;
