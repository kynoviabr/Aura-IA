\set ON_ERROR_STOP on
BEGIN;
CREATE FUNCTION pg_temp.ok(v boolean, msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF v IS DISTINCT FROM true THEN RAISE EXCEPTION 'ASSERT: %', msg; END IF; RAISE NOTICE 'PASS: %', msg; END $$;

SELECT private.create_app_key('clinova', 'Clinova');
UPDATE public.apps SET webhook_url = 'https://clinova.example/aura', webhook_secret = 's';
INSERT INTO public.workspaces (id, app_id, external_id, name) SELECT '00000000-0000-0000-0000-0000000000c1', id, 'clinic-1', 'Clínica Bella' FROM public.apps;
INSERT INTO public.contacts (id, workspace_id, phone, phone_key) VALUES ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000c1', '5511999990000', '11999990000');
INSERT INTO public.conversations (id, workspace_id, contact_id, provider_conversation_id)
VALUES ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000e1', 'zc-1');

SELECT pg_temp.ok((SELECT ai_mode = 'copilot' FROM public.workspaces), 'default mode is copilot');
SELECT pg_temp.ok((SELECT value ->> 'model' = 'claude-sonnet-5-5' FROM public.platform_settings WHERE key = 'auto_model'), 'default auto model');

-- Vez de responder
SELECT pg_temp.ok(public.aura_claim_ai_turn('00000000-0000-0000-0000-0000000000f1'), 'first claim wins');
SELECT pg_temp.ok(NOT public.aura_claim_ai_turn('00000000-0000-0000-0000-0000000000f1'), 'second claim waits');
SELECT public.aura_release_ai_turn('00000000-0000-0000-0000-0000000000f1');
SELECT pg_temp.ok(public.aura_claim_ai_turn('00000000-0000-0000-0000-0000000000f1'), 'claim again after release');

-- Mensagem da IA vira aviso para o produto
SELECT public.aura_record_ai_message('00000000-0000-0000-0000-0000000000f1', 'wamid-ai', 'Temos segunda às 14h.');
SELECT pg_temp.ok((SELECT source = 'ai' FROM public.messages WHERE provider_message_id = 'wamid-ai'), 'ai message stored as ai');
SELECT pg_temp.ok((SELECT count(*) = 1 FROM public.app_events WHERE type = 'message.sent' AND payload #>> '{message,source}' = 'ai'), 'product notified of ai message');

-- Pausa e pedido de ajuda
SELECT public.aura_pause_ai('00000000-0000-0000-0000-0000000000f1', 24, 'Reclamação', true);
SELECT pg_temp.ok((SELECT ai_paused_until > now() + interval '23 hours' AND ai_pause_reason = 'Reclamação' FROM public.conversations), 'paused 24h');
SELECT pg_temp.ok((SELECT count(*) = 1 FROM public.app_events WHERE type = 'conversation.handoff_requested'), 'handoff event');
SELECT public.aura_pause_ai('00000000-0000-0000-0000-0000000000f1', 0, 'x', false);
SELECT pg_temp.ok((SELECT ai_paused_until IS NULL FROM public.conversations), 'resume clears pause');

SET LOCAL ROLE anon;
SELECT pg_temp.ok((SELECT count(*) = 0 FROM public.ai_turns), 'anon cannot read turns');
RESET ROLE;
ROLLBACK;
