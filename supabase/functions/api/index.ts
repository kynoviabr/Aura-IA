// API da Aura IA para os produtos (Clinova, Agenda+, Belariz...).
// Autenticação: chave do produto em "Authorization: Bearer aura_..." (ou x-aura-key).
// Publicada sem login do Supabase (verify_jwt = false): quem protege é a chave do produto.
// Toda empresa é endereçada pelo id dela no produto (external_id); conversas e contatos pelo id da Aura.
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';
import { corsHeaders, errorResponse, HttpError, json, match, routeParts } from '../_shared/http.ts';
import { isWindowOpen, phoneKey, renderTemplate, waNumber } from '../_shared/phone.ts';
import { ZernioClient } from '../_shared/zernio.ts';
import { ensureStandardTemplates } from '../_shared/templates.ts';
import { aiClients } from '../_shared/ai-clients.ts';
import { ProductClient, type ProductResult } from '../_shared/product.ts';
import { businessContext, suggestReply, type HistoryMessage } from '../_shared/copilot.ts';
import { FLAG_TEXT } from '../_shared/safety.ts';

type App = { id: string; slug: string; name: string };
type Workspace = { id: string; app_id: string; external_id: string; name: string; timezone: string };

const CONV_FIELDS = 'id, status, last_message_at, last_message_preview, last_message_direction, last_incoming_at, unread_count, ai_paused_until, ai_pause_reason, created_at, contact:contacts(id, phone, name, external_type, external_ref)';
const MSG_FIELDS = 'id, direction, source, sent_by, body, attachments, status, error, sent_at';

function str(v: unknown, max = 500): string {
  return String(v ?? '').trim().slice(0, max);
}

async function body(req: Request): Promise<Record<string, unknown>> {
  if (req.method === 'GET') return {};
  try { return await req.json(); } catch { throw new HttpError(400, 'invalid_json', 'Corpo da requisição inválido.'); }
}

async function authenticate(db: SupabaseClient, req: Request): Promise<App> {
  const key = (req.headers.get('x-aura-key') || req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || '').trim();
  if (!key.startsWith('aura_')) throw new HttpError(401, 'unauthorized', 'Chave do produto ausente.');
  const { data } = await db.rpc('aura_app_by_key', { p_key: key });
  const app = (Array.isArray(data) ? data[0] : data) as App | null;
  if (!app?.id) throw new HttpError(401, 'unauthorized', 'Chave do produto inválida.');
  return app;
}

async function workspaceOf(db: SupabaseClient, app: App, externalId: string): Promise<Workspace> {
  const { data } = await db.from('workspaces').select('*').eq('app_id', app.id).eq('external_id', externalId).maybeSingle();
  if (!data) throw new HttpError(404, 'workspace_not_found', 'Empresa não cadastrada na Aura IA.');
  return data as Workspace;
}

async function connectedChannel(db: SupabaseClient, workspaceId: string) {
  const { data } = await db.from('channels').select('*').eq('workspace_id', workspaceId).maybeSingle();
  if (!data?.provider_account_id || data.status !== 'connected') {
    throw new HttpError(409, 'channel_not_connected', 'O WhatsApp desta empresa ainda não está conectado.');
  }
  return data;
}

async function conversationOf(db: SupabaseClient, app: App, conversationId: string) {
  const { data } = await db.from('conversations')
    .select('*, workspace:workspaces!inner(id, app_id, external_id), contact:contacts(id, phone, name, external_type, external_ref)')
    .eq('id', conversationId).maybeSingle();
  if (!data || data.workspace.app_id !== app.id) throw new HttpError(404, 'conversation_not_found', 'Conversa não encontrada.');
  return data;
}

type SourceStatus = 'ok' | 'unsupported' | 'error' | 'not_configured';
const sourceStatus = (r: ProductResult<unknown> | null): SourceStatus => (r ? r.status : 'not_configured');

/** Copiloto: sugere a próxima mensagem com os dados do produto e a conversa. Nunca envia sozinho. */
async function suggest(db: SupabaseClient, app: App, conv: { id: string; workspace_id: string; workspace: { external_id: string } }) {
  const { data: allowed } = await db.rpc('aura_ai_allowed', { p_workspace_id: conv.workspace_id });
  if (!allowed) throw new HttpError(402, 'no_credits', 'A empresa está sem créditos de IA. Fale com a Kynovia para recarregar.');

  const [{ data: setting }, { data: appRow }, { data: ws }, { data: msgs }] = await Promise.all([
    db.from('platform_settings').select('value').eq('key', 'copilot_model').maybeSingle(),
    db.from('apps').select('api_base_url, webhook_secret').eq('id', app.id).single(),
    db.from('workspaces').select('timezone').eq('id', conv.workspace_id).single(),
    db.from('messages').select('direction, body, attachments, sent_at').eq('conversation_id', conv.id)
      .order('sent_at', { ascending: false }).limit(30),
  ]);
  const cfg = (setting?.value || {}) as { provider?: 'anthropic' | 'openai'; model?: string };
  const provider = cfg.provider === 'openai' ? 'openai' : 'anthropic';
  const model = cfg.model || 'claude-haiku-5-5';
  const { data: prov } = await db.from('ai_providers').select('enabled, status').eq('provider', provider).maybeSingle();
  if (!prov?.enabled) throw new HttpError(503, 'ai_disabled', 'A IA está desligada no momento.');

  // Dados da empresa pela API padrão do produto (se o produto já oferece).
  const product = appRow?.api_base_url && appRow.webhook_secret
    ? new ProductClient(appRow.api_base_url, appRow.webhook_secret, conv.workspace.external_id) : null;
  const [catalog, info] = product ? await Promise.all([product.catalog(), product.businessInfo()]) : [null, null];
  const context = businessContext(catalog?.status === 'ok' ? catalog.data : null, info?.status === 'ok' ? info.data : null);
  for (const r of [catalog, info]) if (r && r.status === 'error') console.error('product_api', app.slug, r.error);

  const history = ((msgs || []) as HistoryMessage[]).reverse();
  const s = await suggestReply(await aiClients(db), {
    provider, model, context, history, now: new Date(), timezone: ws?.timezone || 'America/Sao_Paulo',
  });
  const r = s.result;
  const outcome = r.outcome !== 'ok' ? r.outcome : s.safety.blocked ? 'blocked' : 'ok';
  const { data: usage } = await db.rpc('aura_record_ai_usage', {
    p_workspace_id: conv.workspace_id, p_conversation_id: conv.id, p_feature: 'copilot', p_provider: provider, p_model: model,
    p_input: r.inputTokens, p_cached: r.cachedTokens, p_output: r.outputTokens, p_latency_ms: r.latencyMs,
    p_outcome: outcome, p_error_code: r.error ? r.error.slice(0, 120) : null,
  });
  const sources = { catalog: sourceStatus(catalog), businessInfo: sourceStatus(info) };
  const { data: row } = await db.from('ai_suggestions').insert({
    workspace_id: conv.workspace_id, conversation_id: conv.id, usage_id: (usage as { usage_id?: string } | null)?.usage_id ?? null,
    provider, model, suggestion: s.text, flags: s.safety.flags, handoff: s.safety.handoff, context_sources: sources, outcome,
  }).select('id').single();

  if (r.outcome === 'error') throw new HttpError(502, 'ai_error', 'A IA não respondeu agora. Tente de novo em instantes.');
  return {
    suggestion: {
      id: row?.id ?? null,
      text: s.text,
      outcome,
      handoff: s.safety.handoff,
      flags: s.safety.flags.map((code) => ({ code, text: FLAG_TEXT[code] })),
      sources,
    },
  };
}

function zernio(): ZernioClient {
  return new ZernioClient((Deno.env.get('ZERNIO_API_KEY') || '').trim());
}

async function route(req: Request, db: SupabaseClient): Promise<Response> {
  const parts = routeParts(new URL(req.url).pathname, 'api');
  const m = req.method;
  let p: Record<string, string> | null;

  if (m === 'GET' && match('v1/health', parts)) return json({ ok: true, service: 'aura-ia' });

  const app = await authenticate(db, req);
  const b = await body(req);

  // ---------- Empresa ----------
  if (m === 'PUT' && (p = match('v1/workspaces/:ext', parts))) {
    const name = str(b.name, 120);
    if (!name) throw new HttpError(400, 'invalid_name', 'Informe o nome da empresa.');
    const { data, error } = await db.from('workspaces').upsert(
      { app_id: app.id, external_id: p.ext, name, timezone: str(b.timezone, 60) || 'America/Sao_Paulo', updated_at: new Date().toISOString() },
      { onConflict: 'app_id,external_id' },
    ).select('id, external_id, name, timezone, status').single();
    if (error) throw new HttpError(500, 'db_error', error.message);
    return json({ workspace: data });
  }

  // ---------- Modo da IA da empresa: off (desligada), copilot (sugere) ou auto (responde sozinha) ----------
  if (m === 'GET' && (p = match('v1/workspaces/:ext/ai', parts))) {
    const ws = await workspaceOf(db, app, p.ext) as Workspace & { ai_mode: string };
    return json({ mode: ws.ai_mode });
  }

  if (m === 'PUT' && (p = match('v1/workspaces/:ext/ai', parts))) {
    const ws = await workspaceOf(db, app, p.ext);
    const mode = str(b.mode, 20);
    if (!['off', 'copilot', 'auto'].includes(mode)) throw new HttpError(400, 'invalid_mode', 'Modo inválido (off, copilot ou auto).');
    const { error } = await db.from('workspaces').update({ ai_mode: mode, updated_at: new Date().toISOString() }).eq('id', ws.id);
    if (error) throw new HttpError(500, 'db_error', error.message);
    return json({ mode });
  }

  // ---------- Canal (número de WhatsApp) ----------
  if (m === 'GET' && (p = match('v1/workspaces/:ext/channel', parts))) {
    const ws = await workspaceOf(db, app, p.ext);
    const { data } = await db.from('channels').select('status, phone_number, display_name, connected_at').eq('workspace_id', ws.id).maybeSingle();
    return json({ channel: data || { status: 'not_started' } });
  }

  if (m === 'POST' && (p = match('v1/workspaces/:ext/channel/connect', parts))) {
    const ws = await workspaceOf(db, app, p.ext);
    const redirectUrl = str(b.redirectUrl, 500);
    if (!/^https:\/\//.test(redirectUrl)) throw new HttpError(400, 'invalid_redirect', 'redirectUrl deve começar com https://');
    const { data: ch } = await db.from('channels').select('*').eq('workspace_id', ws.id).maybeSingle();
    const z = zernio();
    const profileId = ch?.provider_profile_id || await z.findOrCreateProfile(ws.id, ws.name, ws.timezone);
    await db.from('channels').upsert(
      { workspace_id: ws.id, provider_profile_id: profileId, status: ch?.status === 'connected' ? 'connected' : 'pending', updated_at: new Date().toISOString() },
      { onConflict: 'workspace_id' },
    );
    return json({ authUrl: await z.connectUrl(profileId, redirectUrl) });
  }

  if (m === 'POST' && (p = match('v1/workspaces/:ext/channel/finish', parts))) {
    const ws = await workspaceOf(db, app, p.ext);
    const { data: ch } = await db.from('channels').select('*').eq('workspace_id', ws.id).maybeSingle();
    if (!ch?.provider_profile_id) throw new HttpError(409, 'connect_not_started', 'Comece pela conexão (channel/connect).');
    const accounts = await zernio().whatsappAccounts(ch.provider_profile_id);
    const wanted = str(b.accountId, 64);
    const acc = accounts.find((a) => a._id === wanted) || (!wanted ? accounts[0] : undefined);
    if (!acc) throw new HttpError(404, 'account_not_found', 'Número conectado não encontrado. Tente conectar de novo.');
    const { error } = await db.from('channels').update({
      provider_account_id: acc._id,
      phone_number: (acc.metadata as Record<string, unknown>)?.displayPhoneNumber || acc.username || null,
      display_name: acc.displayName || null,
      status: 'connected', connected_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).eq('workspace_id', ws.id);
    if (error) throw new HttpError(409, 'account_in_use', 'Este número já está ligado a outra empresa.');
    // Pacote de modelos padrão (vai para aprovação da Meta). Falha aqui não impede a conexão.
    const templates = await ensureStandardTemplates(zernio(), String(acc._id));
    if (templates.failed.length) console.warn('modelos padrão', ws.id, templates.failed);
    return json({ ok: true, templates });
  }

  // ---------- Conversas ----------
  if (m === 'GET' && (p = match('v1/workspaces/:ext/conversations', parts))) {
    const ws = await workspaceOf(db, app, p.ext);
    const url = new URL(req.url);
    let q = db.from('conversations').select(CONV_FIELDS).eq('workspace_id', ws.id)
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .limit(Math.min(Number(url.searchParams.get('limit')) || 50, 200));
    const before = url.searchParams.get('before');
    if (before) q = q.lt('last_message_at', before);
    const contactRef = url.searchParams.get('contact_ref');
    if (contactRef) {
      const { data: contacts } = await db.from('contacts').select('id').eq('workspace_id', ws.id).eq('external_ref', contactRef);
      q = q.in('contact_id', (contacts || []).map((c) => c.id).concat(['00000000-0000-0000-0000-000000000000']));
    }
    const { data, error } = await q;
    if (error) throw new HttpError(500, 'db_error', error.message);
    return json({ conversations: data });
  }

  if (m === 'GET' && (p = match('v1/conversations/:id', parts))) {
    const c = await conversationOf(db, app, p.id);
    return json({ conversation: { ...c, window_open: isWindowOpen(c.last_incoming_at) } });
  }

  if (m === 'GET' && (p = match('v1/conversations/:id/messages', parts))) {
    await conversationOf(db, app, p.id);
    const { data, error } = await db.from('messages').select(MSG_FIELDS).eq('conversation_id', p.id).order('sent_at', { ascending: true }).limit(500);
    if (error) throw new HttpError(500, 'db_error', error.message);
    return json({ messages: data });
  }

  if (m === 'POST' && (p = match('v1/conversations/:id/read', parts))) {
    await conversationOf(db, app, p.id);
    await db.from('conversations').update({ unread_count: 0 }).eq('id', p.id);
    return json({ ok: true });
  }

  // Pausar ou devolver a conversa para a IA (modo automático).
  if (m === 'POST' && (p = match('v1/conversations/:id/ai', parts))) {
    const c = await conversationOf(db, app, p.id);
    const pause = b.paused !== false;
    const hours = Math.min(Math.max(Number(b.hours) || 24, 1), 720);
    const { error } = await db.rpc('aura_pause_ai', { p_conversation_id: c.id, p_hours: pause ? hours : 0, p_reason: str(b.reason, 300) || 'Pausada pela equipe', p_notify: false });
    if (error) throw new HttpError(500, 'db_error', error.message);
    const { data } = await db.from('conversations').select('ai_paused_until, ai_pause_reason').eq('id', c.id).single();
    return json({ ai: data });
  }

  if (m === 'POST' && (p = match('v1/conversations/:id/suggest', parts))) {
    const c = await conversationOf(db, app, p.id);
    return json(await suggest(db, app, c));
  }

  if (m === 'POST' && (p = match('v1/conversations/:id/messages', parts))) {
    const c = await conversationOf(db, app, p.id);
    const text = str(b.text, 4000);
    if (!text) throw new HttpError(400, 'empty_text', 'Escreva a mensagem.');
    if (!isWindowOpen(c.last_incoming_at)) {
      throw new HttpError(409, 'window_closed', 'Passaram 24h desde a última mensagem do contato. Envie um modelo aprovado.');
    }
    const ch = await connectedChannel(db, c.workspace_id);
    const providerId = await zernio().sendText(c.provider_conversation_id, ch.provider_account_id, text);
    const { data: id, error } = await db.rpc('aura_record_outgoing', {
      p_conversation_id: c.id, p_provider_message_id: providerId, p_body: text, p_source: 'human', p_sent_by: str(b.sentBy, 120) || null,
    });
    if (error) throw new HttpError(500, 'db_error', error.message);
    // Uma pessoa respondeu: no modo automático a IA sai desta conversa por 12h (a equipe pode devolver antes).
    const { data: wsMode } = await db.from('workspaces').select('ai_mode').eq('id', c.workspace_id).single();
    if (wsMode?.ai_mode === 'auto') {
      await db.rpc('aura_pause_ai', { p_conversation_id: c.id, p_hours: 12, p_reason: 'Uma pessoa da equipe respondeu', p_notify: false });
    }
    // Mensagem que partiu de uma sugestão do copiloto: registra se foi usada igual ou editada.
    if (b.suggestionId) {
      await db.rpc('aura_mark_suggestion_used', { p_suggestion_id: str(b.suggestionId, 64), p_conversation_id: c.id, p_message_id: id, p_sent_text: text });
    }
    return json({ message: { id, status: 'sent', body: text } }, 201);
  }

  // ---------- Modelos aprovados ----------
  if (m === 'GET' && (p = match('v1/workspaces/:ext/templates', parts))) {
    const ws = await workspaceOf(db, app, p.ext);
    const ch = await connectedChannel(db, ws.id);
    const all = new URL(req.url).searchParams.get('status') === 'all';
    return json({ templates: await zernio().templates(ch.provider_account_id, !all) });
  }

  // Cria (de novo) os modelos padrão que faltam no número. Útil se a criação falhou na conexão.
  if (m === 'POST' && (p = match('v1/workspaces/:ext/templates/standard', parts))) {
    const ws = await workspaceOf(db, app, p.ext);
    const ch = await connectedChannel(db, ws.id);
    return json({ templates: await ensureStandardTemplates(zernio(), ch.provider_account_id) });
  }

  if (m === 'POST' && (p = match('v1/workspaces/:ext/templates/send', parts))) {
    const ws = await workspaceOf(db, app, p.ext);
    const ch = await connectedChannel(db, ws.id);
    const name = str(b.templateName, 120);
    if (!name) throw new HttpError(400, 'invalid_template', 'Informe o modelo.');
    const language = str(b.language, 20) || 'pt_BR';
    const params = ((b.params as unknown[]) || []).map((x) => str(x, 500));
    const preview = renderTemplate(str(b.templateBody, 2000) || `[modelo ${name}]`, params);
    const z = zernio();

    let conv: { id: string; provider_conversation_id: string } | null = null;
    if (b.conversationId) {
      conv = await conversationOf(db, app, str(b.conversationId, 64));
    } else {
      const key = phoneKey(b.phone);
      if (!key) throw new HttpError(400, 'invalid_phone', 'Telefone inválido. Use DDD + número.');
      const { data: contact } = await db.from('contacts').select('id').eq('workspace_id', ws.id).eq('phone_key', key).maybeSingle();
      if (contact) {
        const { data } = await db.from('conversations').select('id, provider_conversation_id').eq('contact_id', contact.id)
          .order('last_message_at', { ascending: false, nullsFirst: false }).limit(1).maybeSingle();
        conv = data;
      }
    }

    let providerMessageId: string | null;
    if (conv) {
      providerMessageId = await z.sendTemplateInConversation(conv.provider_conversation_id, ch.provider_account_id, name, language, params);
    } else {
      const phone = waNumber(b.phone);
      const opened = await z.openWithTemplate(ch.provider_account_id, phone, name, language, params);
      providerMessageId = opened.messageId;
      const ref = (b.contact || {}) as Record<string, unknown>;
      const { data: contact, error: cErr } = await db.from('contacts').upsert({
        workspace_id: ws.id, phone, phone_key: phoneKey(phone), name: str(ref.name, 120) || null,
        ...(ref.externalRef ? { external_type: str(ref.externalType, 40) || null, external_ref: str(ref.externalRef, 120) } : {}),
        updated_at: new Date().toISOString(),
      }, { onConflict: 'workspace_id,phone_key' }).select('id').single();
      if (cErr) throw new HttpError(500, 'db_error', cErr.message);
      const { data: created, error } = await db.from('conversations').upsert({
        workspace_id: ws.id, channel_id: ch.id, contact_id: contact.id, provider_conversation_id: opened.conversationId,
      }, { onConflict: 'workspace_id,provider_conversation_id' }).select('id, provider_conversation_id').single();
      if (error) throw new HttpError(500, 'db_error', error.message);
      conv = created;
    }
    const { data: messageId, error } = await db.rpc('aura_record_outgoing', {
      p_conversation_id: conv!.id, p_provider_message_id: providerMessageId, p_body: preview, p_source: 'template', p_sent_by: str(b.sentBy, 120) || null,
    });
    if (error) throw new HttpError(500, 'db_error', error.message);
    const { data: contactRow } = await db.from('conversations').select('contact_id').eq('id', conv!.id).single();
    return json({ conversationId: conv!.id, contactId: contactRow?.contact_id ?? null, message: { id: messageId, status: 'sent', body: preview } }, 201);
  }

  // ---------- Contato: o produto diz quem é (lead, paciente, cliente) ----------
  if (m === 'PATCH' && (p = match('v1/contacts/:id', parts))) {
    const { data: contact } = await db.from('contacts').select('id, workspace:workspaces!inner(app_id)').eq('id', p.id).maybeSingle();
    if (!contact || (contact.workspace as unknown as { app_id: string }).app_id !== app.id) {
      throw new HttpError(404, 'contact_not_found', 'Contato não encontrado.');
    }
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if ('name' in b) patch.name = str(b.name, 120) || null;
    if ('externalType' in b) patch.external_type = str(b.externalType, 40) || null;
    if ('externalRef' in b) patch.external_ref = str(b.externalRef, 120) || null;
    const { data, error } = await db.from('contacts').update(patch).eq('id', p.id).select('id, phone, name, external_type, external_ref').single();
    if (error) throw new HttpError(500, 'db_error', error.message);
    return json({ contact: data });
  }

  throw new HttpError(404, 'not_found', 'Rota não encontrada.');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
    return await route(req, db);
  } catch (err) {
    return errorResponse(err);
  }
});
