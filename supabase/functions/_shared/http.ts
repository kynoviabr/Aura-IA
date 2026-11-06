/** Respostas JSON e erros com código para a API da Aura IA. */

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-aura-key',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, OPTIONS',
};

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

export function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) return json({ error: { code: err.code, message: err.message } }, err.status);
  console.error(err);
  return json({ error: { code: 'internal_error', message: 'Erro inesperado.' } }, 500);
}

/** Separa a rota depois do nome da função: /functions/v1/api/v1/workspaces/x -> ['v1','workspaces','x']. */
export function routeParts(pathname: string, functionName: string): string[] {
  const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const i = parts.indexOf(functionName);
  return i >= 0 ? parts.slice(i + 1) : parts;
}

/** Casa um padrão como 'v1/workspaces/:ext/channel' e devolve os parâmetros, ou null. */
export function match(pattern: string, parts: string[]): Record<string, string> | null {
  const p = pattern.split('/').filter(Boolean);
  if (p.length !== parts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(':')) params[p[i].slice(1)] = parts[i];
    else if (p[i] !== parts[i]) return null;
  }
  return params;
}
