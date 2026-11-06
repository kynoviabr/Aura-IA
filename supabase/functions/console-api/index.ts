// API do Console da Aura IA (só a equipe Kynovia).
// O Console entra com o login do Supabase da Aura; aqui conferimos se a pessoa está em console_users
// e o papel dela (owner, operator, viewer). Toda leitura e gravação passa por aqui, com o servidor.
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';
import { corsHeaders, errorResponse, HttpError, json } from '../_shared/http.ts';
import { ZernioClient } from '../_shared/zernio.ts';
import { ensureStandardTemplates } from '../_shared/templates.ts';
import { testProviderKey } from '../_shared/providers.ts';
import { aiClients } from '../_shared/ai-clients.ts';
import { EVAL_PAIRS, evalJobs, runJobs, SCENARIOS } from '../_shared/eval.ts';

type Role = 'owner' | 'operator' | 'viewer';
type Me = { id: string; email: string; role: Role };

const WRITE: Role[] = ['owner', 'operator'];

function need(me: Me, roles: Role[]) {
  if (!roles.includes(me.role)) throw new HttpError(403, 'forbidden', 'Seu acesso ao Console não permite esta ação.');
}

function str(v: unknown, max = 500): string {
  return String(v ?? '').trim().slice(0, max);
}

async function rpc<T = unknown>(db: SupabaseClient, fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await db.rpc(fn, args);
  if (error) {
    const known: Record<string, string> = {
      slug_in_use: 'Já existe uma aplicação com este identificador.',
      invalid_key: 'Chave inválida.',
      invalid_amount: 'Informe uma quantidade maior que zero.',
    };
    const k = Object.keys(known).find((x) => error.message.includes(x));
    throw new HttpError(400, k || 'db_error', k ? known[k] : error.message);
  }
  return data as T;
}

async function audit(db: SupabaseClient, me: Me, action: string, targetType: string, targetId: string, detail: Record<string, unknown> = {}) {
  await db.from('audit_log').insert({ actor: me.id, actor_email: me.email, action, target_type: targetType, target_id: targetId, detail });
}

/** Roda a prova em segundo plano: cada resposta é salva assim que chega. */
async function runEval(db: SupabaseClient, runId: string, pair: string) {
  try {
    const clients = await aiClients(db);
    await runJobs(evalJobs(EVAL_PAIRS[pair].models), clients, async (job, r) => {
      await db.from('ai_eval_results').upsert({
        run_id: runId, scenario_id: job.scenario.id, scenario_title: job.scenario.title, category: job.scenario.category,
        expectation: job.scenario.expectation, provider: job.model.provider, model: job.model.model,
        output: r.text, outcome: r.outcome, error: r.error || null, latency_ms: r.latencyMs,
        input_tokens: r.inputTokens, output_tokens: r.outputTokens,
      }, { onConflict: 'run_id,scenario_id,provider,model' });
      // Custo real registrado no uso de IA (avaliação não cobra créditos de empresa).
      const { data: usage } = await db.rpc('aura_record_ai_usage', {
        p_workspace_id: null, p_conversation_id: null, p_feature: 'eval', p_provider: job.model.provider, p_model: job.model.model,
        p_input: r.inputTokens, p_cached: r.cachedTokens, p_output: r.outputTokens, p_latency_ms: r.latencyMs,
        p_outcome: r.outcome, p_error_code: r.error ? r.error.slice(0, 120) : null,
      });
      await db.from('ai_eval_results').update({ cost_usd: (usage as { cost_usd?: number })?.cost_usd ?? 0 })
        .eq('run_id', runId).eq('scenario_id', job.scenario.id).eq('model', job.model.model);
      await db.rpc('aura_eval_progress', { p_run_id: runId });
    });
  } catch (e) {
    await db.from('ai_eval_runs').update({ status: 'failed', error: (e as Error).message, finished_at: new Date().toISOString() }).eq('id', runId);
  }
}

function zernio() {
  return new ZernioClient((Deno.env.get('ZERNIO_API_KEY') || '').trim());
}

async function handle(db: SupabaseClient, me: Me, action: string, b: Record<string, unknown>) {
  switch (action) {
    case 'me':
      return { me };

    // ---------- Visão geral ----------
    case 'overview': {
      const [overview, usage, alerts, providers] = await Promise.all([
        rpc(db, 'aura_console_overview'),
        rpc(db, 'aura_console_usage_daily', { p_workspace_id: null, p_days: 30 }),
        db.from('alerts').select('*').eq('status', 'open').order('severity').order('last_seen_at', { ascending: false }).limit(20),
        db.from('ai_providers').select('provider, enabled, status, key_hint, balance_usd, low_balance_usd, last_check_at, last_error, recharge_url'),
      ]);
      return { overview, usage, alerts: alerts.data || [], providers: providers.data || [] };
    }

    // ---------- Empresas e números ----------
    case 'workspaces':
      return { workspaces: await rpc(db, 'aura_console_workspaces') };

    case 'workspace': {
      const id = str(b.id, 64);
      const [{ data: ws }, { data: channel }, { data: wallet }, { data: ledger }, usage, { data: alerts }, { data: byFeature }] = await Promise.all([
        db.from('workspaces').select('*, app:apps(id, name, slug)').eq('id', id).maybeSingle(),
        db.from('channels').select('*').eq('workspace_id', id).maybeSingle(),
        db.from('credit_wallets').select('*').eq('workspace_id', id).maybeSingle(),
        db.from('credit_ledger').select('*').eq('workspace_id', id).neq('kind', 'usage').order('created_at', { ascending: false }).limit(50),
        rpc(db, 'aura_console_usage_daily', { p_workspace_id: id, p_days: 30 }),
        db.from('alerts').select('*').eq('workspace_id', id).order('created_at', { ascending: false }).limit(30),
        db.from('ai_usage').select('feature, provider, model, cost_usd, credits, input_tokens, output_tokens')
          .eq('workspace_id', id).gte('created_at', new Date(Date.now() - 30 * 864e5).toISOString()).limit(5000),
      ]);
      if (!ws) throw new HttpError(404, 'not_found', 'Empresa não encontrada.');
      const { data: turns } = await db.from('ai_turns')
        .select('id, conversation_id, outcome, handoff, tools, sent_text, flags, booking_id, error, latency_ms, model, created_at')
        .eq('workspace_id', id).order('created_at', { ascending: false }).limit(30);
      const { data: sugg } = await db.from('ai_suggestions').select('status, outcome')
        .eq('workspace_id', id).gte('created_at', new Date(Date.now() - 30 * 864e5).toISOString()).limit(10000);
      const suggestions = { total: 0, sent: 0, sent_edited: 0, errors: 0 };
      for (const x of sugg || []) {
        suggestions.total++;
        if (x.status === 'sent') suggestions.sent++;
        if (x.status === 'sent_edited') suggestions.sent_edited++;
        if (x.outcome === 'error') suggestions.errors++;
      }
      const models: Record<string, { calls: number; cost_usd: number; credits: number; input: number; output: number }> = {};
      for (const u of byFeature || []) {
        const k = `${u.feature} · ${u.model}`;
        models[k] ||= { calls: 0, cost_usd: 0, credits: 0, input: 0, output: 0 };
        models[k].calls++; models[k].cost_usd += Number(u.cost_usd); models[k].credits += Number(u.credits);
        models[k].input += u.input_tokens; models[k].output += u.output_tokens;
      }
      return { workspace: ws, channel, wallet, ledger: ledger || [], usage, alerts: alerts || [], breakdown: models, suggestions, turns: turns || [] };
    }

    case 'channel_check': {
      need(me, WRITE);
      const { data: ch } = await db.from('channels').select('*').eq('id', str(b.id, 64)).maybeSingle();
      if (!ch?.provider_account_id) throw new HttpError(400, 'no_account', 'Este número ainda não está conectado.');
      const h = await zernio().call(`/accounts/${ch.provider_account_id}/health`).catch((e) => ({ status: 'error', error: (e as Error).message }));
      const status = String((h as Record<string, unknown>).status || 'error');
      const health = status === 'healthy' ? 'healthy' : status === 'warning' ? 'warning' : 'error';
      const issues = ((h as Record<string, unknown>).issues as unknown[] | undefined)?.map((i) => (typeof i === 'string' ? i : JSON.stringify(i))).join('; ');
      await rpc(db, 'aura_set_channel_health', { p_channel_id: ch.id, p_health: health, p_detail: issues || (h as Record<string, unknown>).error || null });
      return { health, detail: issues || null };
    }

    case 'channel_templates': {
      const { data: ch } = await db.from('channels').select('provider_account_id').eq('id', str(b.id, 64)).maybeSingle();
      if (!ch?.provider_account_id) return { templates: [] };
      return { templates: await zernio().templates(ch.provider_account_id, false) };
    }

    case 'channel_templates_create': {
      need(me, WRITE);
      const { data: ch } = await db.from('channels').select('provider_account_id').eq('id', str(b.id, 64)).maybeSingle();
      if (!ch?.provider_account_id) throw new HttpError(400, 'no_account', 'Este número ainda não está conectado.');
      const result = await ensureStandardTemplates(zernio(), ch.provider_account_id);
      await audit(db, me, 'templates_created', 'channel', str(b.id, 64), result);
      return { result };
    }

    // ---------- Créditos ----------
    case 'grant_credits': {
      need(me, WRITE);
      const kind = str(b.kind, 20) || 'purchase';
      const packageId = b.packageId ? str(b.packageId, 64) : null;
      let amount = Number(b.amount);
      if (packageId) {
        const { data: pkg } = await db.from('credit_packages').select('credits').eq('id', packageId).single();
        amount = Number(pkg?.credits);
      }
      if (!Number.isFinite(amount) || amount === 0) throw new HttpError(400, 'invalid_amount', 'Informe a quantidade de créditos.');
      const balance = await rpc(db, 'aura_grant_credits', {
        p_workspace_id: str(b.workspaceId, 64), p_amount: amount, p_kind: kind, p_package_id: packageId, p_note: str(b.note, 300) || null, p_actor: me.id,
      });
      await audit(db, me, 'credits_granted', 'workspace', str(b.workspaceId, 64), { amount, kind, packageId });
      return { balance };
    }

    case 'wallet_update': {
      need(me, WRITE);
      const id = str(b.workspaceId, 64);
      await db.from('credit_wallets').upsert({ workspace_id: id, hard_stop: !!b.hardStop, updated_at: new Date().toISOString() }, { onConflict: 'workspace_id' });
      await audit(db, me, 'wallet_updated', 'workspace', id, { hard_stop: !!b.hardStop });
      return { ok: true };
    }

    case 'packages':
      return { packages: (await db.from('credit_packages').select('*').order('credits')).data || [] };

    case 'package_save': {
      need(me, ['owner']);
      const row = { name: str(b.name, 80), credits: Number(b.credits), price_brl: Number(b.priceBrl), active: b.active !== false };
      if (!row.name || !(row.credits > 0) || !(row.price_brl >= 0)) throw new HttpError(400, 'invalid', 'Preencha nome, créditos e preço.');
      const q = b.id ? db.from('credit_packages').update(row).eq('id', str(b.id, 64)) : db.from('credit_packages').insert(row);
      const { error } = await q;
      if (error) throw new HttpError(400, 'db_error', error.message);
      await audit(db, me, 'package_saved', 'package', str(b.id, 64) || row.name, row);
      return { ok: true };
    }

    // ---------- Aplicações conectadas ----------
    case 'apps': {
      const { data: apps } = await db.from('apps')
        .select('id, slug, name, api_key_prefix, webhook_url, api_base_url, is_active, created_at, last_delivery_ok_at, last_delivery_error_at, last_delivery_error')
        .order('name');
      const { data: counts } = await db.from('app_events').select('app_id, status').in('status', ['pending', 'failed']).limit(10000);
      const { data: wss } = await db.from('workspaces').select('app_id');
      return {
        apps: (apps || []).map((a) => ({
          ...a,
          pending: (counts || []).filter((c) => c.app_id === a.id && c.status === 'pending').length,
          failed: (counts || []).filter((c) => c.app_id === a.id && c.status === 'failed').length,
          workspaces: (wss || []).filter((w) => w.app_id === a.id).length,
        })),
      };
    }

    case 'app_create': {
      need(me, ['owner']);
      const slug = str(b.slug, 40).toLowerCase();
      if (!/^[a-z0-9-]{2,40}$/.test(slug)) throw new HttpError(400, 'invalid_slug', 'Identificador: só letras minúsculas, números e hífen.');
      const url = str(b.webhookUrl, 500);
      if (url && !/^https:\/\//.test(url)) throw new HttpError(400, 'invalid_url', 'O endereço de avisos deve começar com https://');
      const secrets = await rpc(db, 'aura_create_app', { p_slug: slug, p_name: str(b.name, 80) || slug, p_webhook_url: url || null, p_actor: me.id });
      return { secrets };
    }

    case 'app_update': {
      need(me, ['owner']);
      const url = str(b.webhookUrl, 500);
      const apiUrl = str(b.apiBaseUrl, 500);
      if (url && !/^https:\/\//.test(url)) throw new HttpError(400, 'invalid_url', 'O endereço de avisos deve começar com https://');
      if (apiUrl && !/^https:\/\//.test(apiUrl)) throw new HttpError(400, 'invalid_url', 'O endereço da API do produto deve começar com https://');
      const { error } = await db.from('apps').update({
        name: str(b.name, 80), webhook_url: url || null, api_base_url: apiUrl || null, is_active: b.isActive !== false,
      }).eq('id', str(b.id, 64));
      if (error) throw new HttpError(400, 'db_error', error.message);
      await audit(db, me, 'app_updated', 'app', str(b.id, 64), { webhook_url: url, api_base_url: apiUrl, is_active: b.isActive !== false });
      return { ok: true };
    }

    case 'app_rotate_key': {
      need(me, ['owner']);
      return { apiKey: await rpc(db, 'aura_rotate_app_key', { p_app_id: str(b.id, 64), p_actor: me.id }) };
    }

    case 'app_retry': {
      need(me, WRITE);
      const n = await rpc<number>(db, 'aura_retry_failed_events', { p_app_id: b.id ? str(b.id, 64) : null });
      await audit(db, me, 'events_retried', 'app', str(b.id, 64) || '*', { count: n });
      return { retried: n };
    }

    case 'app_events': {
      const { data } = await db.from('app_events').select('id, type, status, attempts, last_error, created_at, delivered_at, next_attempt_at, workspace_id')
        .eq('app_id', str(b.id, 64)).order('created_at', { ascending: false }).limit(100);
      return { events: data || [] };
    }

    // ---------- Provedores de IA ----------
    case 'providers': {
      const [{ data: providers }, { data: prices }] = await Promise.all([
        db.from('ai_providers').select('provider, enabled, status, key_hint, last_check_at, last_ok_at, last_error, balance_usd, balance_set_at, low_balance_usd, recharge_url, updated_at').order('provider'),
        db.from('model_prices').select('*').order('provider').order('input_per_mtok'),
      ]);
      return { providers: providers || [], prices: prices || [] };
    }

    case 'provider_set_key': {
      need(me, ['owner']);
      const provider = str(b.provider, 20);
      await rpc(db, 'aura_set_provider_key', { p_provider: provider, p_key: str(b.key, 400), p_actor: me.id });
      const result = await testProviderKey(provider, str(b.key, 400));
      await rpc(db, 'aura_set_provider_status', { p_provider: provider, p_ok: result.ok, p_error: result.error || null });
      return { test: result };
    }

    case 'provider_test': {
      need(me, WRITE);
      const provider = str(b.provider, 20);
      const key = await rpc<string | null>(db, 'aura_get_provider_key', { p_provider: provider });
      if (!key) throw new HttpError(400, 'no_key', 'Cadastre a chave primeiro.');
      const result = await testProviderKey(provider, key);
      await rpc(db, 'aura_set_provider_status', { p_provider: provider, p_ok: result.ok, p_error: result.error || null });
      return { test: result };
    }

    case 'provider_update': {
      need(me, ['owner']);
      const provider = str(b.provider, 20);
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if ('enabled' in b) patch.enabled = !!b.enabled;
      if ('lowBalanceUsd' in b) patch.low_balance_usd = Number(b.lowBalanceUsd) || 0;
      if ('balanceUsd' in b) { patch.balance_usd = b.balanceUsd === null ? null : Number(b.balanceUsd); patch.balance_set_at = new Date().toISOString(); }
      const { error } = await db.from('ai_providers').update(patch).eq('provider', provider);
      if (error) throw new HttpError(400, 'db_error', error.message);
      await audit(db, me, 'provider_updated', 'ai_provider', provider, patch);
      return { ok: true };
    }

    // ---------- Alertas ----------
    case 'alerts': {
      const status = str(b.status, 20) || 'open';
      let q = db.from('alerts').select('*, workspace:workspaces(id, name)').order('last_seen_at', { ascending: false }).limit(200);
      if (status !== 'all') q = q.eq('status', status);
      return { alerts: (await q).data || [] };
    }

    case 'alert_resolve': {
      need(me, WRITE);
      await db.from('alerts').update({ status: 'resolved', resolved_at: new Date().toISOString() }).eq('id', str(b.id, 64));
      await audit(db, me, 'alert_resolved', 'alert', str(b.id, 64));
      return { ok: true };
    }

    // ---------- Configurações, equipe e histórico ----------
    case 'settings': {
      const [{ data: settings }, { data: users }] = await Promise.all([
        db.from('platform_settings').select('key, value, updated_at'),
        db.from('console_users').select('user_id, email, role, created_at').order('created_at'),
      ]);
      return { settings: Object.fromEntries((settings || []).map((s) => [s.key, s.value])), users: users || [] };
    }

    case 'settings_save': {
      need(me, ['owner']);
      const allowed = ['credits_per_usd', 'wallet_low_percent', 'alert_emails', 'copilot_model', 'auto_model'];
      for (const [key, value] of Object.entries((b.settings || {}) as Record<string, unknown>)) {
        if (!allowed.includes(key)) continue;
        if (key === 'copilot_model' || key === 'auto_model') {
          const v = value as { provider?: string; model?: string };
          const { data: price } = await db.from('model_prices').select('model').eq('provider', String(v?.provider)).eq('model', String(v?.model)).maybeSingle();
          if (!price) throw new HttpError(400, 'invalid_model', 'Modelo de IA desconhecido.');
        }
        await db.from('platform_settings').update({ value, updated_at: new Date().toISOString(), updated_by: me.id }).eq('key', key);
      }
      await audit(db, me, 'settings_saved', 'settings', '*', (b.settings || {}) as Record<string, unknown>);
      return { ok: true };
    }

    case 'user_invite': {
      need(me, ['owner']);
      const email = str(b.email, 200).toLowerCase();
      const role = (['owner', 'operator', 'viewer'].includes(str(b.role, 20)) ? str(b.role, 20) : 'viewer') as Role;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'invalid_email', 'E-mail inválido.');
      const redirectTo = str(b.redirectTo, 500) || undefined;
      const { data, error } = await db.auth.admin.inviteUserByEmail(email, { redirectTo });
      let userId = data?.user?.id;
      if (error) {
        const { data: list } = await db.auth.admin.listUsers({ perPage: 1000 });
        userId = list?.users.find((u) => u.email?.toLowerCase() === email)?.id;
        if (!userId) throw new HttpError(400, 'invite_failed', error.message);
      }
      await db.from('console_users').upsert({ user_id: userId, email, role }, { onConflict: 'user_id' });
      await audit(db, me, 'user_invited', 'console_user', email, { role });
      return { ok: true };
    }

    case 'user_remove': {
      need(me, ['owner']);
      const id = str(b.userId, 64);
      if (id === me.id) throw new HttpError(400, 'self', 'Você não pode remover o próprio acesso.');
      await db.from('console_users').delete().eq('user_id', id);
      await audit(db, me, 'user_removed', 'console_user', id);
      return { ok: true };
    }

    // ---------- Avaliação de IA (prova lado a lado) ----------
    case 'eval_pairs':
      return { pairs: Object.entries(EVAL_PAIRS).map(([id, p]) => ({ id, title: p.title, models: p.models })), scenarios: SCENARIOS.length };

    case 'eval_start': {
      need(me, WRITE);
      const pair = str(b.pair, 20);
      if (!EVAL_PAIRS[pair]) throw new HttpError(400, 'invalid_pair', 'Escolha a prova.');
      const { data: running } = await db.from('ai_eval_runs').select('id').eq('status', 'running')
        .gte('created_at', new Date(Date.now() - 10 * 60000).toISOString()).limit(1);
      if (running?.length) throw new HttpError(409, 'eval_running', 'Já existe uma prova rodando. Aguarde terminar.');
      const models = EVAL_PAIRS[pair].models;
      const { data: run, error } = await db.from('ai_eval_runs').insert({
        title: EVAL_PAIRS[pair].title, models, total: SCENARIOS.length * models.length, created_by: me.id, created_by_email: me.email,
      }).select('id').single();
      if (error) throw new HttpError(500, 'db_error', error.message);
      const job = runEval(db, run.id, pair);
      // @ts-ignore EdgeRuntime existe no Supabase: mantém a prova rodando depois de responder ao Console.
      if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime.waitUntil) EdgeRuntime.waitUntil(job); else await job;
      await audit(db, me, 'eval_started', 'eval', run.id, { pair });
      return { runId: run.id };
    }

    case 'eval_runs':
      return { runs: (await db.from('ai_eval_runs').select('*').order('created_at', { ascending: false }).limit(30)).data || [] };

    case 'eval_run': {
      const id = str(b.id, 64);
      const [{ data: run }, { data: results }] = await Promise.all([
        db.from('ai_eval_runs').select('*').eq('id', id).maybeSingle(),
        db.from('ai_eval_results').select('*').eq('run_id', id).order('scenario_id'),
      ]);
      if (!run) throw new HttpError(404, 'not_found', 'Prova não encontrada.');
      const order = SCENARIOS.map((sc) => sc.id);
      const scenarios = Object.fromEntries(SCENARIOS.map((sc) => [sc.id, sc.messages]));
      return { run, results: (results || []).sort((x, y) => order.indexOf(x.scenario_id) - order.indexOf(y.scenario_id)), scenarios };
    }

    case 'eval_rate': {
      need(me, WRITE);
      const rating = b.rating === 1 || b.rating === -1 ? b.rating : null;
      await db.from('ai_eval_results').update({ rating, rated_by: rating ? me.email : null }).eq('id', str(b.id, 64));
      return { ok: true };
    }

    case 'audit':
      return { entries: (await db.from('audit_log').select('*').order('created_at', { ascending: false }).limit(200)).data || [] };

    default:
      throw new HttpError(400, 'invalid_action', 'Ação inválida.');
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const authHeader = req.headers.get('Authorization') || '';
    const userClient = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } } });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) throw new HttpError(401, 'unauthorized', 'Entre de novo no Console.');
    const db = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
    const { data: row } = await db.from('console_users').select('role, email').eq('user_id', user.id).maybeSingle();
    if (!row) throw new HttpError(403, 'not_console_user', 'Seu usuário não tem acesso ao Console da Aura IA.');
    const body = await req.json().catch(() => ({}));
    const me: Me = { id: user.id, email: row.email || user.email || '', role: row.role as Role };
    return json(await handle(db, me, String(body.action || ''), body));
  } catch (err) {
    return errorResponse(err);
  }
});
