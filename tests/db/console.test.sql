\set ON_ERROR_STOP on
BEGIN;
CREATE FUNCTION pg_temp.ok(v boolean, msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF v IS DISTINCT FROM true THEN RAISE EXCEPTION 'ASSERT: %', msg; END IF; RAISE NOTICE 'PASS: %', msg; END $$;

SELECT private.create_app_key('clinova', 'Clinova');
UPDATE public.apps SET webhook_url = 'https://clinova.example/aura', webhook_secret = 's';
INSERT INTO public.workspaces (id, app_id, external_id, name) SELECT '00000000-0000-0000-0000-0000000000c1', id, 'clinic-1', 'Clínica Bella' FROM public.apps;
INSERT INTO public.channels (id, workspace_id, provider_account_id, status) VALUES ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c1', 'acc-1', 'connected');

-- Créditos
SELECT pg_temp.ok(NOT public.aura_ai_allowed('00000000-0000-0000-0000-0000000000c1'), 'no wallet = AI blocked');
SELECT pg_temp.ok(public.aura_grant_credits('00000000-0000-0000-0000-0000000000c1', 1000, 'purchase', NULL, 'Pacote inicial', NULL) = 1000, 'credits granted');
SELECT pg_temp.ok(public.aura_ai_allowed('00000000-0000-0000-0000-0000000000c1'), 'AI allowed with balance');

-- Uso: Haiku, 3000 entrada (1000 em cache), 300 saída => (2000*0.10 + 1000*0.01 + 300*0.50)/1e6 = 0.00036 US$ = 0.36 crédito
SELECT pg_temp.ok((SELECT (r ->> 'cost_usd')::numeric = 0.00036 AND (r ->> 'credits')::numeric = 0.36
  FROM (SELECT public.aura_record_ai_usage('00000000-0000-0000-0000-0000000000c1', NULL, 'copilot', 'anthropic', 'claude-haiku-5-5', 3000, 1000, 300, 900, 'ok', NULL) r) t), 'cost and credits computed');
SELECT pg_temp.ok((SELECT balance = 999.64 FROM public.credit_wallets), 'wallet debited');
SELECT pg_temp.ok((SELECT count(*) = 2 FROM public.credit_ledger), 'ledger has purchase and usage');
SELECT pg_temp.ok((SELECT (r ->> 'credits')::numeric = 0 FROM (SELECT public.aura_record_ai_usage(NULL, NULL, 'ping', 'anthropic', 'claude-haiku-5-5', 10, 0, 1, 100, 'ok', NULL) r) t), 'ping is free for clients');

-- Crédito acabando e esgotado
UPDATE public.platform_settings SET value = '1000000' WHERE key = 'credits_per_usd'; -- encarece para testar
SELECT public.aura_record_ai_usage('00000000-0000-0000-0000-0000000000c1', NULL, 'copilot', 'anthropic', 'claude-haiku-5-5', 3000, 0, 1000, 900, 'ok', NULL); -- 800 créditos
SELECT pg_temp.ok((SELECT count(*) = 1 FROM public.alerts WHERE kind = 'wallet_low' AND status = 'open'), 'low credit alert');
SELECT public.aura_record_ai_usage('00000000-0000-0000-0000-0000000000c1', NULL, 'copilot', 'anthropic', 'claude-haiku-5-5', 3000, 0, 1000, 900, 'ok', NULL);
SELECT pg_temp.ok((SELECT count(*) = 1 FROM public.alerts WHERE kind = 'wallet_empty' AND status = 'open' AND severity = 'critical'), 'empty credit alert');
SELECT pg_temp.ok(NOT public.aura_ai_allowed('00000000-0000-0000-0000-0000000000c1'), 'AI blocked when empty');
UPDATE public.credit_wallets SET hard_stop = false;
SELECT pg_temp.ok(public.aura_ai_allowed('00000000-0000-0000-0000-0000000000c1'), 'no hard stop lets it run negative');
SELECT public.aura_grant_credits('00000000-0000-0000-0000-0000000000c1', 5000, 'purchase', NULL, NULL, NULL);
SELECT pg_temp.ok((SELECT status = 'resolved' FROM public.alerts WHERE kind = 'wallet_empty'), 'recharge resolves empty alert');

-- Chave de IA no cofre
SELECT public.aura_set_provider_key('anthropic', 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz-1234', NULL);
SELECT pg_temp.ok((SELECT key_hint = '…1234' AND key_secret_id IS NOT NULL FROM public.ai_providers WHERE provider = 'anthropic'), 'key stored with hint only');
SELECT pg_temp.ok(public.aura_get_provider_key('anthropic') = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz-1234', 'key readable by server');
SELECT public.aura_set_provider_key('anthropic', 'sk-ant-api03-zzzzzzzzzzzzzzzzzzzzzzzzzz-9999', NULL);
SELECT pg_temp.ok((SELECT count(*) = 1 FROM vault.secrets) AND public.aura_get_provider_key('anthropic') LIKE '%9999', 'key replaced, not duplicated');
UPDATE public.ai_providers SET enabled = true, balance_usd = 5 WHERE provider = 'anthropic';
SELECT public.aura_set_provider_status('anthropic', false, 'invalid x-api-key');
SELECT pg_temp.ok((SELECT count(*) = 1 FROM public.alerts WHERE kind = 'provider_error' AND status = 'open'), 'provider error alert');
SELECT pg_temp.ok((SELECT count(*) = 1 FROM public.alerts WHERE kind = 'provider_low_balance'), 'provider low balance alert');
SELECT public.aura_set_provider_status('anthropic', true, NULL);
SELECT pg_temp.ok((SELECT status = 'resolved' FROM public.alerts WHERE kind = 'provider_error'), 'provider ok resolves');

-- Saúde do número pelos avisos da Zernio
SELECT public.aura_ingest_provider_event('{"id":"z1","event":"account.disconnected","account":{"accountId":"acc-1","reason":"Token expirado","disconnectionType":"unintentional"}}');
SELECT pg_temp.ok((SELECT status = 'disconnected' AND health = 'disconnected' FROM public.channels), 'disconnect marks channel');
SELECT pg_temp.ok((SELECT title = 'WhatsApp desconectado' AND workspace_id IS NOT NULL FROM public.alerts WHERE kind = 'channel_disconnected'), 'disconnect alert');
SELECT public.aura_ingest_provider_event('{"id":"z1","event":"account.disconnected","account":{"accountId":"acc-1"}}');
SELECT pg_temp.ok((SELECT occurrences = 1 FROM public.alerts WHERE kind = 'channel_disconnected'), 'duplicate event ignored');
SELECT public.aura_ingest_provider_event('{"id":"z2","event":"account.connected","account":{"accountId":"acc-1"}}');
SELECT pg_temp.ok((SELECT status = 'connected' AND health = 'healthy' FROM public.channels), 'reconnect heals channel');
SELECT pg_temp.ok((SELECT status = 'resolved' FROM public.alerts WHERE kind = 'channel_disconnected'), 'reconnect resolves alert');
SELECT public.aura_ingest_provider_event('{"id":"z3","event":"message.received","account":{"accountId":"acc-1"},"conversation":{"id":"c1","participantId":"5511950210668"},
 "message":{"platform":"whatsapp","platformMessageId":"w1","direction":"incoming","text":"oi","attachments":[],"sentAt":"2026-11-08T10:00:00Z"}}');
SELECT pg_temp.ok((SELECT last_inbound_at = '2026-11-08T10:00:00Z' FROM public.channels), 'last inbound tracked');

-- Produto que não recebe os avisos
UPDATE public.app_events SET attempts = 3 WHERE type = 'message.received';
SELECT public.aura_finish_app_event(id, false, 'HTTP 500') FROM public.app_events WHERE type = 'message.received';
SELECT pg_temp.ok((SELECT count(*) = 1 FROM public.alerts WHERE kind = 'app_delivery_failing' AND status = 'open'), 'app delivery alert');
SELECT pg_temp.ok((SELECT last_delivery_error = 'HTTP 500' FROM public.apps), 'app last error tracked');
UPDATE public.app_events SET status = 'failed';
SELECT pg_temp.ok(public.aura_retry_failed_events(NULL) >= 1, 'retry failed events');
SELECT public.aura_finish_app_event(id, true) FROM public.app_events WHERE type = 'message.received';
SELECT pg_temp.ok((SELECT status = 'resolved' FROM public.alerts WHERE kind = 'app_delivery_failing'), 'delivery ok resolves');

SET LOCAL ROLE anon;
DO $$ BEGIN PERFORM public.aura_get_provider_key('anthropic'); RAISE EXCEPTION 'ASSERT: anon key';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS: anon cannot read AI keys'; END $$;
DO $$ BEGIN PERFORM 1 FROM public.ai_usage; RAISE EXCEPTION 'ASSERT: anon usage';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS: anon cannot read usage'; END $$;
RESET ROLE;
ROLLBACK;
