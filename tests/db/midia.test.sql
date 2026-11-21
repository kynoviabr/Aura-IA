\set ON_ERROR_STOP on
BEGIN;
CREATE FUNCTION pg_temp.ok(v boolean, msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF v IS DISTINCT FROM true THEN RAISE EXCEPTION 'ASSERT: %', msg; END IF; RAISE NOTICE 'PASS: %', msg; END $$;

SELECT private.create_app_key('clinova', 'Clinova');
INSERT INTO public.workspaces (id, app_id, external_id, name)
SELECT '00000000-0000-0000-0000-0000000000c1', id, 'clinic-1', 'Clínica Bella' FROM public.apps;
INSERT INTO public.workspaces (id, app_id, external_id, name)
SELECT '00000000-0000-0000-0000-0000000000c2', id, 'clinic-2', 'Outra Clínica' FROM public.apps;
INSERT INTO public.channels (workspace_id, provider_account_id, status) VALUES
  ('00000000-0000-0000-0000-0000000000c1', 'acc-1', 'connected'),
  ('00000000-0000-0000-0000-0000000000c2', 'acc-2', 'connected');

SELECT pg_temp.ok((SELECT NOT media_channel_enabled FROM public.workspaces WHERE external_id = 'clinic-1'), 'media off by default');
SELECT pg_temp.ok((SELECT NOT public FROM storage.buckets WHERE id = 'inbound-media'), 'bucket is private');

-- Mensagem com anexos chega pelo webhook
SELECT public.aura_ingest_provider_event(jsonb_build_object(
  'id', 'ev-1', 'event', 'message.received', 'account', jsonb_build_object('accountId', 'acc-1'),
  'conversation', jsonb_build_object('id', 'zc-1', 'participantId', '5511999990000'),
  'message', jsonb_build_object('platformMessageId', 'wamid-1', 'text', null, 'sentAt', '2026-11-21T12:00:00Z',
    'attachments', '[{"type":"audio","url":"https://zernio.com/api/v1/whatsapp/media/m1","payload":{"voice":true}}]'::jsonb)));

CREATE TEMP TABLE atts (j jsonb);
INSERT INTO atts SELECT '[
  {"index":0,"kind":"audio","providerType":"audio","providerAttachmentId":"m1","mimeType":"audio/ogg","fileName":null,"voice":true},
  {"index":1,"kind":null,"providerType":"sticker","providerAttachmentId":"m2","mimeType":null,"fileName":null,"voice":false},
  {"index":2,"kind":"image","providerType":"image","providerAttachmentId":null,"mimeType":null,"fileName":null,"voice":false}
]'::jsonb;

-- Desligado: não registra
SELECT pg_temp.ok((SELECT public.aura_register_attachments('acc-1', 'wamid-1', j) ->> 'registered' = 'false' FROM atts), 'disabled workspace registers nothing');
SELECT pg_temp.ok((SELECT count(*) = 0 FROM public.message_attachments), 'no rows when disabled');

UPDATE public.workspaces SET media_channel_enabled = true WHERE external_id = 'clinic-1';
-- Conta de outra empresa não acha a mensagem
SELECT pg_temp.ok((SELECT public.aura_register_attachments('acc-2', 'wamid-1', j) ->> 'registered' = 'false' FROM atts), 'other workspace account cannot register');

CREATE TEMP TABLE reg AS SELECT public.aura_register_attachments('acc-1', 'wamid-1', j) AS r FROM atts;
SELECT pg_temp.ok((SELECT jsonb_array_length(r -> 'pending') = 1 FROM reg), 'only downloadable attachment is pending');
SELECT pg_temp.ok((SELECT processing_status = 'unsupported' FROM public.message_attachments WHERE attachment_index = 1), 'sticker is unsupported');
SELECT pg_temp.ok((SELECT processing_status = 'failed' AND error_code = 'media_reference_invalid' FROM public.message_attachments WHERE attachment_index = 2), 'missing reference fails');
SELECT pg_temp.ok((SELECT voice AND kind = 'audio' AND workspace_id = '00000000-0000-0000-0000-0000000000c1' FROM public.message_attachments WHERE attachment_index = 0), 'audio stored with workspace');
-- Repetição do webhook não duplica
SELECT pg_temp.ok((SELECT jsonb_array_length(public.aura_register_attachments('acc-1', 'wamid-1', j) -> 'pending') = 0 FROM atts), 'retry registers nothing new');
SELECT pg_temp.ok((SELECT count(*) = 3 FROM public.message_attachments), 'three rows total');

-- Chave estrangeira confere a empresa
DO $$ BEGIN
  INSERT INTO public.message_attachments (workspace_id, conversation_id, message_id, attachment_index, provider_type)
  SELECT '00000000-0000-0000-0000-0000000000c2', conversation_id, id, 9, 'image' FROM public.messages LIMIT 1;
  RAISE EXCEPTION 'cross-workspace insert should fail';
EXCEPTION WHEN foreign_key_violation THEN RAISE NOTICE 'PASS: cross-workspace attachment rejected';
END $$;

-- Download: pega a vez uma só vez
CREATE TEMP TABLE pend AS SELECT (r -> 'pending' ->> 0)::uuid AS id FROM reg;
SELECT pg_temp.ok((SELECT count(*) = 1 FROM public.aura_claim_attachments((SELECT array_agg(id) FROM pend), 10)), 'first claim gets it');
SELECT pg_temp.ok((SELECT count(*) = 0 FROM public.aura_claim_attachments((SELECT array_agg(id) FROM pend), 10)), 'second claim gets nothing');
SELECT pg_temp.ok((SELECT processing_status = 'processing' AND attempts = 1 FROM public.message_attachments WHERE id = (SELECT id FROM pend)), 'processing, attempt 1');

-- Falha temporária volta para a fila com espera
SELECT public.aura_finish_attachment((SELECT id FROM pend), '{"ok": false, "code": "media_download_timeout", "retry": true}');
SELECT pg_temp.ok((SELECT processing_status = 'pending' AND next_attempt_at > now() FROM public.message_attachments WHERE id = (SELECT id FROM pend)), 'temporary failure is retried later');
SELECT pg_temp.ok((SELECT count(*) = 0 FROM public.aura_claim_attachments(NULL, 10)), 'not due yet');
UPDATE public.message_attachments SET next_attempt_at = now() - interval '1 second' WHERE id = (SELECT id FROM pend);
SELECT pg_temp.ok((SELECT count(*) = 1 FROM public.aura_claim_attachments(NULL, 10)), 'due retry is claimed');

-- Sucesso
SELECT public.aura_finish_attachment((SELECT id FROM pend), jsonb_build_object('ok', true, 'mimeType', 'audio/ogg', 'format', 'ogg-opus',
  'sizeBytes', 1234, 'sha256', repeat('a', 64), 'storagePath', '00000000-0000-0000-0000-0000000000c1/x/y.oggopus'));
SELECT pg_temp.ok((SELECT processing_status = 'processed' AND size_bytes = 1234 AND delete_after > now() + interval '6 days'
  FROM public.message_attachments WHERE id = (SELECT id FROM pend)), 'processed with retention');
-- Resultado atrasado não volta o estado
SELECT public.aura_finish_attachment((SELECT id FROM pend), '{"ok": false, "code": "media_provider_error", "retry": false}');
SELECT pg_temp.ok((SELECT processing_status = 'processed' FROM public.message_attachments WHERE id = (SELECT id FROM pend)), 'late failure ignored');

-- Prazo de guarda
SELECT pg_temp.ok((SELECT count(*) = 0 FROM public.aura_attachments_to_purge(10)), 'nothing to purge yet');
UPDATE public.message_attachments SET delete_after = now() - interval '1 minute' WHERE id = (SELECT id FROM pend);
SELECT pg_temp.ok((SELECT count(*) = 1 FROM public.aura_attachments_to_purge(10)), 'expired file listed');
SELECT pg_temp.ok(public.aura_mark_attachments_purged((SELECT array_agg(id) FROM pend)) = 1, 'marked purged');
SELECT pg_temp.ok((SELECT storage_path IS NULL AND purged_at IS NOT NULL FROM public.message_attachments WHERE id = (SELECT id FROM pend)), 'path cleared');

-- Download travado e limite de tentativas
INSERT INTO public.message_attachments (workspace_id, conversation_id, message_id, attachment_index, provider_type, provider_attachment_id, kind,
  processing_status, attempts, claimed_until)
SELECT workspace_id, conversation_id, id, 5, 'video', 'm5', 'video', 'processing', 1, now() - interval '1 minute' FROM public.messages LIMIT 1;
INSERT INTO public.message_attachments (workspace_id, conversation_id, message_id, attachment_index, provider_type, provider_attachment_id, kind,
  processing_status, attempts, claimed_until)
SELECT workspace_id, conversation_id, id, 6, 'video', 'm6', 'video', 'processing', 4, now() - interval '1 minute' FROM public.messages LIMIT 1;
SELECT pg_temp.ok((SELECT count(*) = 1 FROM public.aura_claim_attachments(NULL, 10)), 'stuck download is claimed again');
SELECT pg_temp.ok((SELECT processing_status = 'failed' FROM public.message_attachments WHERE attachment_index = 6), 'over max attempts fails');

-- Ninguém de fora lê
SET LOCAL ROLE anon;
DO $$ BEGIN
  PERFORM 1 FROM public.message_attachments;
  RAISE EXCEPTION 'anon should not read attachments';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS: anon cannot read attachments';
END $$;
RESET ROLE;
SET LOCAL ROLE authenticated;
DO $$ BEGIN
  PERFORM public.aura_claim_attachments(NULL, 10);
  RAISE EXCEPTION 'authenticated should not claim';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS: authenticated cannot call media functions';
END $$;
RESET ROLE;
ROLLBACK;
