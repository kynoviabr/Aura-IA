/** Cliente do provedor Zernio. Toda chamada ao WhatsApp passa por aqui (trocar de provedor = trocar este arquivo). */
import { HttpError } from './http.ts';

const BASE = 'https://zernio.com/api/v1';

export type ZernioTemplate = { name: string; language: string; category: string; body: string; variables: number };

export class ZernioClient {
  constructor(private readonly apiKey: string, private readonly fetchImpl: typeof fetch = fetch) {
    if (!apiKey) throw new HttpError(500, 'provider_not_configured', 'Chave da Zernio não configurada no servidor.');
  }

  async call(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    const res = await this.fetchImpl(`${BASE}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
    });
    const text = await res.text();
    let data: Record<string, unknown> = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!res.ok) {
      console.error('zernio', path, res.status, text.slice(0, 500));
      throw new HttpError(res.status === 402 ? 402 : 502, String(data.code || 'provider_error'),
        String(data.error || data.message || `Erro ${res.status} no provedor de WhatsApp`));
    }
    return data;
  }

  async findOrCreateProfile(externalId: string, name: string, timezone: string): Promise<string> {
    const found = await this.call(`/profiles?externalId=${encodeURIComponent(externalId)}`);
    const existing = ((found.profiles as Array<{ _id: string }>) || [])[0]?._id;
    if (existing) return existing;
    const created = await this.call('/profiles', {
      method: 'POST',
      body: JSON.stringify({ name: name.slice(0, 80), externalId, timezone }),
    });
    return (created.profile as { _id: string })._id;
  }

  async connectUrl(profileId: string, redirectUrl: string): Promise<string> {
    const r = await this.call(`/connect/whatsapp?profileId=${profileId}&redirect_url=${encodeURIComponent(redirectUrl)}`);
    return String(r.authUrl);
  }

  async whatsappAccounts(profileId: string): Promise<Array<Record<string, unknown>>> {
    const r = await this.call(`/accounts?profileId=${profileId}&platform=whatsapp`);
    return (r.accounts as Array<Record<string, unknown>>) || [];
  }

  async templates(accountId: string): Promise<ZernioTemplate[]> {
    const r = await this.call(`/whatsapp/templates?accountId=${accountId}&status=APPROVED`);
    return ((r.templates as Array<Record<string, unknown>>) || []).map((t) => {
      const comps = (t.components as Array<Record<string, unknown>>) || [];
      const body = String(comps.find((c) => c.type === 'BODY')?.text || '');
      return { name: String(t.name), language: String(t.language), category: String(t.category), body, variables: new Set(body.match(/\{\{\d+\}\}/g) || []).size };
    });
  }

  async sendText(conversationId: string, accountId: string, text: string): Promise<string | null> {
    const r = await this.call(`/inbox/conversations/${conversationId}/messages`, {
      method: 'POST', body: JSON.stringify({ accountId, message: text }),
    });
    return (r.data as { messageId?: string })?.messageId || null;
  }

  async sendTemplateInConversation(conversationId: string, accountId: string, name: string, language: string, params: string[]): Promise<string | null> {
    const components = params.length ? [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }] : [];
    const r = await this.call(`/inbox/conversations/${conversationId}/messages`, {
      method: 'POST', body: JSON.stringify({ accountId, template: { elements: [{ name, language, components }] } }),
    });
    return (r.data as { messageId?: string })?.messageId || null;
  }

  async openWithTemplate(accountId: string, phone: string, name: string, language: string, params: string[]): Promise<{ conversationId: string; messageId: string | null }> {
    const r = await this.call('/inbox/conversations', {
      method: 'POST',
      body: JSON.stringify({ accountId, participantId: phone, templateName: name, templateLanguage: language, templateParams: params }),
    });
    const data = r.data as { conversationId?: string; messageId?: string };
    if (!data?.conversationId) throw new HttpError(502, 'provider_error', 'O provedor não devolveu a conversa.');
    return { conversationId: data.conversationId, messageId: data.messageId || null };
  }
}
