// Reentrega os avisos pendentes para os produtos (chamada por agendamento a cada minuto).
// Protegida pela senha do agendador (cofre: aura_cron_secret) ou AURA_CRON_SECRET, no cabeçalho x-aura-cron.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { safeEqual } from '../_shared/hmac.ts';
import { dispatchAppEvents } from '../_shared/dispatch.ts';

Deno.serve(async (req) => {
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const given = req.headers.get('x-aura-cron') || '';
  const envSecret = (Deno.env.get('AURA_CRON_SECRET') || '').trim();
  const { data: vaultOk } = await admin.rpc('aura_cron_secret_ok', { p_secret: given });
  if (!vaultOk && !(envSecret && safeEqual(given, envSecret))) {
    return new Response(JSON.stringify({ ok: false }), { status: 401 });
  }
  const result = await dispatchAppEvents((fn, args) => admin.rpc(fn, args), fetch, 50);
  return new Response(JSON.stringify({ ok: true, ...result }), { headers: { 'Content-Type': 'application/json' } });
});
