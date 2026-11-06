import { formatDistanceToNowStrict, format, parseISO } from 'date-fns';
import { ptBR } from 'date-fns/locale';

export function usd(v: number | string | null | undefined, digits = 2): string {
  const n = Number(v || 0);
  const d = n !== 0 && Math.abs(n) < 0.01 ? 4 : digits;
  return `US$ ${n.toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d })}`;
}

export function brl(v: number | string | null | undefined): string {
  return Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

export function num(v: number | string | null | undefined, digits = 0): string {
  return Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** "há 5 min", "há 2 dias"; vazio vira "nunca". */
export function ago(iso: string | null | undefined): string {
  if (!iso) return 'nunca';
  return `há ${formatDistanceToNowStrict(parseISO(iso), { locale: ptBR })}`;
}

export function dateTime(iso: string | null | undefined): string {
  return iso ? format(parseISO(iso), "dd/MM/yyyy HH:mm") : '—';
}

export function dayLabel(iso: string): string {
  return format(parseISO(iso), 'dd/MM');
}

/** (11) 95021-0668 ou +1 202... */
export function phone(v: string | null | undefined): string {
  const raw = String(v || '').replace(/\D/g, '');
  if (!raw) return v || '';
  if ((raw.length === 12 || raw.length === 13) && raw.startsWith('55')) {
    const d = raw.slice(2);
    return d.length === 11 ? `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}` : `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  }
  return v?.startsWith('+') ? v : `+${raw}`;
}

export type Tone = 'ok' | 'warn' | 'bad' | 'off';

/** Situação do número de uma empresa, em uma palavra e cor. */
export function channelState(status: string | null | undefined, health: string | null | undefined): { label: string; tone: Tone } {
  if (!status || status === 'not_started') return { label: 'Sem WhatsApp', tone: 'off' };
  if (status === 'pending') return { label: 'Conectando', tone: 'warn' };
  if (status === 'disconnected' || health === 'disconnected') return { label: 'Desconectado', tone: 'bad' };
  if (health === 'error') return { label: 'Com erro', tone: 'bad' };
  if (health === 'warning') return { label: 'Atenção', tone: 'warn' };
  return { label: 'Funcionando', tone: 'ok' };
}

/** Saúde do produto pela entrega dos avisos. */
export function appState(a: { is_active: boolean; webhook_url: string | null; failed: number; last_delivery_ok_at: string | null; last_delivery_error_at: string | null }): { label: string; tone: Tone } {
  if (!a.is_active) return { label: 'Desativado', tone: 'off' };
  if (!a.webhook_url) return { label: 'Sem endereço de avisos', tone: 'warn' };
  if (a.failed > 0) return { label: 'Avisos falhando', tone: 'bad' };
  if (a.last_delivery_error_at && (!a.last_delivery_ok_at || a.last_delivery_error_at > a.last_delivery_ok_at)) return { label: 'Instável', tone: 'warn' };
  return { label: 'Funcionando', tone: 'ok' };
}

export const SEVERITY_LABEL: Record<string, string> = { critical: 'Crítico', warning: 'Atenção', info: 'Informação' };
export const PROVIDER_LABEL: Record<string, string> = { anthropic: 'Claude (Anthropic)', openai: 'OpenAI' };
export const FEATURE_LABEL: Record<string, string> = { copilot: 'Copiloto', auto: 'Automático', eval: 'Avaliação', ping: 'Teste', other: 'Outro' };
export const ROLE_LABEL: Record<string, string> = { owner: 'Dono', operator: 'Operador', viewer: 'Leitura' };
