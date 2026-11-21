-- Aura IA · MM-0: mídia recebida no WhatsApp (docs/ROADMAP_MENSAGERIA_MULTIMODAL.md §5).
-- A Meta apaga a mídia recebida depois de um prazo, então cada anexo é baixado logo que a mensagem chega
-- e guardado num bucket privado, por um tempo curto. Desligado por padrão em cada empresa.
-- Nada aqui é lido pelo produto, pelo Console ou pela IA: só as funções de servidor (service_role).

ALTER TABLE public.workspaces ADD COLUMN media_channel_enabled boolean NOT NULL DEFAULT false;

-- Limites (trocáveis sem deploy). retention_days = por quanto tempo o arquivo fica no Storage.
INSERT INTO public.platform_settings (key, value) VALUES
  ('media_limits', '{"max_mb": {"image": 5, "video": 16, "audio": 16, "document": 25}, "timeout_ms": 20000, "max_attempts": 4, "retention_days": 7}')
ON CONFLICT (key) DO NOTHING;

-- Permite chaves estrangeiras que conferem a empresa (um anexo nunca aponta para mensagem de outra empresa).
ALTER TABLE public.messages ADD CONSTRAINT messages_id_workspace_key UNIQUE (id, workspace_id);
ALTER TABLE public.conversations ADD CONSTRAINT conversations_id_workspace_key UNIQUE (id, workspace_id);

-- Um registro por anexo recebido. O JSON em messages.attachments continua igual (compatibilidade).
CREATE TABLE public.message_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,
  message_id uuid NOT NULL,
  attachment_index smallint NOT NULL CHECK (attachment_index >= 0),
  provider text NOT NULL DEFAULT 'zernio',
  provider_type text NOT NULL,
  -- Id do arquivo no provedor (nunca a URL nem a chave).
  provider_attachment_id text,
  kind text CHECK (kind IN ('audio', 'image', 'video', 'document')),
  voice boolean NOT NULL DEFAULT false,
  declared_mime_type text,
  file_name text,
  -- Preenchidos depois do download e da validação pelos bytes.
  mime_type text,
  detected_format text,
  size_bytes bigint,
  sha256 text,
  storage_path text,
  processing_status text NOT NULL DEFAULT 'pending'
    CHECK (processing_status IN ('pending', 'processing', 'processed', 'failed', 'unsupported')),
  error_code text,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  claimed_until timestamptz,
  delete_after timestamptz,
  purged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE (message_id, attachment_index),
  FOREIGN KEY (message_id, workspace_id) REFERENCES public.messages(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (conversation_id, workspace_id) REFERENCES public.conversations(id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX message_attachments_due_idx ON public.message_attachments (next_attempt_at) WHERE processing_status IN ('pending', 'processing');
CREATE INDEX message_attachments_purge_idx ON public.message_attachments (delete_after) WHERE storage_path IS NOT NULL;
CREATE INDEX message_attachments_message_idx ON public.message_attachments (message_id);
ALTER TABLE public.message_attachments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.message_attachments FROM PUBLIC, anon, authenticated;

-- Bucket privado (sem políticas: só o servidor lê e grava). Caminho: <empresa>/<conversa>/<anexo>.<formato>.
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('inbound-media', 'inbound-media', false, 26214400)
ON CONFLICT (id) DO NOTHING;

CREATE FUNCTION private.media_setting(p_key text, p_default numeric)
RETURNS numeric
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT coalesce((SELECT (value ->> p_key)::numeric FROM public.platform_settings WHERE key = 'media_limits'), p_default)
$$;

-- Registra os anexos de uma mensagem recebida (já normalizados pelo adaptador do provedor).
-- p_attachments: [{ index, kind, providerType, providerAttachmentId, mimeType, fileName, voice }]
-- Devolve os ids que devem ser baixados agora. Empresa com mídia desligada: não registra nada.
CREATE FUNCTION public.aura_register_attachments(p_account_id text, p_provider_message_id text, p_attachments jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  m public.messages%ROWTYPE;
  a jsonb;
  v_kind text;
  v_ref text;
  v_status text;
  v_id uuid;
  v_pending uuid[] := '{}';
BEGIN
  SELECT msg.* INTO m
  FROM public.channels ch
  JOIN public.workspaces w ON w.id = ch.workspace_id
  JOIN public.messages msg ON msg.workspace_id = ch.workspace_id AND msg.provider_message_id = p_provider_message_id
  WHERE ch.provider_account_id = p_account_id AND w.media_channel_enabled AND msg.direction = 'incoming';
  IF m.id IS NULL THEN RETURN jsonb_build_object('ok', true, 'registered', false, 'pending', '[]'::jsonb); END IF;

  FOR a IN SELECT * FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_attachments) = 'array' THEN p_attachments ELSE '[]'::jsonb END) LOOP
    v_kind := CASE WHEN a ->> 'kind' IN ('audio', 'image', 'video', 'document') THEN a ->> 'kind' END;
    v_ref := nullif(left(a ->> 'providerAttachmentId', 200), '');
    v_status := CASE WHEN v_kind IS NULL THEN 'unsupported' WHEN v_ref IS NULL THEN 'failed' ELSE 'pending' END;
    INSERT INTO public.message_attachments (workspace_id, conversation_id, message_id, attachment_index, provider_type,
      provider_attachment_id, kind, voice, declared_mime_type, file_name, processing_status, error_code)
    VALUES (m.workspace_id, m.conversation_id, m.id, (a ->> 'index')::smallint, left(coalesce(a ->> 'providerType', 'unknown'), 40),
      v_ref, v_kind, coalesce((a ->> 'voice')::boolean, false), left(a ->> 'mimeType', 120), left(a ->> 'fileName', 200),
      v_status, CASE WHEN v_status = 'failed' THEN 'media_reference_invalid' END)
    ON CONFLICT (message_id, attachment_index) DO NOTHING
    RETURNING id INTO v_id;
    IF v_id IS NOT NULL AND v_status = 'pending' THEN v_pending := v_pending || v_id; END IF;
    v_id := NULL;
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'registered', true, 'pending', to_jsonb(v_pending));
END;
$$;

-- Pega anexos para baixar: os ids pedidos (download imediato) ou os que estão na hora (nova tentativa).
-- Download travado há mais de 5 min volta a ser elegível; quem passou do limite de tentativas vira falha.
CREATE FUNCTION public.aura_claim_attachments(p_ids uuid[], p_limit integer)
RETURNS TABLE (id uuid, workspace_id uuid, conversation_id uuid, kind text, provider text,
  provider_attachment_id text, declared_mime_type text, attempts integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE v_max integer := private.media_setting('max_attempts', 4)::integer;
BEGIN
  UPDATE public.message_attachments t
  SET processing_status = 'failed', error_code = coalesce(t.error_code, 'media_download_timeout'), claimed_until = NULL
  WHERE t.processing_status IN ('pending', 'processing') AND t.attempts >= v_max
    AND (t.processing_status = 'pending' OR t.claimed_until < now());

  RETURN QUERY
  UPDATE public.message_attachments t
  SET processing_status = 'processing', attempts = t.attempts + 1, claimed_until = now() + interval '5 minutes'
  WHERE t.id IN (
    SELECT x.id FROM public.message_attachments x
    WHERE x.attempts < v_max
      AND ((x.processing_status = 'pending' AND (p_ids IS NOT NULL OR x.next_attempt_at <= now()))
        OR (x.processing_status = 'processing' AND x.claimed_until < now()))
      AND (p_ids IS NULL OR x.id = ANY (p_ids))
    ORDER BY x.next_attempt_at
    LIMIT greatest(least(coalesce(p_limit, 10), 50), 1)
    FOR UPDATE SKIP LOCKED)
  RETURNING t.id, t.workspace_id, t.conversation_id, t.kind, t.provider, t.provider_attachment_id, t.declared_mime_type, t.attempts;
END;
$$;

-- Resultado do download. p_result: { ok, mimeType, format, sizeBytes, sha256, storagePath } ou { ok: false, code, retry }.
-- Falha temporária volta para a fila (1, 5, 30 min); as outras são definitivas.
CREATE FUNCTION public.aura_finish_attachment(p_id uuid, p_result jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_max integer := private.media_setting('max_attempts', 4)::integer;
  v_days numeric := private.media_setting('retention_days', 7);
BEGIN
  IF coalesce((p_result ->> 'ok')::boolean, false) THEN
    UPDATE public.message_attachments SET
      processing_status = 'processed', error_code = NULL, claimed_until = NULL, processed_at = now(),
      mime_type = left(p_result ->> 'mimeType', 120), detected_format = left(p_result ->> 'format', 20),
      size_bytes = (p_result ->> 'sizeBytes')::bigint, sha256 = left(p_result ->> 'sha256', 64),
      storage_path = left(p_result ->> 'storagePath', 300), delete_after = now() + make_interval(days => v_days::integer)
    WHERE id = p_id AND processing_status = 'processing';
  ELSE
    UPDATE public.message_attachments SET
      error_code = left(coalesce(p_result ->> 'code', 'media_provider_error'), 40), claimed_until = NULL,
      processing_status = CASE WHEN coalesce((p_result ->> 'retry')::boolean, false) AND attempts < v_max THEN 'pending' ELSE 'failed' END,
      next_attempt_at = now() + CASE attempts WHEN 1 THEN interval '1 minute' WHEN 2 THEN interval '5 minutes' ELSE interval '30 minutes' END
    WHERE id = p_id AND processing_status = 'processing';
  END IF;
END;
$$;

-- Arquivos que passaram do prazo de guarda: o servidor apaga do Storage e depois marca aqui.
CREATE FUNCTION public.aura_attachments_to_purge(p_limit integer)
RETURNS TABLE (id uuid, storage_path text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT t.id, t.storage_path FROM public.message_attachments t
  WHERE t.storage_path IS NOT NULL AND t.delete_after <= now()
  ORDER BY t.delete_after
  LIMIT greatest(least(coalesce(p_limit, 50), 200), 1)
$$;

CREATE FUNCTION public.aura_mark_attachments_purged(p_ids uuid[])
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_rows integer;
BEGIN
  UPDATE public.message_attachments SET storage_path = NULL, purged_at = now()
  WHERE id = ANY (p_ids) AND storage_path IS NOT NULL AND delete_after <= now();
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END;
$$;

REVOKE ALL ON FUNCTION private.media_setting(text, numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aura_register_attachments(text, text, jsonb), public.aura_claim_attachments(uuid[], integer),
  public.aura_finish_attachment(uuid, jsonb), public.aura_attachments_to_purge(integer), public.aura_mark_attachments_purged(uuid[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.aura_register_attachments(text, text, jsonb), public.aura_claim_attachments(uuid[], integer),
  public.aura_finish_attachment(uuid, jsonb), public.aura_attachments_to_purge(integer), public.aura_mark_attachments_purged(uuid[])
  TO service_role;
