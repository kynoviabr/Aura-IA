-- Aura IA · Fases 3 e 4: atendimento automático com agenda.
-- Cada empresa escolhe o modo da IA: desligada, copiloto (sugere) ou automático (responde sozinha).
-- No automático a IA consulta horários e marca pela API padrão do produto, sempre confirmando com o cliente.
-- Uma pessoa da empresa pode assumir a conversa a qualquer momento: a IA pausa naquela conversa.

ALTER TABLE public.workspaces ADD COLUMN ai_mode text NOT NULL DEFAULT 'copilot' CHECK (ai_mode IN ('off', 'copilot', 'auto'));

ALTER TABLE public.conversations
  ADD COLUMN ai_paused_until timestamptz,
  ADD COLUMN ai_pause_reason text,
  -- Trava para não responder duas vezes ao mesmo tempo na mesma conversa.
  ADD COLUMN ai_busy_until timestamptz;

-- Modelo do atendimento automático (trocável no Console).
INSERT INTO public.platform_settings (key, value) VALUES
  ('auto_model', '{"provider": "anthropic", "model": "claude-sonnet-5-5"}')
ON CONFLICT (key) DO NOTHING;

-- Cada resposta automática: o que a IA consultou/fez e o que enviou (para a equipe acompanhar no Console).
CREATE TABLE public.ai_turns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  usage_id uuid REFERENCES public.ai_usage(id) ON DELETE SET NULL,
  provider text NOT NULL,
  model text NOT NULL,
  -- Ferramentas usadas: [{ name, input, ok, summary }]
  tools jsonb NOT NULL DEFAULT '[]',
  draft text,
  sent_text text,
  sent_message_id uuid REFERENCES public.messages(id) ON DELETE SET NULL,
  flags text[] NOT NULL DEFAULT '{}',
  -- sent: enviou a resposta da IA; fallback: enviou mensagem segura e passou para a equipe; skipped/error: não enviou.
  outcome text NOT NULL CHECK (outcome IN ('sent', 'fallback', 'skipped', 'error')),
  handoff boolean NOT NULL DEFAULT false,
  booking_id text,
  error text,
  latency_ms integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_turns_conversation_idx ON public.ai_turns (conversation_id, created_at DESC);
CREATE INDEX ai_turns_workspace_idx ON public.ai_turns (workspace_id, created_at DESC);
ALTER TABLE public.ai_turns ENABLE ROW LEVEL SECURITY;

-- Pega a vez de responder nesta conversa (por até 3 minutos). Devolve false se já há uma resposta em andamento.
CREATE FUNCTION public.aura_claim_ai_turn(p_conversation_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_rows integer;
BEGIN
  UPDATE public.conversations SET ai_busy_until = now() + interval '3 minutes'
  WHERE id = p_conversation_id AND (ai_busy_until IS NULL OR ai_busy_until < now());
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END;
$$;

CREATE FUNCTION public.aura_release_ai_turn(p_conversation_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE public.conversations SET ai_busy_until = NULL WHERE id = p_conversation_id;
$$;

-- Mensagem enviada pela IA: grava como "ai" e avisa o produto (o eco da Zernio não gera aviso).
CREATE FUNCTION public.aura_record_ai_message(p_conversation_id uuid, p_provider_message_id text, p_body text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  c public.conversations%ROWTYPE;
  v_id uuid;
BEGIN
  v_id := public.aura_record_outgoing(p_conversation_id, p_provider_message_id, p_body, 'ai', 'aura-ia');
  SELECT * INTO c FROM public.conversations WHERE id = p_conversation_id;
  PERFORM private.enqueue_app_event(c.workspace_id, 'message.sent', jsonb_build_object(
    'conversation_id', c.id,
    'contact', private.contact_json(c.contact_id),
    'message', jsonb_build_object('id', v_id, 'direction', 'outgoing', 'source', 'ai', 'body', p_body,
      'attachments', '[]'::jsonb, 'sent_at', now())));
  RETURN v_id;
END;
$$;

-- Pausa a IA numa conversa (pessoa assumiu ou a IA pediu ajuda). Pedido de ajuda avisa o produto.
CREATE FUNCTION public.aura_pause_ai(p_conversation_id uuid, p_hours integer, p_reason text, p_notify boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE c public.conversations%ROWTYPE;
BEGIN
  UPDATE public.conversations
  SET ai_paused_until = CASE WHEN p_hours > 0 THEN now() + make_interval(hours => p_hours) ELSE NULL END,
      ai_pause_reason = CASE WHEN p_hours > 0 THEN left(p_reason, 300) ELSE NULL END
  WHERE id = p_conversation_id
  RETURNING * INTO c;
  IF p_notify AND c.id IS NOT NULL THEN
    PERFORM private.enqueue_app_event(c.workspace_id, 'conversation.handoff_requested', jsonb_build_object(
      'conversation_id', c.id, 'contact', private.contact_json(c.contact_id), 'reason', left(p_reason, 300)));
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.aura_claim_ai_turn(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.aura_release_ai_turn(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.aura_record_ai_message(uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.aura_pause_ai(uuid, integer, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.aura_claim_ai_turn(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.aura_release_ai_turn(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.aura_record_ai_message(uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.aura_pause_ai(uuid, integer, text, boolean) TO service_role;
