/** Cliente do provedor Zernio. Toda chamada ao WhatsApp passa por aqui (trocar de provedor = trocar este arquivo). */
import { HttpError } from './http.ts';
import { MediaError, type DownloadedMedia, type InboundAttachment, type MediaKind } from './media.ts';

const BASE = 'https://zernio.com/api/v1';

const KINDS: Record<string, MediaKind> = { image: 'image', video: 'video', audio: 'audio', file: 'document', document: 'document' };

/**
 * Anexos de `message.received` no formato da Aura. No WhatsApp o `url` aponta para
 * /v1/whatsapp/media/{mediaId}; guardamos só o mediaId (o download sempre passa por downloadMedia).
 */
export function normalizeZernioAttachments(raw: unknown): InboundAttachment[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((a, index) => {
    const att = (a && typeof a === 'object' ? a : {}) as Record<string, unknown>;
    const type = String(att.type || 'unknown');
    const url = typeof att.url === 'string' ? att.url : '';
    const mediaId = url.match(/\/whatsapp\/media\/([A-Za-z0-9._-]{1,200})(?:[/?#]|$)/)?.[1] || null;
    const payload = (att.payload && typeof att.payload === 'object' ? att.payload : {}) as Record<string, unknown>;
    const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
    return {
      index,
      kind: KINDS[type] || null,
      providerType: type.slice(0, 40),
      providerAttachmentId: mediaId,
      mimeType: str(att.mimeType, 120),
      fileName: str(att.fileName ?? att.filename ?? att.name, 200),
      voice: payload.voice === true,
    };
  });
}

export type ZernioTemplate = { name: string; language: string; category: string; status: string; body: string; variables: number };

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

  /**
   * Desconecta o número na Zernio (DELETE /accounts/{id}). A Zernio guarda a conta por 1h;
   * depois ela some. 404 = já estava desconectado, o que para nós também serve.
   */
  async disconnectAccount(accountId: string): Promise<'removed' | 'not_found'> {
    if (!/^[A-Za-z0-9._-]{1,200}$/.test(accountId)) throw new HttpError(400, 'invalid_account', 'Conta de WhatsApp inválida.');
    const res = await this.fetchImpl(`${BASE}/accounts/${accountId}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    await res.body?.cancel().catch(() => {});
    if (res.ok) return 'removed';
    if (res.status === 404) return 'not_found';
    console.error('zernio', 'disconnect', res.status);
    throw new HttpError(502, 'provider_error', `Erro ${res.status} ao desconectar o número no provedor de WhatsApp.`);
  }

  async connectUrl(profileId: string, redirectUrl: string): Promise<string> {
    const r = await this.call(`/connect/whatsapp?profileId=${profileId}&redirect_url=${encodeURIComponent(redirectUrl)}`);
    return String(r.authUrl);
  }

  async whatsappAccounts(profileId: string): Promise<Array<Record<string, unknown>>> {
    const r = await this.call(`/accounts?profileId=${profileId}&platform=whatsapp`);
    return (r.accounts as Array<Record<string, unknown>>) || [];
  }

  /** Modelos do número. Por padrão só os aprovados (os que podem ser enviados). */
  async templates(accountId: string, onlyApproved = true): Promise<ZernioTemplate[]> {
    const r = await this.call(`/whatsapp/templates?accountId=${accountId}${onlyApproved ? '&status=APPROVED' : ''}`);
    return ((r.templates as Array<Record<string, unknown>>) || []).map((t) => {
      const comps = (t.components as Array<Record<string, unknown>>) || [];
      const body = String(comps.find((c) => c.type === 'BODY')?.text || '');
      return {
        name: String(t.name), language: String(t.language), category: String(t.category), status: String(t.status || ''),
        body, variables: new Set(body.match(/\{\{\d+\}\}/g) || []).size,
      };
    });
  }

  /** Nomes de todos os modelos do número, em qualquer situação (aprovado, em revisão, recusado). */
  async templateNames(accountId: string): Promise<string[]> {
    return (await this.templates(accountId, false)).map((t) => t.name);
  }

  async createTemplate(accountId: string, t: { name: string; category: string; language: string; components: unknown[] }): Promise<void> {
    await this.call('/whatsapp/templates', { method: 'POST', body: JSON.stringify({ accountId, ...t }) });
  }

  /**
   * Baixa um arquivo recebido (só em memória). Para no limite de tamanho e no tempo máximo.
   * A chave só vai para a Zernio: se houver redirecionamento, o segundo pedido sai sem a chave.
   */
  async downloadMedia(mediaId: string, maxBytes: number, timeoutMs: number): Promise<DownloadedMedia> {
    if (!/^[A-Za-z0-9._-]{1,200}$/.test(mediaId)) throw new MediaError('media_reference_invalid', 'Referência de mídia inválida.');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      let res = await this.fetchImpl(`${BASE}/whatsapp/media/${mediaId}`, {
        headers: { Authorization: `Bearer ${this.apiKey}` }, redirect: 'manual', signal: ctrl.signal,
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        const next = loc ? new URL(loc, BASE) : null;
        await res.body?.cancel();
        if (!next || next.protocol !== 'https:') throw new MediaError('media_provider_error', 'Redirecionamento inválido do provedor.');
        res = await this.fetchImpl(next.toString(), { redirect: 'manual', signal: ctrl.signal });
      }
      if (!res.ok) {
        await res.body?.cancel();
        if (res.status === 401 || res.status === 403) throw new MediaError('media_download_denied', `Provedor recusou o download (${res.status}).`);
        if (res.status === 400 || res.status === 404 || res.status === 410) throw new MediaError('media_reference_invalid', `Arquivo não está mais disponível (${res.status}).`);
        throw new MediaError('media_provider_error', `Erro ${res.status} no provedor.`, res.status === 429 || res.status >= 500);
      }
      const declared = Number(res.headers.get('content-length') || 0);
      if (declared > maxBytes) {
        await res.body?.cancel();
        throw new MediaError('media_too_large', 'Arquivo maior que o limite.');
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      const reader = res.body?.getReader();
      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > maxBytes) {
          await reader.cancel();
          throw new MediaError('media_too_large', 'Arquivo maior que o limite.');
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let off = 0;
      for (const c of chunks) { bytes.set(c, off); off += c.length; }
      const mime = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase() || null;
      return { bytes, mimeType: mime, sizeBytes: size };
    } catch (e) {
      if (e instanceof MediaError) throw e;
      if (ctrl.signal.aborted) throw new MediaError('media_download_timeout', 'Download demorou demais.', true);
      throw new MediaError('media_provider_error', 'Falha de rede ao baixar a mídia.', true);
    } finally {
      clearTimeout(timer);
    }
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
