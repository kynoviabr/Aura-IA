-- Aura IA · Fase 2 (copiloto): "Sugerir resposta".
-- A IA lê a conversa, pergunta ao produto o catálogo e os dados da empresa (API padrão) e sugere a próxima mensagem.
-- Quem envia é sempre uma pessoa da empresa, revisando a sugestão.

-- Endereço da API padrão do produto (ex.: https://<projeto>.supabase.co/functions/v1/aura-api).
ALTER TABLE public.apps ADD COLUMN api_base_url text;

-- Modelo usado pelo copiloto (trocável no Console).
INSERT INTO public.platform_settings (key, value) VALUES
  ('copilot_model', '{"provider": "anthropic", "model": "claude-haiku-5-5"}')
ON CONFLICT (key) DO NOTHING;

-- Cada sugestão feita, para medir se a equipe usa, edita ou descarta.
CREATE TABLE public.ai_suggestions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  usage_id uuid REFERENCES public.ai_usage(id) ON DELETE SET NULL,
  provider text NOT NULL,
  model text NOT NULL,
  suggestion text NOT NULL DEFAULT '',
  -- Avisos de segurança (ex.: assunto de saúde, número sem fonte) e se deve passar para uma pessoa.
  flags text[] NOT NULL DEFAULT '{}',
  handoff boolean NOT NULL DEFAULT false,
  -- Quais dados o produto respondeu (catalog, business_info) e quais falharam.
  context_sources jsonb NOT NULL DEFAULT '{}',
  outcome text NOT NULL DEFAULT 'ok' CHECK (outcome IN ('ok', 'error', 'refused', 'blocked')),
  status text NOT NULL DEFAULT 'suggested' CHECK (status IN ('suggested', 'sent', 'sent_edited')),
  sent_message_id uuid REFERENCES public.messages(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  used_at timestamptz
);
CREATE INDEX ai_suggestions_conversation_idx ON public.ai_suggestions (conversation_id, created_at DESC);
CREATE INDEX ai_suggestions_workspace_idx ON public.ai_suggestions (workspace_id, created_at DESC);
ALTER TABLE public.ai_suggestions ENABLE ROW LEVEL SECURITY;

-- Marca a sugestão como usada quando a mensagem sai (igual ou editada).
CREATE FUNCTION public.aura_mark_suggestion_used(p_suggestion_id uuid, p_conversation_id uuid, p_message_id uuid, p_sent_text text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE public.ai_suggestions
  SET status = CASE WHEN btrim(suggestion) = btrim(p_sent_text) THEN 'sent' ELSE 'sent_edited' END,
      sent_message_id = p_message_id, used_at = now()
  WHERE id = p_suggestion_id AND conversation_id = p_conversation_id AND status = 'suggested';
$$;

REVOKE ALL ON FUNCTION public.aura_mark_suggestion_used(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.aura_mark_suggestion_used(uuid, uuid, uuid, text) TO service_role;
