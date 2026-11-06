/** Telefone e modelos: regras do WhatsApp usadas pela plataforma. */

export function digits(v: unknown): string {
  return String(v ?? '').replace(/\D/g, '');
}

/**
 * Número para o provedor: só dígitos, com o código do país.
 * Com "+" na frente, o número já é internacional e fica como está; sem "+", 10 ou 11 dígitos = Brasil (põe 55).
 */
export function waNumber(phone: unknown): string {
  const d = digits(phone);
  if (String(phone ?? '').trim().startsWith('+')) return d;
  return d.length === 10 || d.length === 11 ? `55${d}` : d;
}

/** Mesma chave do banco (private.phone_key): DDD + últimos 8 dígitos, para achar o número com ou sem o 9. */
export function phoneKey(phone: unknown): string | null {
  let d = digits(phone);
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) d = d.slice(2);
  if (d.length === 10 || d.length === 11) return d.slice(0, 2) + d.slice(-8);
  return d.length < 8 ? null : d;
}

/** Troca {{1}}, {{2}}... pelos valores. */
export function renderTemplate(body: string, params: string[]): string {
  return body.replace(/\{\{(\d+)\}\}/g, (match, n) => params[Number(n) - 1] ?? match);
}

export const WINDOW_MS = 24 * 60 * 60 * 1000;

/** Pode mandar texto livre? Só até 24h depois da última mensagem do contato. */
export function isWindowOpen(lastIncomingAt: string | null | undefined, now = Date.now()): boolean {
  return !!lastIncomingAt && now - new Date(lastIncomingAt).getTime() < WINDOW_MS;
}
