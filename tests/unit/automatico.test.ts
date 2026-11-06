import { describe, expect, it } from 'vitest';
import { generateWithTools, type Clients } from '../../supabase/functions/_shared/llm.ts';
import { AUTO_FALLBACK, AUTO_TOOLS, decideReply, localDate, slotLabel, toolExecutor, type TurnState } from '../../supabase/functions/_shared/auto.ts';
import { unsupportedMoney } from '../../supabase/functions/_shared/safety.ts';
import type { ProductClient } from '../../supabase/functions/_shared/product.ts';

const contact = { type: 'lead', ref: 'lead-1', phone: '5511999990000', name: 'Sebastião' };

function fakeProduct(over: Partial<Record<string, unknown>> = {}): ProductClient {
  const calls: Array<[string, unknown]> = [];
  const p = {
    calls,
    availability: async (q: unknown) => { calls.push(['availability', q]); return { status: 'ok', data: { slots: [
      { start: '2026-11-09T14:00:00-03:00', end: '2026-11-09T15:00:00-03:00', professionalId: 'pro-1', professionalName: 'Dra. Carla' },
    ] } }; },
    createBooking: async (b: unknown) => { calls.push(['createBooking', b]); return { status: 'ok', data: { booking: {
      id: 'bk-1', start: '2026-11-09T14:00:00-03:00', status: 'scheduled', serviceName: 'Limpeza de pele', professionalName: 'Dra. Carla',
    } } }; },
    listBookings: async () => ({ status: 'ok', data: { bookings: [] } }),
    cancelBooking: async () => ({ status: 'error', error: 'x' }),
    ...over,
  };
  return p as unknown as ProductClient;
}

describe('datas e horários', () => {
  it('rótulo em português no fuso de Brasília', () => {
    expect(slotLabel('2026-11-09T17:00:00Z')).toBe('segunda-feira, 09/11 às 14:00');
    expect(localDate(new Date('2026-11-07T02:00:00Z'))).toBe('2026-11-06');
  });
});

describe('ferramentas da agenda', () => {
  it('consulta horários e mostra rótulo, início e profissional', async () => {
    const product = fakeProduct();
    const exec = toolExecutor(product, contact, 'conv-1', {}, () => new Date('2026-11-06T15:00:00Z'));
    const out = await exec('verificar_horarios', { servico_id: 'svc-1', data_inicio: '2026-11-01', data_fim: '2026-11-10' });
    expect(out).toContain('rótulo: segunda-feira, 09/11 às 14:00 com Dra. Carla');
    expect(out).toContain('inicio: 2026-11-09T14:00:00-03:00 | profissional_id: pro-1');
    // Data no passado vira hoje.
    expect((product as unknown as { calls: Array<[string, { from: string }]> }).calls[0][1].from).toBe('2026-11-06');
  });

  it('agenda com chave de repetição e guarda o resultado', async () => {
    const product = fakeProduct();
    const state: TurnState = {};
    const exec = toolExecutor(product, contact, 'conv-1', state);
    const out = await exec('agendar', { servico_id: 'svc-1', inicio: '2026-11-09T14:00:00-03:00', profissional_id: 'pro-1', nome_cliente: 'Sebastião Silva' });
    expect(out).toContain('Agendado com sucesso');
    expect(state.booked?.id).toBe('bk-1');
    const sent = (product as unknown as { calls: Array<[string, Record<string, unknown>]> }).calls[0][1];
    expect(sent.idempotencyKey).toBe('conv-1:svc-1:2026-11-09T14:00:00-03:00');
    expect(sent.contact).toMatchObject({ ref: 'lead-1', name: 'Sebastião Silva' });
    // Segunda chamada na mesma conversa não marca de novo.
    expect(await exec('agendar', { servico_id: 'svc-1', inicio: 'x', profissional_id: 'pro-1', nome_cliente: 'S' })).toContain('Já foi agendado');
  });

  it('horário ocupado pede nova consulta; datas inválidas são recusadas', async () => {
    const product = fakeProduct({ createBooking: async () => ({ status: 'error', error: '409', code: 'slot_unavailable' }) });
    const exec = toolExecutor(product, contact, 'conv-1', {});
    expect(await exec('agendar', { servico_id: 's', inicio: 'i', profissional_id: 'p', nome_cliente: 'n' })).toContain('não está mais livre');
    expect(await exec('verificar_horarios', { servico_id: 's', data_inicio: 'amanhã', data_fim: 'x' })).toContain('AAAA-MM-DD');
  });

  it('passar para a equipe marca o pedido de ajuda', async () => {
    const state: TurnState = {};
    await toolExecutor(fakeProduct(), contact, 'c', state)('passar_para_equipe', { motivo: 'Reclamação' });
    expect(state.handoff).toBe('Reclamação');
  });
});

describe('decisão do que enviar', () => {
  const sources = ['Limpeza de pele: R$ 180,00'];
  it('envia a resposta quando está tudo certo', () => {
    const d = decideReply({ draft: 'A limpeza custa R$ 180. Quer marcar?', incoming: 'quanto custa?', sources, calls: [], state: {} });
    expect(d).toMatchObject({ outcome: 'sent', handoff: false, text: 'A limpeza custa R$ 180. Quer marcar?' });
  });

  it('preço inventado vira mensagem segura e chama a equipe', () => {
    const d = decideReply({ draft: 'O botox fica R$ 900.', incoming: 'botox?', sources, calls: [], state: {} });
    expect(d).toMatchObject({ outcome: 'fallback', handoff: true, text: AUTO_FALLBACK });
    expect(d.flags).toContain('unsupported_money');
  });

  it('dizer que agendou sem a agenda confirmar é barrado; com a agenda confirmando, passa', () => {
    expect(decideReply({ draft: 'Pronto, agendei para segunda!', incoming: 'sim', sources, calls: [], state: {} }).outcome).toBe('fallback');
    const booked = decideReply({
      draft: 'Pronto, agendei: segunda-feira, 09/11 às 14:00 com a Dra. Carla.', incoming: 'sim', sources,
      calls: [{ name: 'agendar', input: {}, output: 'Agendado com sucesso: Limpeza · segunda-feira, 09/11 às 14:00 com Dra. Carla' }],
      state: { booked: { id: 'bk', start: '2026-11-09T14:00:00-03:00', status: 'scheduled' } },
    });
    expect(booked.outcome).toBe('sent');
  });

  it('orientação médica é barrada; pedido de pessoa chama a equipe', () => {
    expect(decideReply({ draft: 'Pode tomar um anti-inflamatório.', incoming: 'dói', sources, calls: [], state: {} }).outcome).toBe('fallback');
    const human = decideReply({ draft: 'Claro, vou chamar alguém da equipe.', incoming: 'quero falar com uma pessoa', sources, calls: [], state: {} });
    expect(human).toMatchObject({ outcome: 'sent', handoff: true });
  });

  it('valores em reais conferidos contra as fontes', () => {
    expect(unsupportedMoney('Fica R$ 1.200,00', ['a partir de R$ 1.200,00'])).toEqual([]);
    expect(unsupportedMoney('Fica R$ 1.100', ['R$ 1.200'])).toEqual(['1100']);
  });
});

describe('IA com ferramentas', () => {
  it('Claude: executa a ferramenta, devolve o resultado e soma os tokens', async () => {
    const sent: Array<Record<string, unknown>> = [];
    let step = 0;
    const clients: Clients = { anthropic: { messages: { create: async (p) => {
      sent.push(JSON.parse(JSON.stringify(p)));
      step++;
      if (step === 1) return { content: [{ type: 'tool_use', id: 't1', name: 'verificar_horarios', input: { servico_id: 's' } }], stop_reason: 'tool_use', usage: { input_tokens: 100, output_tokens: 10 } };
      return { content: [{ type: 'text', text: 'Temos segunda às 14h.' }], stop_reason: 'end_turn', usage: { input_tokens: 150, output_tokens: 20, cache_read_input_tokens: 50 } };
    } } } };
    const r = await generateWithTools(clients, {
      provider: 'anthropic', model: 'claude-sonnet-5-5', system: 's', messages: [{ role: 'user', content: 'tem horário?' }],
      tools: AUTO_TOOLS, execute: async (name) => `resultado de ${name}`,
    });
    expect(r).toMatchObject({ text: 'Temos segunda às 14h.', outcome: 'ok', inputTokens: 300, cachedTokens: 50, outputTokens: 30 });
    expect(r.calls).toEqual([{ name: 'verificar_horarios', input: { servico_id: 's' }, output: 'resultado de verificar_horarios' }]);
    const second = sent[1].messages as Array<{ role: string; content: unknown }>;
    expect(second[2]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'resultado de verificar_horarios' }] });
    expect((sent[0].tools as Array<{ name: string }>).map((t) => t.name)).toContain('agendar');
  });

  it('OpenAI: chamada de função e resposta final', async () => {
    let step = 0;
    let lastInput: unknown[] = [];
    const clients: Clients = { openai: { responses: { create: async (p) => {
      step++; lastInput = p.input as unknown[];
      if (step === 1) return { output: [{ type: 'function_call', call_id: 'c1', name: 'meus_agendamentos', arguments: '{}' }], usage: { input_tokens: 80, output_tokens: 5 } };
      return { output: [], output_text: 'Você não tem horários marcados.', usage: { input_tokens: 90, output_tokens: 8 } };
    } } } };
    const r = await generateWithTools(clients, {
      provider: 'openai', model: 'gpt-6.1-terra', system: 's', messages: [{ role: 'user', content: 'tenho horário?' }],
      tools: AUTO_TOOLS, execute: async () => 'nenhum',
    });
    expect(r).toMatchObject({ text: 'Você não tem horários marcados.', inputTokens: 170, outputTokens: 13 });
    expect(lastInput[lastInput.length - 1]).toEqual({ type: 'function_call_output', call_id: 'c1', output: 'nenhum' });
  });

  it('para depois de etapas demais', async () => {
    const clients: Clients = { anthropic: { messages: { create: async () => ({
      content: [{ type: 'tool_use', id: 't', name: 'meus_agendamentos', input: {} }], stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 },
    }) } } };
    const r = await generateWithTools(clients, { provider: 'anthropic', model: 'm', system: 's', messages: [], tools: AUTO_TOOLS, execute: async () => 'x', maxSteps: 2 });
    expect(r.outcome).toBe('error');
    expect(r.calls).toHaveLength(2);
  });
});
