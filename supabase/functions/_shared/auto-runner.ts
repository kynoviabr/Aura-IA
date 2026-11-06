// Só roda no Deno (imports npm:); fora do typecheck do Node (ver tsconfig.json). Tipos conferidos em check:functions.
/**
 * Resposta automática: chamada quando chega mensagem de cliente numa empresa com a IA no modo automático.
 * Espera alguns segundos (o cliente costuma mandar várias mensagens seguidas), pega a vez na conversa,
 * responde, e repete se chegou mensagem nova enquanto respondia.
 */
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';
import { aiClients } from './ai-clients.ts';
import { generateWithTools } from './llm.ts';
import { ProductClient, type ProductContact } from './product.ts';
import { businessContext, conversationMessages, pendingIncoming, todayText, type HistoryMessage } from './copilot.ts';
import { inspectIncoming } from './safety.ts';
import { AUTO_TOOLS, AUTO_URGENT, autoSystem, decideReply, TIMEZONE, toolExecutor, type TurnState } from './auto.ts';
import { ZernioClient } from './zernio.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Conv = {
  id: string; workspace_id: string; provider_conversation_id: string; ai_paused_until: string | null;
  contact: { id: string; phone: string; name: string | null; external_type: string | null; external_ref: string | null } | null;
  workspace: { id: string; external_id: string; timezone: string; ai_mode: string; app_id: string };
};

async function loadConv(db: SupabaseClient, id: string): Promise<Conv | null> {
  const { data } = await db.from('conversations')
    .select('id, workspace_id, provider_conversation_id, ai_paused_until, contact:contacts(id, phone, name, external_type, external_ref), workspace:workspaces!inner(id, external_id, timezone, ai_mode, app_id)')
    .eq('id', id).maybeSingle();
  return data as unknown as Conv | null;
}

const paused = (c: Conv) => !!c.ai_paused_until && new Date(c.ai_paused_until).getTime() > Date.now();

export async function autoReply(db: SupabaseClient, conversationId: string, debounceMs = 4000): Promise<void> {
  const first = await loadConv(db, conversationId);
  if (!first || first.workspace.ai_mode !== 'auto' || paused(first)) return;
  await sleep(debounceMs);
  const { data: claimed } = await db.rpc('aura_claim_ai_turn', { p_conversation_id: conversationId });
  if (!claimed) return; // outra resposta já está em andamento e vai incluir esta mensagem
  try {
    for (let round = 0; round < 3; round++) {
      const conv = await loadConv(db, conversationId);
      if (!conv || conv.workspace.ai_mode !== 'auto' || paused(conv)) return;
      const { data: msgs } = await db.from('messages').select('id, direction, body, attachments, sent_at')
        .eq('conversation_id', conversationId).order('sent_at', { ascending: false }).limit(30);
      const history = ((msgs || []) as Array<HistoryMessage & { id: string }>).reverse();
      const last = history[history.length - 1];
      if (!last || last.direction !== 'incoming') return; // já respondida (por pessoa ou pela IA)
      await runTurn(db, conv, history);
      // Chegou mensagem nova enquanto a IA respondia? Responde de novo.
      const { data: newer } = await db.from('messages').select('id').eq('conversation_id', conversationId)
        .eq('direction', 'incoming').gt('sent_at', last.sent_at).limit(1);
      if (!newer?.length) return;
    }
  } catch (e) {
    console.error('auto_reply', conversationId, (e as Error).message);
  } finally {
    await db.rpc('aura_release_ai_turn', { p_conversation_id: conversationId });
  }
}

async function runTurn(db: SupabaseClient, conv: Conv, history: HistoryMessage[]) {
  const started = Date.now();
  const turn: Record<string, unknown> = { workspace_id: conv.workspace_id, conversation_id: conv.id };
  const saveTurn = async (row: Record<string, unknown>) => {
    await db.from('ai_turns').insert({ ...turn, ...row, latency_ms: Date.now() - started });
  };

  const { data: allowed } = await db.rpc('aura_ai_allowed', { p_workspace_id: conv.workspace_id });
  const [{ data: setting }, { data: appRow }, { data: channel }] = await Promise.all([
    db.from('platform_settings').select('value').eq('key', 'auto_model').maybeSingle(),
    db.from('apps').select('api_base_url, webhook_secret').eq('id', conv.workspace.app_id).single(),
    db.from('channels').select('provider_account_id, status').eq('workspace_id', conv.workspace_id).maybeSingle(),
  ]);
  const cfg = (setting?.value || {}) as { provider?: 'anthropic' | 'openai'; model?: string };
  const provider = cfg.provider === 'openai' ? 'openai' : 'anthropic';
  const model = cfg.model || 'claude-sonnet-5-5';
  Object.assign(turn, { provider, model });

  if (!allowed) return saveTurn({ outcome: 'skipped', error: 'Empresa sem créditos de IA' });
  if (!channel?.provider_account_id || channel.status !== 'connected') return saveTurn({ outcome: 'skipped', error: 'WhatsApp desconectado' });
  if (!appRow?.api_base_url || !appRow.webhook_secret) return saveTurn({ outcome: 'skipped', error: 'Produto sem API padrão configurada' });
  const { data: prov } = await db.from('ai_providers').select('enabled').eq('provider', provider).maybeSingle();
  if (!prov?.enabled) return saveTurn({ outcome: 'skipped', error: 'Provedor de IA desligado' });

  const zernio = new ZernioClient((Deno.env.get('ZERNIO_API_KEY') || '').trim());
  const send = async (text: string) => {
    const providerId = await zernio.sendText(conv.provider_conversation_id, channel.provider_account_id, text);
    const { data: id } = await db.rpc('aura_record_ai_message', { p_conversation_id: conv.id, p_provider_message_id: providerId, p_body: text });
    return id as string | null;
  };
  const pause = (reason: string) => db.rpc('aura_pause_ai', { p_conversation_id: conv.id, p_hours: 24, p_reason: reason, p_notify: true });

  const incoming = pendingIncoming(history);
  // Possível urgência de saúde: não passa pela IA. Mensagem fixa e equipe avisada.
  if (inspectIncoming(incoming).includes('urgent')) {
    const id = await send(AUTO_URGENT);
    await pause('Possível urgência de saúde');
    return saveTurn({ outcome: 'fallback', handoff: true, sent_text: AUTO_URGENT, sent_message_id: id, flags: ['urgent'] });
  }

  const product = new ProductClient(appRow.api_base_url, appRow.webhook_secret, conv.workspace.external_id);
  const [catalog, info] = await Promise.all([product.catalog(), product.businessInfo()]);
  const context = businessContext(catalog.status === 'ok' ? catalog.data : null, info.status === 'ok' ? info.data : null, { withIds: true });
  const timezone = conv.workspace.timezone || TIMEZONE;
  const today = todayText(new Date(), timezone);
  const contact: ProductContact = {
    type: conv.contact?.external_type, ref: conv.contact?.external_ref, phone: conv.contact?.phone || '', name: conv.contact?.name,
  };
  const state: TurnState = {};

  const r = await generateWithTools(await aiClients(db), {
    provider, model, system: autoSystem(context, today), messages: conversationMessages(history),
    tools: AUTO_TOOLS, execute: toolExecutor(product, contact, conv.id, state), maxTokens: 1024, effort: 'low', maxSteps: 6,
  });
  const tools = r.calls.map((c) => ({ name: c.name, input: c.input, summary: c.output.slice(0, 400) }));
  const { data: usage } = await db.rpc('aura_record_ai_usage', {
    p_workspace_id: conv.workspace_id, p_conversation_id: conv.id, p_feature: 'auto', p_provider: provider, p_model: model,
    p_input: r.inputTokens, p_cached: r.cachedTokens, p_output: r.outputTokens, p_latency_ms: r.latencyMs,
    p_outcome: r.outcome === 'ok' ? 'ok' : r.outcome, p_error_code: r.error ? r.error.slice(0, 120) : null,
  });
  turn.usage_id = (usage as { usage_id?: string } | null)?.usage_id ?? null;
  const bookingId = state.booked?.id || state.cancelled?.id || null;

  if (r.outcome !== 'ok') {
    // A IA falhou: não deixa o cliente sem resposta se algo já foi marcado; senão só avisa a equipe.
    await pause(`A IA não conseguiu responder (${r.error || r.outcome})`);
    return saveTurn({ outcome: 'error', handoff: true, tools, error: r.error || r.outcome, booking_id: bookingId });
  }

  const d = decideReply({ draft: r.text, incoming, sources: [context, today, ...history.map((m) => String(m.body || ''))], calls: r.calls, state });
  const id = await send(d.text);
  if (d.handoff) await pause(d.reason || 'A IA pediu ajuda da equipe');
  return saveTurn({
    outcome: d.outcome, handoff: d.handoff, tools, draft: r.text, sent_text: d.text, sent_message_id: id,
    flags: d.flags, booking_id: bookingId, error: d.outcome === 'fallback' ? d.reason : null,
  });
}
