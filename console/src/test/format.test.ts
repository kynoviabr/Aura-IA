import { describe, expect, it } from 'vitest';
import { appState, channelState, phone, usd } from '@/lib/format';

describe('formatação do Console', () => {
  it('situação do número', () => {
    expect(channelState('not_started', 'unknown')).toEqual({ label: 'Sem WhatsApp', tone: 'off' });
    expect(channelState('connected', 'healthy').tone).toBe('ok');
    expect(channelState('connected', 'unknown').tone).toBe('ok');
    expect(channelState('connected', 'warning').label).toBe('Atenção');
    expect(channelState('disconnected', 'healthy').label).toBe('Desconectado');
    expect(channelState('connected', 'error').tone).toBe('bad');
  });
  it('saúde do produto', () => {
    const base = { is_active: true, webhook_url: 'https://x', failed: 0, last_delivery_ok_at: '2026-11-08T10:00:00Z', last_delivery_error_at: null };
    expect(appState(base).tone).toBe('ok');
    expect(appState({ ...base, failed: 2 }).label).toBe('Avisos falhando');
    expect(appState({ ...base, last_delivery_error_at: '2026-11-08T11:00:00Z' }).label).toBe('Instável');
    expect(appState({ ...base, webhook_url: null }).tone).toBe('warn');
    expect(appState({ ...base, is_active: false }).tone).toBe('off');
  });
  it('telefone e dinheiro', () => {
    expect(phone('5511950210668')).toBe('(11) 95021-0668');
    expect(phone('+1 202 908 7457')).toBe('+1 202 908 7457');
    expect(usd(0.00036)).toBe('US$ 0,0004');
    expect(usd(12.5)).toBe('US$ 12,50');
  });
});
