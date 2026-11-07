import { describe, expect, it } from 'vitest';
import { businessContext, hoursText } from '../../supabase/functions/_shared/copilot.ts';
import { groupSlots, toolExecutor } from '../../supabase/functions/_shared/auto.ts';
import type { ProductClient } from '../../supabase/functions/_shared/product.ts';

describe('dados organizados da empresa', () => {
  it('horário agrupa dias iguais', () => {
    const h = [1, 2, 3, 4, 5].map((day) => ({ day, opens: '09:00', closes: '19:00' })).concat([{ day: 6, opens: '09:00', closes: '13:00' }]);
    expect(hoursText(h)).toBe('segunda a sexta: 09:00–19:00; sábado: 09:00–13:00; domingo: fechado');
  });

  it('monta o texto com pagamento, estacionamento, planos, avaliação e profissionais', () => {
    const t = businessContext(
      { services: [
        { id: 'evaluation', kind: 'evaluation', name: 'Avaliação', price: 0, durationMinutes: 30 },
        { id: 't1', name: 'Botox', price: 1200, priceDisplay: 'from', requiresEvaluation: true },
        { id: 't2', name: 'Limpeza de pele', price: 180, priceDisplay: 'exact', professionals: ['Dra. Rafaela'] },
        { id: 't3', name: 'Laser', price: 300, aiBookable: false },
      ] },
      {
        name: 'Clínica Aura',
        hours: [{ day: 1, opens: '09:00', closes: '19:00' }],
        closures: [{ date: '2026-12-25', reason: 'Natal' }],
        payment: { methods: ['pix', 'credito'], maxInstallments: 10, installmentsMinValue: 1000 },
        parking: { type: 'partner', notes: 'no prédio' },
        insurance: { accepts: false, plans: [] },
        evaluation: { offered: true, free: true, durationMinutes: 30 },
        scheduling: { rescheduleNoticeHours: 24 },
        professionals: [{ name: 'Dra. Rafaela', specialty: 'Biomédica', services: ['Limpeza de pele'] }],
      },
      { withIds: true },
    );
    expect(t).toContain('Horário de funcionamento da empresa: segunda: 09:00–19:00; terça a domingo: fechado');
    expect(t).toContain('Dias fechados: 25/12 (Natal)');
    expect(t).toContain('Formas de pagamento: Pix, cartão de crédito; crédito em até 10x (para valores a partir de R$ 1.000,00)');
    expect(t).toContain('Estacionamento: estacionamento conveniado — no prédio');
    expect(t).toContain('Planos/convênios: não aceita (atendimento particular)');
    expect(t).toContain('Avaliação: gratuita, 30 min.');
    expect(t).toContain('Remarcação: avisar com 24h de antecedência.');
    expect(t).toContain('- Dra. Rafaela (Biomédica): faz Limpeza de pele');
    expect(t).toContain('- Avaliação [servico_id: evaluation]: gratuita');
    expect(t).toContain('Botox [servico_id: t1]: a partir de R$ 1.200,00 (valor final após avaliação) · começa com uma avaliação');
    expect(t).toContain('Limpeza de pele [servico_id: t2]: R$ 180,00 · com Dra. Rafaela');
    expect(t).toContain('Laser [servico_id: t3]: R$ 300,00 · agendamento só com a equipe');
  });

  it('texto livre antigo continua funcionando', () => {
    expect(businessContext(null, { hours: 'seg a sex 9h às 19h', payment: 'Pix', parking: 'Conveniado' }))
      .toBe('Horário de funcionamento: seg a sex 9h às 19h\nEstacionamento: Conveniado\nFormas de pagamento: Pix');
  });
});

describe('agenda com profissional', () => {
  it('mostra o nome; sem nome, "nossa equipe"', () => {
    const out = groupSlots([
      { start: '2026-11-12T13:00:00-03:00', end: '', professionalId: 'p1', professionalName: 'Dra. Rafaela' },
      { start: '2026-11-12T13:00:00-03:00', end: '', professionalId: 'p2', professionalName: null },
    ], 'Horários');
    expect(out).toContain('com Dra. Rafaela (profissional_id: p1): 13:00');
    expect(out).toContain('com nossa equipe (sem nome) (profissional_id: p2): 13:00');
  });

  const contact = { phone: '5511999990000' };
  const product = (over: Record<string, unknown>) => over as unknown as ProductClient;

  it('serviço que começa com avaliação e serviço sem profissional', async () => {
    const evalOnly = product({ availability: async () => ({ status: 'error', error: '409', code: 'requires_evaluation' }) });
    expect(await toolExecutor(evalOnly, contact, 'c', {})('verificar_horarios', { servico_id: 't1', data_inicio: '2026-11-12', data_fim: '2026-11-12' }))
      .toContain('começa com uma avaliação');
    const noPro = product({ availability: async () => ({ status: 'ok', data: { slots: [], reason: 'no_professional' } }) });
    expect(await toolExecutor(noPro, contact, 'c', {})('verificar_horarios', { servico_id: 't2', data_inicio: '2026-11-12', data_fim: '2026-11-12' }))
      .toContain('Nenhum profissional');
  });

  it('avaliação leva o tratamento de interesse', async () => {
    let sent: Record<string, unknown> = {};
    const p = product({ createBooking: async (b: Record<string, unknown>) => { sent = b; return { status: 'ok', data: { booking: { id: 'b', start: '2026-11-12T13:00:00-03:00', status: 'scheduled' } } }; } });
    await toolExecutor(p, contact, 'c', {})('agendar', { servico_id: 'evaluation', servico_interesse_id: 't1', data: '2026-11-12', hora: '13:00', profissional_id: 'p1', nome_cliente: 'Ana' });
    expect(sent).toMatchObject({ serviceId: 'evaluation', interestServiceId: 't1', start: '2026-11-12T13:00:00-03:00' });
  });
});
