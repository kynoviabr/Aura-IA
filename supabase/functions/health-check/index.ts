// Verificação automática (agendada a cada 15 min): chaves de IA, saúde dos números e reentrega de avisos.
// Protegida pela senha do agendador guardada no cofre (aura_cron_secret).
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { ZernioClient } from '../_shared/zernio.ts';
import { testProviderKey } from '../_shared/providers.ts';
import { dispatchAppEvents } from '../_shared/dispatch.ts';

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const { data: allowed } = await db.rpc('aura_cron_secret_ok', { p_secret: req.headers.get('x-aura-cron') || '' });
  if (!allowed) return reply({ ok: false }, 401);

  const summary: Record<string, unknown> = {};

  // 1) Chaves de IA ligadas
  const { data: providers } = await db.from('ai_providers').select('provider, enabled, key_secret_id').eq('enabled', true);
  summary.providers = {};
  for (const p of providers || []) {
    if (!p.key_secret_id) continue;
    const { data: key } = await db.rpc('aura_get_provider_key', { p_provider: p.provider });
    const r = await testProviderKey(p.provider, String(key || ''));
    await db.rpc('aura_set_provider_status', { p_provider: p.provider, p_ok: r.ok, p_error: r.error || null });
    (summary.providers as Record<string, unknown>)[p.provider] = r.ok ? 'ok' : r.error;
  }

  // 2) Saúde dos números conectados (Zernio)
  const zKey = (Deno.env.get('ZERNIO_API_KEY') || '').trim();
  const { data: channels } = await db.from('channels').select('id, provider_account_id').eq('status', 'connected').not('provider_account_id', 'is', null);
  let checked = 0;
  if (zKey) {
    const z = new ZernioClient(zKey);
    for (const ch of channels || []) {
      try {
        const h = await z.call(`/accounts/${ch.provider_account_id}/health`) as Record<string, unknown>;
        const status = String(h.status || 'error');
        const issues = (h.issues as unknown[] | undefined)?.map((i) => (typeof i === 'string' ? i : JSON.stringify(i))).join('; ') || null;
        await db.rpc('aura_set_channel_health', { p_channel_id: ch.id, p_health: status === 'healthy' ? 'healthy' : status === 'warning' ? 'warning' : 'error', p_detail: issues });
      } catch (e) {
        // Número de teste (sandbox) não tem consulta de saúde: não marca erro por isso.
        const msg = (e as Error).message;
        if (!/not found|404/i.test(msg)) await db.rpc('aura_set_channel_health', { p_channel_id: ch.id, p_health: 'error', p_detail: msg });
      }
      checked++;
    }
  }
  summary.channels_checked = checked;

  // 3) Reentrega de avisos pendentes para os produtos
  summary.dispatch = await dispatchAppEvents((fn, args) => db.rpc(fn, args), fetch, 100).catch((e) => ({ error: (e as Error).message }));

  return reply({ ok: true, ...summary });
});
