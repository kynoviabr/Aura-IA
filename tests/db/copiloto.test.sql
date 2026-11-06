\set ON_ERROR_STOP on
BEGIN;
CREATE FUNCTION pg_temp.ok(v boolean, msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF v IS DISTINCT FROM true THEN RAISE EXCEPTION 'ASSERT: %', msg; END IF; RAISE NOTICE 'PASS: %', msg; END $$;

SELECT private.create_app_key('clinova', 'Clinova');
INSERT INTO public.workspaces (id, app_id, external_id, name) SELECT '00000000-0000-0000-0000-0000000000c1', id, 'clinic-1', 'Clínica Bella' FROM public.apps;
INSERT INTO public.contacts (id, workspace_id, phone, phone_key) VALUES ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000c1', '5511999990000', '11999990000');
INSERT INTO public.conversations (id, workspace_id, contact_id, provider_conversation_id)
VALUES ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000e1', 'zc-1');

SELECT pg_temp.ok((SELECT value ->> 'model' = 'claude-haiku-5-5' FROM public.platform_settings WHERE key = 'copilot_model'), 'default copilot model');

INSERT INTO public.ai_suggestions (id, workspace_id, conversation_id, provider, model, suggestion) VALUES
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000f1', 'anthropic', 'claude-haiku-5-5', 'A limpeza custa R$ 180.'),
  ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000f1', 'anthropic', 'claude-haiku-5-5', 'Temos horário amanhã.');

SELECT public.aura_mark_suggestion_used('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000f1',
  public.aura_record_outgoing('00000000-0000-0000-0000-0000000000f1', 'w1', 'A limpeza custa R$ 180. ', 'human', 'u'), 'A limpeza custa R$ 180. ');
SELECT pg_temp.ok((SELECT status = 'sent' AND sent_message_id IS NOT NULL FROM public.ai_suggestions WHERE id = '00000000-0000-0000-0000-0000000000a1'), 'suggestion sent as is');

SELECT public.aura_mark_suggestion_used('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000f1', NULL, 'Vou verificar a agenda e já te falo.');
SELECT pg_temp.ok((SELECT status = 'sent_edited' FROM public.ai_suggestions WHERE id = '00000000-0000-0000-0000-0000000000a2'), 'suggestion sent edited');

-- Outra conversa não marca a sugestão
UPDATE public.ai_suggestions SET status = 'suggested' WHERE id = '00000000-0000-0000-0000-0000000000a2';
SELECT public.aura_mark_suggestion_used('00000000-0000-0000-0000-0000000000a2', gen_random_uuid(), NULL, 'x');
SELECT pg_temp.ok((SELECT status = 'suggested' FROM public.ai_suggestions WHERE id = '00000000-0000-0000-0000-0000000000a2'), 'other conversation cannot mark');

SET LOCAL ROLE anon;
SELECT pg_temp.ok((SELECT count(*) = 0 FROM public.ai_suggestions), 'anon cannot read suggestions');
RESET ROLE;
ROLLBACK;
