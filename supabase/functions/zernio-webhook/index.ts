// Recebe os avisos da Zernio (mensagens recebidas/enviadas, entregue, lida, falha) para todas as empresas.
// Publicada sem login do Supabase: a proteção é a assinatura HMAC com ZERNIO_WEBHOOK_SECRET.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { verifySignature } from '../_shared/hmac.ts';
import { dispatchAppEvents } from '../_shared/dispatch.ts';
import { autoReply } from '../_shared/auto-runner.ts';

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method !== 'POST') return reply({ ok: false }, 405);
  const secret = (Deno.env.get('ZERNIO_WEBHOOK_SECRET') || '').trim();
  if (!secret) return reply({ ok: false, reason: 'secret_not_configured' }, 500);

  const raw = await req.text();
  const signature = req.headers.get('x-zernio-signature') || req.headers.get('x-late-signature');
  if (!(await verifySignature(secret, raw, signature))) {
    console.warn('zernio webhook: assinatura inválida', { hasSignature: !!signature, secretLength: secret.length });
    return reply({ ok: false, reason: 'invalid_signature' }, 401);
  }

  let event: Record<string, unknown>;
  try { event = JSON.parse(raw); } catch { return reply({ ok: false, reason: 'invalid_json' }, 400); }

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const { data, error } = await admin.rpc('aura_ingest_provider_event', { p_event: event });
  if (error) {
    console.error('aura_ingest_provider_event', event?.event, error.message);
    return reply({ ok: false }, 500); // a Zernio tenta de novo; o banco ignora repetição
  }
  if ((data as { ok?: boolean })?.ok === false) console.warn('zernio webhook ignorado', event?.event, data);

  // Entrega os avisos novos aos produtos sem atrasar a resposta à Zernio.
  const rpc = (fn: string, args: Record<string, unknown>) => admin.rpc(fn, args);
  // @ts-ignore EdgeRuntime existe no Supabase
  const bg = typeof EdgeRuntime !== 'undefined' ? EdgeRuntime : null;
  const job = dispatchAppEvents(rpc).catch((e) => console.error('dispatch', (e as Error).message));
  if (bg?.waitUntil) bg.waitUntil(job); else await job;

  // Mensagem de cliente: se a empresa está no modo automático, a IA responde (em segundo plano).
  const convId = (data as { conversation_id?: string })?.conversation_id;
  if (event?.event === 'message.received' && convId && !(data as { duplicate?: boolean })?.duplicate) {
    const ai = autoReply(admin, convId).catch((e) => console.error('auto_reply', (e as Error).message));
    if (bg?.waitUntil) bg.waitUntil(ai); else await ai;
  }
  return reply({ ok: true });
});
