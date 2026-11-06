\set ON_ERROR_STOP on
BEGIN;
CREATE FUNCTION pg_temp.ok(v boolean, msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF v IS DISTINCT FROM true THEN RAISE EXCEPTION 'ASSERT: %', msg; END IF; RAISE NOTICE 'PASS: %', msg; END $$;
CREATE TEMP TABLE t(k text); GRANT ALL ON t TO PUBLIC;

INSERT INTO t SELECT private.create_app_key('clinova', 'Clinova');
SELECT pg_temp.ok((SELECT k LIKE 'aura_%' AND length(k) = 69 FROM t), 'app key created');
SELECT pg_temp.ok((SELECT api_key_hash <> (SELECT k FROM t) FROM public.apps), 'only hash stored');
SELECT pg_temp.ok((SELECT slug = 'clinova' FROM public.aura_app_by_key((SELECT k FROM t))), 'app found by key');
SELECT pg_temp.ok((SELECT id IS NULL FROM public.aura_app_by_key('errada')), 'wrong key refused');
UPDATE public.apps SET webhook_url = 'https://clinova.example/aura', webhook_secret = 's3cr3t';

INSERT INTO public.workspaces (id, app_id, external_id, name) SELECT '00000000-0000-0000-0000-0000000000a1', id, 'clinic-1', 'Aura Guarujá' FROM public.apps;
INSERT INTO public.workspaces (id, app_id, external_id, name) SELECT '00000000-0000-0000-0000-0000000000a2', id, 'clinic-2', 'Outra' FROM public.apps;
INSERT INTO public.channels (workspace_id, provider_account_id, status) VALUES ('00000000-0000-0000-0000-0000000000a1', 'acc-1', 'connected');

SELECT pg_temp.ok(private.phone_key('5511950210668') = private.phone_key('(11) 5021-0668'), 'phone key ignores 55 and 9th digit');
SELECT pg_temp.ok((public.aura_ingest_provider_event('{"id":"e0","event":"message.received","account":{"accountId":"x"},"message":{"platform":"whatsapp"}}') ->> 'reason') = 'unknown_account', 'unknown account');

SELECT public.aura_ingest_provider_event('{"id":"e1","event":"message.received","account":{"accountId":"acc-1"},
 "conversation":{"id":"conv-1","participantId":"5511950210668","participantName":"Maria"},
 "message":{"platform":"whatsapp","platformMessageId":"wamid-1","direction":"incoming","text":"Oi, quero agendar","attachments":[],"sentAt":"2026-11-07T12:00:00Z"}}');
SELECT pg_temp.ok((SELECT count(*) = 1 AND bool_and(name = 'Maria' AND phone = '5511950210668') FROM public.contacts), 'contact created');
SELECT pg_temp.ok((SELECT unread_count = 1 AND last_message_preview = 'Oi, quero agendar' FROM public.conversations), 'conversation created');
SELECT pg_temp.ok((SELECT array_agg(type ORDER BY created_at, type) = ARRAY['contact.created','message.received'] FROM public.app_events), 'events queued for product');
SELECT pg_temp.ok((SELECT payload #>> '{workspace,external_id}' = 'clinic-1' AND payload #>> '{contact,phone}' = '5511950210668'
  FROM public.app_events WHERE type = 'message.received'), 'event payload has workspace and contact');
SELECT pg_temp.ok((public.aura_ingest_provider_event('{"id":"e1","event":"message.received","account":{"accountId":"acc-1"}}') ->> 'duplicate')::boolean, 'duplicate skipped');

-- Mesmo número sem o 9: mesmo contato, sem novo contact.created
SELECT public.aura_ingest_provider_event('{"id":"e2","event":"message.received","account":{"accountId":"acc-1"},
 "conversation":{"id":"conv-1","participantId":"551150210668"},
 "message":{"platform":"whatsapp","platformMessageId":"wamid-2","direction":"incoming","text":"?","attachments":[],"sentAt":"2026-11-07T12:01:00Z"}}');
SELECT pg_temp.ok((SELECT count(*) = 1 FROM public.contacts), 'same contact with/without 9');
SELECT pg_temp.ok((SELECT count(*) = 1 FROM public.app_events WHERE type = 'contact.created'), 'no second contact.created');

-- Envio + eco + status
SELECT public.aura_record_outgoing((SELECT id FROM public.conversations), 'wamid-out', 'Olá Maria!', 'human', 'user-123');
SELECT public.aura_ingest_provider_event('{"id":"e3","event":"message.sent","account":{"accountId":"acc-1"},"conversation":{"id":"conv-1","participantId":"5511950210668"},
 "message":{"platform":"whatsapp","platformMessageId":"wamid-out","direction":"outgoing","text":"Olá Maria!","attachments":[],"sentAt":"2026-11-07T12:02:00Z"}}');
SELECT pg_temp.ok((SELECT count(*) = 1 AND bool_and(source = 'human' AND sent_by = 'user-123') FROM public.messages WHERE provider_message_id = 'wamid-out'), 'echo not duplicated, keeps human source');
SELECT pg_temp.ok((SELECT unread_count = 0 FROM public.conversations), 'reply clears unread');
SELECT public.aura_ingest_provider_event('{"id":"e4","event":"message.read","account":{"accountId":"acc-1"},"message":{"platform":"whatsapp","platformMessageId":"wamid-out"}}');
SELECT public.aura_ingest_provider_event('{"id":"e5","event":"message.delivered","account":{"accountId":"acc-1"},"message":{"platform":"whatsapp","platformMessageId":"wamid-out"}}');
SELECT pg_temp.ok((SELECT status = 'read' FROM public.messages WHERE provider_message_id = 'wamid-out'), 'late delivered does not downgrade read');

-- Fila de entrega
SELECT pg_temp.ok((SELECT count(*) >= 3 FROM public.aura_claim_app_events(50)), 'claim due events');
SELECT pg_temp.ok((SELECT count(*) = 0 FROM public.aura_claim_app_events(50)), 'claimed events not claimed twice');
SELECT public.aura_finish_app_event(id, true) FROM public.app_events WHERE type = 'contact.created';
SELECT public.aura_finish_app_event(id, false, 'HTTP 500') FROM public.app_events WHERE type = 'message.received' AND payload #>> '{message,body}' = '?';
SELECT pg_temp.ok((SELECT status = 'delivered' FROM public.app_events WHERE type = 'contact.created'), 'delivered marked');
SELECT pg_temp.ok((SELECT status = 'pending' AND last_error = 'HTTP 500' AND next_attempt_at > now() FROM public.app_events
  WHERE payload #>> '{message,body}' = '?'), 'failure rescheduled');

-- Sem acesso público
SET LOCAL ROLE anon;
DO $$ BEGIN PERFORM 1 FROM public.messages; RAISE EXCEPTION 'ASSERT: anon read';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS: anon cannot read'; END $$;
DO $$ BEGIN PERFORM public.aura_app_by_key('x'); RAISE EXCEPTION 'ASSERT: anon rpc';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS: anon cannot call functions'; END $$;
RESET ROLE;
ROLLBACK;
