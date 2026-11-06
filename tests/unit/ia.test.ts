import { describe, expect, it } from 'vitest';
import { generate, type Clients } from '../../supabase/functions/_shared/llm.ts';
import { EVAL_PAIRS, evalJobs, runJobs, SCENARIOS } from '../../supabase/functions/_shared/eval.ts';

const clock = () => { let t = 1000; return () => (t += 250); };

describe('adaptador de IA', () => {
  it('Claude: junta o texto, soma o cache na entrada e usa esforço baixo', async () => {
    let params: Record<string, unknown> = {};
    const clients: Clients = { anthropic: { messages: { create: async (p) => { params = p; return {
      content: [{ type: 'thinking', text: '' }, { type: 'text', text: ' Olá! ' }], stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 30, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 },
    }; } } } };
    const r = await generate(clients, { provider: 'anthropic', model: 'claude-haiku-5-5', system: 's', messages: [{ role: 'user', content: 'oi' }], effort: 'low' }, clock());
    expect(r).toMatchObject({ text: 'Olá!', outcome: 'ok', inputTokens: 1000, cachedTokens: 900, outputTokens: 30, latencyMs: 250 });
    expect(params).toMatchObject({ model: 'claude-haiku-5-5', output_config: { effort: 'low' } });
    expect((params.system as Array<{ cache_control: unknown }>)[0].cache_control).toEqual({ type: 'ephemeral' });
  });
  it('Claude: recusa vira outcome refused', async () => {
    const clients: Clients = { anthropic: { messages: { create: async () => ({ content: [], stop_reason: 'refusal', usage: { input_tokens: 10, output_tokens: 0 } }) } } };
    expect((await generate(clients, { provider: 'anthropic', model: 'm', system: 's', messages: [] })).outcome).toBe('refused');
  });
  it('OpenAI: lê output_text e o uso', async () => {
    const clients: Clients = { openai: { responses: { create: async () => ({ output_text: 'Oi!', usage: { input_tokens: 500, output_tokens: 20, input_tokens_details: { cached_tokens: 300 } } }) } } };
    const r = await generate(clients, { provider: 'openai', model: 'gpt-6-luna', system: 's', messages: [{ role: 'user', content: 'oi' }] });
    expect(r).toMatchObject({ text: 'Oi!', outcome: 'ok', inputTokens: 500, cachedTokens: 300, outputTokens: 20 });
  });
  it('erro do provedor ou chave ausente não derruba: vira outcome error', async () => {
    const clients: Clients = { openai: { responses: { create: async () => { throw Object.assign(new Error('Incorrect API key'), { status: 401 }); } } } };
    expect(await generate(clients, { provider: 'openai', model: 'x', system: 's', messages: [] })).toMatchObject({ outcome: 'error', error: 'HTTP 401: Incorrect API key' });
    expect((await generate({}, { provider: 'anthropic', model: 'x', system: 's', messages: [] })).error).toContain('Claude');
  });
});

describe('prova lado a lado', () => {
  it('cenários bem formados e únicos', () => {
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(20);
    expect(new Set(SCENARIOS.map((s) => s.id)).size).toBe(SCENARIOS.length);
    for (const s of SCENARIOS) {
      expect(s.messages.at(-1)?.role).toBe('user');
      expect(s.expectation.length).toBeGreaterThan(10);
    }
  });
  it('roda todas as combinações respeitando o limite de chamadas simultâneas', async () => {
    const jobs = evalJobs(EVAL_PAIRS.copilot.models);
    expect(jobs.length).toBe(SCENARIOS.length * 2);
    let active = 0; let peak = 0; const saved: string[] = [];
    const slow = async <T>(v: T) => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 2)); active--; return v; };
    const clients: Clients = {
      anthropic: { messages: { create: async () => slow({ content: [{ type: 'text', text: 'a' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }) } },
      openai: { responses: { create: async () => slow({ output_text: 'b', usage: { input_tokens: 1, output_tokens: 1 } }) } },
    };
    await runJobs(jobs, clients, async (job, r) => { saved.push(`${job.scenario.id}:${job.model.model}:${r.text}`); }, 4);
    expect(saved.length).toBe(jobs.length);
    expect(peak).toBeLessThanOrEqual(4);
  });
});
