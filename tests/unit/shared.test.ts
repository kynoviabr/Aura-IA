import { describe, expect, it, vi } from 'vitest';
import { isWindowOpen, phoneKey, renderTemplate, waNumber } from '../../supabase/functions/_shared/phone.ts';
import { hmacHex, safeEqual, verifySignature } from '../../supabase/functions/_shared/hmac.ts';
import { HttpError, match, routeParts } from '../../supabase/functions/_shared/http.ts';
import { dispatchAppEvents } from '../../supabase/functions/_shared/dispatch.ts';
import { ZernioClient } from '../../supabase/functions/_shared/zernio.ts';

describe('telefone', () => {
  it('chave igual com e sem 55 e 9', () => {
    expect(phoneKey('5511950210668')).toBe('1150210668');
    expect(phoneKey('(11) 5021-0668')).toBe('1150210668');
    expect(phoneKey('123')).toBeNull();
  });
  it('número para o provedor', () => {
    expect(waNumber('(11) 95021-0668')).toBe('5511950210668');
    expect(waNumber('12 99876-5432')).toBe('5512998765432'); // sem "+": Brasil
    expect(waNumber('+1 202 908 7457')).toBe('12029087457'); // com "+": internacional
    expect(waNumber('+55 11 95021-0668')).toBe('5511950210668');
  });
  it('janela de 24h', () => {
    const now = Date.parse('2026-11-07T12:00:00Z');
    expect(isWindowOpen('2026-11-07T00:00:00Z', now)).toBe(true);
    expect(isWindowOpen('2026-11-06T11:00:00Z', now)).toBe(false);
    expect(isWindowOpen(null, now)).toBe(false);
  });
  it('modelo', () => {
    expect(renderTemplate('Olá {{1}}, até {{2}}', ['Ana', 'amanhã'])).toBe('Olá Ana, até amanhã');
    expect(renderTemplate('Olá {{1}}', [])).toBe('Olá {{1}}');
  });
});

describe('assinatura', () => {
  it('HMAC-SHA256 conhecido', async () => {
    // RFC 4231 caso 2
    expect(await hmacHex('Jefe', 'what do ya want for nothing?')).toBe('5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
  });
  it('verifica e recusa', async () => {
    const sig = await hmacHex('segredo', '{"a":1}');
    expect(await verifySignature('segredo', '{"a":1}', sig.toUpperCase())).toBe(true);
    expect(await verifySignature('segredo', '{"a":2}', sig)).toBe(false);
    expect(await verifySignature('', '{"a":1}', sig)).toBe(false);
    expect(safeEqual('abc', 'abd')).toBe(false);
  });
});

describe('rotas', () => {
  it('separa e casa rotas', () => {
    const parts = routeParts('/functions/v1/api/v1/workspaces/clinic%201/channel', 'api');
    expect(parts).toEqual(['v1', 'workspaces', 'clinic 1', 'channel']);
    expect(match('v1/workspaces/:ext/channel', parts)).toEqual({ ext: 'clinic 1' });
    expect(match('v1/workspaces/:ext', parts)).toBeNull();
  });
});

describe('entrega de avisos aos produtos', () => {
  it('assina, entrega e registra falhas', async () => {
    const finished: Array<Record<string, unknown>> = [];
    const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
      if (fn === 'aura_claim_app_events') {
        return { error: null, data: [
          { id: 'e1', type: 'message.received', payload: { x: 1 }, webhook_url: 'https://p/ok', webhook_secret: 's', attempts: 1, created_at: 't' },
          { id: 'e2', type: 'message.received', payload: { x: 2 }, webhook_url: 'https://p/fail', webhook_secret: 's', attempts: 1, created_at: 't' },
        ] };
      }
      finished.push(args);
      return { data: null, error: null };
    });
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response('', { status: url.endsWith('ok') ? 200 : 500 });
    }) as unknown as typeof fetch;

    const r = await dispatchAppEvents(rpc, fakeFetch);
    expect(r).toEqual({ delivered: 1, failed: 1 });
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers['X-Aura-Signature']).toBe(await hmacHex('s', String(calls[0].init.body)));
    expect(finished).toEqual([
      { p_id: 'e1', p_ok: true, p_error: null },
      { p_id: 'e2', p_ok: false, p_error: 'HTTP 500' },
    ]);
  });
});

describe('cliente Zernio', () => {
  it('lê modelos e conta variáveis', async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({ templates: [
      { name: 'boas_vindas', language: 'pt_BR', category: 'UTILITY', components: [{ type: 'BODY', text: 'Olá {{1}}, sua sessão é {{2}}. {{1}}' }] },
    ] }), { status: 200 })) as unknown as typeof fetch;
    const t = await new ZernioClient('k', fakeFetch).templates('acc');
    expect(t[0]).toMatchObject({ name: 'boas_vindas', variables: 2 });
  });
  it('erro do provedor vira HttpError com mensagem', async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({ error: 'Sem forma de pagamento', code: 'payment_required' }), { status: 402 })) as unknown as typeof fetch;
    await expect(new ZernioClient('k', fakeFetch).call('/x')).rejects.toMatchObject({ status: 402, code: 'payment_required' });
  });
  it('sem chave não funciona', () => {
    expect(() => new ZernioClient('')).toThrow(HttpError);
  });
});

import { ensureStandardTemplates, STANDARD_TEMPLATES, templateComponents } from '../../supabase/functions/_shared/templates.ts';

describe('modelos padrão', () => {
  it('cria só os que faltam e não para no erro', async () => {
    const created: string[] = [];
    const z = {
      templateNames: async () => ['aura_retomar_atendimento'],
      createTemplate: async (_acc: string, t: { name: string }) => {
        if (t.name === 'aura_lembrete_horario') throw new Error('nome em uso');
        created.push(t.name);
      },
    };
    const r = await ensureStandardTemplates(z, 'acc');
    expect(r.existing).toEqual(['aura_retomar_atendimento']);
    expect(r.created).toEqual(['aura_confirmacao_agendamento']);
    expect(r.failed).toEqual([{ name: 'aura_lembrete_horario', error: 'nome em uso' }]);
    expect(created).toEqual(['aura_confirmacao_agendamento']);
  });
  it('falha ao listar vira resumo, sem exceção', async () => {
    const r = await ensureStandardTemplates({ templateNames: async () => { throw new Error('402'); }, createTemplate: async () => {} }, 'acc');
    expect(r.failed[0]).toEqual({ name: '*', error: '402' });
  });
  it('exemplos batem com as variáveis e nomes seguem a regra da Meta', () => {
    for (const t of STANDARD_TEMPLATES) {
      expect(t.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(new Set(t.body.match(/\{\{\d+\}\}/g)).size).toBe(t.example.length);
      expect(templateComponents(t)[0]).toMatchObject({ type: 'BODY', example: { body_text: [t.example] } });
    }
  });
  it('cliente Zernio envia o modelo para criação', async () => {
    let sent: Record<string, unknown> = {};
    const fakeFetch = (async (_u: string, init: RequestInit) => { sent = JSON.parse(String(init.body)); return new Response('{"success":true}', { status: 200 }); }) as unknown as typeof fetch;
    await new ZernioClient('k', fakeFetch).createTemplate('acc', { name: 'x', category: 'UTILITY', language: 'pt_BR', components: [] });
    expect(sent).toMatchObject({ accountId: 'acc', name: 'x', category: 'UTILITY', language: 'pt_BR' });
  });
});

import { explainProviderError, testProviderKey } from '../../supabase/functions/_shared/providers.ts';

describe('teste das chaves de IA', () => {
  it('explica erros comuns', () => {
    expect(explainProviderError(401, '')).toBe('Chave inválida ou revogada.');
    expect(explainProviderError(429, '{"error":{"code":"insufficient_quota"}}')).toBe('Sem créditos no provedor. Recarregue.');
    expect(explainProviderError(400, 'Your credit balance is too low')).toBe('Sem créditos no provedor. Recarregue.');
    expect(explainProviderError(429, 'rate limit')).toBe('Limite de uso do provedor atingido no momento.');
    expect(explainProviderError(503, '')).toBe('Provedor fora do ar (erro 503).');
  });
  it('usa o cabeçalho certo de cada provedor', async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      seen.push({ url, headers: init.headers as Record<string, string> });
      return new Response('{}', { status: url.includes('anthropic') ? 200 : 401 });
    }) as unknown as typeof fetch;
    expect((await testProviderKey('anthropic', 'k1', fakeFetch)).ok).toBe(true);
    const o = await testProviderKey('openai', 'k2', fakeFetch);
    expect(o).toMatchObject({ ok: false, error: 'Chave inválida ou revogada.' });
    expect(seen[0].headers['x-api-key']).toBe('k1');
    expect(seen[1].headers.Authorization).toBe('Bearer k2');
  });
});
