/**
 * Adaptador único para os provedores de IA (Claude e OpenAI).
 * O resto da Aura chama generate() e recebe sempre o mesmo formato, com tokens e tempo para cobrar e medir.
 * Os clientes (SDK oficial de cada provedor) são passados de fora: assim dá para testar com dublês.
 */

export type ChatMessage = { role: 'user' | 'assistant'; content: string };

export type GenerateInput = {
  provider: 'anthropic' | 'openai';
  model: string;
  system: string;
  messages: ChatMessage[];
  maxTokens?: number;
  /** Esforço de raciocínio: baixo para respostas curtas de atendimento. */
  effort?: 'low' | 'medium' | 'high';
};

export type GenerateResult = {
  text: string;
  outcome: 'ok' | 'error' | 'refused';
  error?: string;
  /** Total de tokens de entrada, incluindo os lidos do cache. */
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  latencyMs: number;
};

// Formas mínimas dos SDKs que usamos (o resto do SDK não importa aqui).
export type AnthropicLike = {
  messages: { create: (params: Record<string, unknown>) => Promise<{
    content: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
    stop_reason: string | null;
    usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null };
  }> };
};
export type OpenAILike = {
  responses: { create: (params: Record<string, unknown>) => Promise<{
    output_text?: string;
    status?: string;
    output?: Array<{ type: string; call_id?: string; name?: string; arguments?: string }>;
    usage?: { input_tokens: number; output_tokens: number; input_tokens_details?: { cached_tokens?: number } };
  }> };
};

export type Clients = { anthropic?: AnthropicLike; openai?: OpenAILike };

function errorText(e: unknown): string {
  const err = e as { status?: number; message?: string; error?: { message?: string } };
  const msg = err?.error?.message || err?.message || String(e);
  return err?.status ? `HTTP ${err.status}: ${msg}` : msg;
}

export async function generate(clients: Clients, input: GenerateInput, now: () => number = Date.now): Promise<GenerateResult> {
  const start = now();
  const base = { inputTokens: 0, cachedTokens: 0, outputTokens: 0 };
  try {
    if (input.provider === 'anthropic') {
      if (!clients.anthropic) throw new Error('Chave do Claude não cadastrada.');
      const res = await clients.anthropic.messages.create({
        model: input.model,
        max_tokens: input.maxTokens ?? 2048,
        // Instruções fixas com cache: o custo da parte repetida cai em pedidos seguidos.
        system: [{ type: 'text', text: input.system, cache_control: { type: 'ephemeral' } }],
        messages: input.messages,
        ...(input.effort ? { output_config: { effort: input.effort } } : {}),
      });
      const u = res.usage;
      const cached = Number(u.cache_read_input_tokens || 0);
      const created = Number(u.cache_creation_input_tokens || 0);
      const usage = { inputTokens: u.input_tokens + cached + created, cachedTokens: cached, outputTokens: u.output_tokens, latencyMs: now() - start };
      // Recusa do filtro de segurança: vem com HTTP 200 e stop_reason "refusal".
      if (res.stop_reason === 'refusal') return { text: '', outcome: 'refused', error: 'O modelo recusou responder.', ...usage };
      const text = res.content.filter((b) => b.type === 'text').map((b) => b.text || '').join('').trim();
      return { text, outcome: 'ok', ...usage };
    }
    if (!clients.openai) throw new Error('Chave da OpenAI não cadastrada.');
    const res = await clients.openai.responses.create({
      model: input.model,
      instructions: input.system,
      input: input.messages.map((m) => ({ role: m.role, content: m.content })),
      max_output_tokens: input.maxTokens ?? 2048,
      ...(input.effort ? { reasoning: { effort: input.effort } } : {}),
    });
    const u = res.usage || { input_tokens: 0, output_tokens: 0 };
    return {
      text: String(res.output_text || '').trim(),
      outcome: 'ok',
      inputTokens: u.input_tokens,
      cachedTokens: Number(u.input_tokens_details?.cached_tokens || 0),
      outputTokens: u.output_tokens,
      latencyMs: now() - start,
    };
  } catch (e) {
    return { text: '', outcome: 'error', error: errorText(e).slice(0, 500), ...base, latencyMs: now() - start };
  }
}

// ---------- IA com ferramentas (atendimento automático) ----------

export type ToolSpec = { name: string; description: string; parameters: Record<string, unknown> };
export type ToolCall = { name: string; input: Record<string, unknown>; output: string };

export type ToolsInput = GenerateInput & {
  tools: ToolSpec[];
  /** Executa a ferramenta e devolve o texto que a IA vai ler. Nunca deve lançar erro. */
  execute: (name: string, input: Record<string, unknown>) => Promise<string>;
  maxSteps?: number;
};

export type ToolsResult = GenerateResult & { calls: ToolCall[] };

function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  try { return JSON.parse(String(raw || '{}')); } catch { return {}; }
}

/**
 * Conversa com a IA deixando ela usar ferramentas (consultar horários, marcar...) até chegar na resposta final.
 * Soma os tokens de todas as etapas para cobrar certo.
 */
export async function generateWithTools(clients: Clients, input: ToolsInput, now: () => number = Date.now): Promise<ToolsResult> {
  const start = now();
  const calls: ToolCall[] = [];
  const usage = { inputTokens: 0, cachedTokens: 0, outputTokens: 0 };
  const maxSteps = input.maxSteps ?? 6;
  try {
    if (input.provider === 'anthropic') {
      if (!clients.anthropic) throw new Error('Chave do Claude não cadastrada.');
      const messages: Array<Record<string, unknown>> = input.messages.map((m) => ({ role: m.role, content: m.content }));
      const tools = input.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
      for (let step = 0; step < maxSteps; step++) {
        const res = await clients.anthropic.messages.create({
          model: input.model,
          max_tokens: input.maxTokens ?? 2048,
          system: [{ type: 'text', text: input.system, cache_control: { type: 'ephemeral' } }],
          tools,
          messages,
          ...(input.effort ? { output_config: { effort: input.effort } } : {}),
        });
        const u = res.usage;
        const cached = Number(u.cache_read_input_tokens || 0);
        usage.inputTokens += u.input_tokens + cached + Number(u.cache_creation_input_tokens || 0);
        usage.cachedTokens += cached;
        usage.outputTokens += u.output_tokens;
        if (res.stop_reason === 'refusal') return { text: '', outcome: 'refused', error: 'O modelo recusou responder.', ...usage, latencyMs: now() - start, calls };
        const uses = res.content.filter((b) => b.type === 'tool_use');
        if (res.stop_reason !== 'tool_use' || !uses.length) {
          const text = res.content.filter((b) => b.type === 'text').map((b) => b.text || '').join('').trim();
          return { text, outcome: 'ok', ...usage, latencyMs: now() - start, calls };
        }
        messages.push({ role: 'assistant', content: res.content });
        const results = [];
        for (const b of uses) {
          const args = parseArgs(b.input);
          const output = await input.execute(String(b.name), args);
          calls.push({ name: String(b.name), input: args, output });
          results.push({ type: 'tool_result', tool_use_id: b.id, content: output });
        }
        messages.push({ role: 'user', content: results });
      }
      throw new Error('A IA usou ferramentas demais sem concluir.');
    }

    if (!clients.openai) throw new Error('Chave da OpenAI não cadastrada.');
    const items: Array<Record<string, unknown>> = input.messages.map((m) => ({ role: m.role, content: m.content }));
    const tools = input.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters }));
    for (let step = 0; step < maxSteps; step++) {
      const res = await clients.openai.responses.create({
        model: input.model,
        instructions: input.system,
        input: items,
        tools,
        max_output_tokens: input.maxTokens ?? 2048,
        ...(input.effort ? { reasoning: { effort: input.effort } } : {}),
      });
      const u = res.usage || { input_tokens: 0, output_tokens: 0 };
      usage.inputTokens += u.input_tokens;
      usage.cachedTokens += Number(u.input_tokens_details?.cached_tokens || 0);
      usage.outputTokens += u.output_tokens;
      const fnCalls = (res.output || []).filter((o) => o.type === 'function_call');
      if (!fnCalls.length) return { text: String(res.output_text || '').trim(), outcome: 'ok', ...usage, latencyMs: now() - start, calls };
      items.push(...(res.output || []) as Array<Record<string, unknown>>);
      for (const c of fnCalls) {
        const args = parseArgs(c.arguments);
        const output = await input.execute(String(c.name), args);
        calls.push({ name: String(c.name), input: args, output });
        items.push({ type: 'function_call_output', call_id: c.call_id, output });
      }
    }
    throw new Error('A IA usou ferramentas demais sem concluir.');
  } catch (e) {
    return { text: '', outcome: 'error', error: errorText(e).slice(0, 500), ...usage, latencyMs: now() - start, calls };
  }
}
