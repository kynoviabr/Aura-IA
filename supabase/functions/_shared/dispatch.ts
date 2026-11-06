/** Entrega os avisos da fila (app_events) para os produtos, assinados com HMAC. */
import { hmacHex } from './hmac.ts';

type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;

type Claimed = { id: string; type: string; payload: Record<string, unknown>; webhook_url: string | null; webhook_secret: string | null; attempts: number; created_at: string };

export async function dispatchAppEvents(rpc: Rpc, fetchImpl: typeof fetch = fetch, limit = 20): Promise<{ delivered: number; failed: number }> {
  const { data, error } = await rpc('aura_claim_app_events', { p_limit: limit });
  if (error) throw new Error(error.message);
  let delivered = 0;
  let failed = 0;
  for (const ev of (data as Claimed[]) || []) {
    let ok = false;
    let err: string | null = null;
    try {
      if (!ev.webhook_url) throw new Error('produto sem endereço de avisos');
      const body = JSON.stringify({ id: ev.id, type: ev.type, created_at: ev.created_at, data: ev.payload });
      const res = await fetchImpl(ev.webhook_url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Aura-Event': ev.type,
          'X-Aura-Event-Id': ev.id,
          'X-Aura-Signature': await hmacHex(ev.webhook_secret || '', body),
        },
        body,
        signal: AbortSignal.timeout(8000),
      });
      ok = res.ok;
      if (!ok) err = `HTTP ${res.status}`;
    } catch (e) {
      err = (e as Error).message;
    }
    await rpc('aura_finish_app_event', { p_id: ev.id, p_ok: ok, p_error: err });
    if (ok) delivered++; else failed++;
  }
  return { delivered, failed };
}
