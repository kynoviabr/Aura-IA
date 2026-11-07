/**
 * Cliente da API padrão dos produtos (Aura IA → Clinova, Agenda+...). Ver docs/API.md, "API padrão do produto".
 * Cada pedido é assinado com o segredo do produto (o mesmo dos avisos):
 *   X-Aura-Signature = HMAC-SHA256 hex de "<timestamp>.<MÉTODO>.<caminho com query>.<corpo>"
 */
import { hmacHex } from './hmac.ts';

export type ProductResult<T> = { status: 'ok'; data: T } | { status: 'unsupported' | 'error'; error: string; code?: string };

export type CatalogService = {
  id?: string;
  /** treatment = serviço normal; evaluation = avaliação (primeira visita). */
  kind?: 'treatment' | 'evaluation';
  name: string;
  category?: string | null;
  description?: string | null;
  durationMinutes?: number | null;
  sessions?: number | null;
  /** Como a IA pode falar do preço: exato, "a partir de" ou não informar (convidar para avaliação). */
  priceDisplay?: 'exact' | 'from' | 'hidden';
  price?: number | null;
  /** Começa com avaliação: a IA agenda a avaliação, não o serviço. */
  requiresEvaluation?: boolean;
  /** false = a IA não agenda este serviço (passa para a equipe). */
  aiBookable?: boolean;
  /** Nomes dos profissionais que fazem (só os que aceitam mostrar o nome). */
  professionals?: string[];
};
export type Catalog = { services: CatalogService[]; packages?: { name: string; price?: number | null; items?: string[] }[] };

/**
 * Dados da empresa. Formato organizado (preferido) ou texto livre (produtos antigos): a Aura entende os dois.
 * hours[].day: 0 = domingo ... 6 = sábado.
 */
export type BusinessInfo = {
  name?: string;
  address?: string | null;
  phone?: string | null;
  hours?: string | null | { day: number; opens: string; closes: string }[];
  closures?: { date: string; reason?: string | null }[];
  payment?: string | null | { methods?: string[]; maxInstallments?: number | null; installmentsMinValue?: number | null; notes?: string | null };
  parking?: string | null | { type?: string; notes?: string | null };
  insurance?: { accepts?: boolean; plans?: string[]; notes?: string | null };
  evaluation?: { offered?: boolean; free?: boolean; durationMinutes?: number | null; price?: number | null };
  scheduling?: { minNoticeMinutes?: number | null; horizonDays?: number | null; rescheduleNoticeHours?: number | null };
  policies?: string | null;
  professionals?: { name: string; specialty?: string | null; services?: string[] }[];
  faq?: { question: string; answer: string }[];
  notes?: string | null;
  setupIssues?: { code: string; text: string }[];
};

/** Quem é o cliente no produto. Sem ref, o produto acha pelo telefone (ou cria um lead). */
export type ProductContact = { type?: string | null; ref?: string | null; phone: string; name?: string | null };

/** professionalName null = o profissional prefere não mostrar o nome. */
export type Slot = { start: string; end: string; professionalId: string; professionalName?: string | null };
export type Booking = {
  id: string; start: string; end?: string; status: string;
  serviceName?: string | null; professionalName?: string | null;
};

export function signingPayload(timestamp: string, method: string, pathAndQuery: string, body: string): string {
  return `${timestamp}.${method.toUpperCase()}.${pathAndQuery}.${body}`;
}

export class ProductClient {
  constructor(
    private readonly baseUrl: string,
    private readonly secret: string,
    private readonly externalId: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async call<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown, timeoutMs = 6000): Promise<ProductResult<T>> {
    const base = this.baseUrl.replace(/\/+$/, '');
    const url = new URL(`${base}${path}`);
    const text = body === undefined ? '' : JSON.stringify(body);
    const ts = String(Math.floor(this.now() / 1000));
    const signed = signingPayload(ts, method, url.pathname + url.search, text);
    try {
      const res = await this.fetchImpl(url.toString(), {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-Aura-Workspace': this.externalId,
          'X-Aura-Timestamp': ts,
          'X-Aura-Signature': await hmacHex(this.secret, signed),
        },
        body: text || undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const raw = await res.text();
      if (res.status === 404 || res.status === 501) return { status: 'unsupported', error: `O produto não oferece ${path}.` };
      if (!res.ok) {
        let code: string | undefined;
        try { code = String((JSON.parse(raw) as { error?: unknown }).error || '') || undefined; } catch { /* corpo sem JSON */ }
        return { status: 'error', error: `Produto respondeu ${res.status}: ${raw.slice(0, 200)}`, code };
      }
      return { status: 'ok', data: (raw ? JSON.parse(raw) : {}) as T };
    } catch (e) {
      return { status: 'error', error: `Sem resposta do produto: ${(e as Error).message}` };
    }
  }

  catalog() { return this.call<Catalog>('GET', '/aura/catalog'); }
  businessInfo() { return this.call<BusinessInfo>('GET', '/aura/business-info'); }

  /** period: morning | afternoon | evening; time: HH:MM (só aquele horário). */
  availability(q: { serviceId: string; from: string; to: string; professionalId?: string; period?: string; time?: string }) {
    const p = new URLSearchParams({ serviceId: q.serviceId, from: q.from, to: q.to });
    if (q.professionalId) p.set('professionalId', q.professionalId);
    if (q.period) p.set('period', q.period);
    if (q.time) p.set('time', q.time);
    return this.call<{ timezone?: string; durationMinutes?: number; slots: Slot[]; truncated?: boolean; reason?: string }>('GET', `/aura/availability?${p}`);
  }

  createBooking(b: { serviceId: string; interestServiceId?: string; start: string; professionalId: string; contact: ProductContact; idempotencyKey: string }) {
    return this.call<{ booking: Booking }>('POST', '/aura/bookings', b, 10000);
  }

  listBookings(contact: ProductContact) {
    return this.call<{ bookings: Booking[] }>('POST', '/aura/bookings/search', { contact });
  }

  cancelBooking(id: string, contact: ProductContact, reason: string) {
    return this.call<{ booking: Booking }>('POST', `/aura/bookings/${encodeURIComponent(id)}/cancel`, { contact, reason }, 10000);
  }
}
