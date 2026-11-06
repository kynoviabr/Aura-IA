/** Teste das chaves de IA: consulta gratuita da lista de modelos (não gasta crédito). */

export type ProviderTest = { ok: boolean; status?: number; error?: string; latencyMs: number };

const ENDPOINTS: Record<string, { url: string; headers: (key: string) => Record<string, string> }> = {
  anthropic: {
    url: 'https://api.anthropic.com/v1/models?limit=1',
    headers: (key) => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01' }),
  },
  openai: {
    url: 'https://api.openai.com/v1/models',
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
  },
};

/** Traduz o erro do provedor para algo que a equipe entenda. */
export function explainProviderError(status: number, body: string): string {
  const b = body.toLowerCase();
  if (status === 401) return 'Chave inválida ou revogada.';
  if (status === 403) return 'Chave sem permissão (verifique a conta/projeto).';
  if (status === 429 && (b.includes('quota') || b.includes('credit') || b.includes('billing'))) return 'Sem créditos no provedor. Recarregue.';
  if (status === 429) return 'Limite de uso do provedor atingido no momento.';
  if (status === 400 && (b.includes('credit balance') || b.includes('billing'))) return 'Sem créditos no provedor. Recarregue.';
  if (status >= 500) return `Provedor fora do ar (erro ${status}).`;
  return `Erro ${status} no provedor.`;
}

export async function testProviderKey(provider: string, key: string, fetchImpl: typeof fetch = fetch): Promise<ProviderTest> {
  const ep = ENDPOINTS[provider];
  if (!ep) return { ok: false, error: 'Provedor desconhecido.', latencyMs: 0 };
  const start = Date.now();
  try {
    const res = await fetchImpl(ep.url, { headers: ep.headers(key), signal: AbortSignal.timeout(10000) });
    const latencyMs = Date.now() - start;
    if (res.ok) return { ok: true, status: res.status, latencyMs };
    return { ok: false, status: res.status, error: explainProviderError(res.status, await res.text()), latencyMs };
  } catch (e) {
    return { ok: false, error: `Sem resposta do provedor: ${(e as Error).message}`, latencyMs: Date.now() - start };
  }
}
