import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_MEDIA_LIMITS, MediaError, detectFormat, mediaLimits, storagePath, validateMedia } from '../../supabase/functions/_shared/media.ts';
import { normalizeZernioAttachments, ZernioClient } from '../../supabase/functions/_shared/zernio.ts';
import { processAttachments, purgeExpiredAttachments, type MediaDeps } from '../../supabase/functions/_shared/media-runner.ts';

const bytes = (head: number[] | string, total = 64) => {
  const h = typeof head === 'string' ? [...head].map((c) => c.charCodeAt(0)) : head;
  const b = new Uint8Array(Math.max(total, h.length));
  b.set(h);
  return b;
};
const oggOpus = () => { const b = bytes('OggS', 64); b.set([...'OpusHead'].map((c) => c.charCodeAt(0)), 28); return b; };
const jpeg = () => bytes([0xff, 0xd8, 0xff, 0xe0]);

describe('anexos da Zernio', () => {
  it('normaliza tipo, mediaId e voz sem guardar a URL', () => {
    const out = normalizeZernioAttachments([
      { type: 'audio', url: 'https://zernio.com/api/v1/whatsapp/media/abc_123', mimeType: 'audio/ogg; codecs=opus', payload: { voice: true } },
      { type: 'file', url: 'https://zernio.com/api/v1/whatsapp/media/doc1?x=1', fileName: 'exame.pdf' },
      { type: 'sticker', url: 'https://zernio.com/api/v1/whatsapp/media/st1' },
      { type: 'image', url: 'https://cdn.example.com/a.jpg' },
    ]);
    expect(out[0]).toEqual({ index: 0, kind: 'audio', providerType: 'audio', providerAttachmentId: 'abc_123', mimeType: 'audio/ogg; codecs=opus', fileName: null, voice: true });
    expect(out[1]).toMatchObject({ kind: 'document', providerAttachmentId: 'doc1', fileName: 'exame.pdf', voice: false });
    expect(out[2]).toMatchObject({ kind: null, providerType: 'sticker' });
    expect(out[3]).toMatchObject({ kind: 'image', providerAttachmentId: null });
    expect(JSON.stringify(out)).not.toContain('http');
  });
  it('ignora formato inesperado', () => {
    expect(normalizeZernioAttachments(null)).toEqual([]);
    expect(normalizeZernioAttachments([null])[0]).toMatchObject({ kind: null, providerAttachmentId: null });
  });
});

describe('formato pelos bytes', () => {
  it('reconhece os formatos do WhatsApp', () => {
    expect(detectFormat(oggOpus())).toBe('ogg-opus');
    expect(detectFormat(jpeg())).toBe('jpeg');
    expect(detectFormat(bytes([0x89, 0x50, 0x4e, 0x47]))).toBe('png');
    expect(detectFormat(bytes('\0\0\0\u0018ftypmp42'))).toBe('mp4');
    expect(detectFormat(bytes('\0\0\0\u0018ftyp3gp4'))).toBe('3gp');
    expect(detectFormat(bytes('\0\0\0\u0018ftypM4A '))).toBe('m4a');
    expect(detectFormat(bytes('ID3'))).toBe('mp3');
    expect(detectFormat(bytes([0xff, 0xf1, 0x50]))).toBe('aac');
    expect(detectFormat(bytes('#!AMR\n'))).toBe('amr');
    expect(detectFormat(bytes('%PDF-1.7'))).toBe('pdf');
    expect(detectFormat(bytes('<html>'))).toBeNull();
    expect(detectFormat(new Uint8Array(4))).toBeNull();
  });
});

describe('validação', () => {
  const L = DEFAULT_MEDIA_LIMITS;
  it('aceita e devolve MIME seguro', () => {
    expect(validateMedia('audio', { bytes: oggOpus(), mimeType: 'audio/ogg', sizeBytes: 64 }, L)).toEqual({ format: 'ogg-opus', mimeType: 'audio/ogg' });
    expect(validateMedia('image', { bytes: jpeg(), mimeType: 'text/html', sizeBytes: 64 }, L)).toEqual({ format: 'jpeg', mimeType: 'image/jpeg' });
  });
  it('recusa formato trocado, vazio e grande', () => {
    const code = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as MediaError).code; } return null; };
    expect(code(() => validateMedia('image', { bytes: oggOpus(), mimeType: null, sizeBytes: 64 }, L))).toBe('media_mime_unsupported');
    expect(code(() => validateMedia('image', { bytes: bytes('<html>'), mimeType: null, sizeBytes: 64 }, L))).toBe('media_content_invalid');
    expect(code(() => validateMedia('image', { bytes: jpeg(), mimeType: null, sizeBytes: 0 }, L))).toBe('media_content_invalid');
    expect(code(() => validateMedia('image', { bytes: jpeg(), mimeType: null, sizeBytes: 6 * 1024 * 1024 }, L))).toBe('media_too_large');
  });
  it('limites configuráveis com padrão', () => {
    const l = mediaLimits({ max_mb: { audio: 2, image: -1 }, timeout_ms: 5000, max_attempts: 'x' });
    expect(l.maxBytes.audio).toBe(2 * 1024 * 1024);
    expect(l.maxBytes.image).toBe(L.maxBytes.image);
    expect(l.timeoutMs).toBe(5000);
    expect(l.maxAttempts).toBe(L.maxAttempts);
    expect(mediaLimits(null)).toEqual(L);
  });
  it('caminho sempre começa pela empresa', () => {
    expect(storagePath('w1', 'c1', 'a1', 'ogg-opus')).toBe('w1/c1/a1.oggopus');
  });
});

describe('download pela Zernio', () => {
  const ok = (body: Uint8Array, headers: Record<string, string> = {}) => new Response(body, { status: 200, headers });
  it('baixa com a chave e lê o tipo', async () => {
    const f = vi.fn().mockResolvedValue(ok(oggOpus(), { 'content-type': 'audio/ogg; codecs=opus' }));
    const z = new ZernioClient('k', f as unknown as typeof fetch);
    const m = await z.downloadMedia('m1', 1000, 1000);
    expect(f.mock.calls[0][0]).toBe('https://zernio.com/api/v1/whatsapp/media/m1');
    expect(f.mock.calls[0][1].headers.Authorization).toBe('Bearer k');
    expect(m).toMatchObject({ mimeType: 'audio/ogg', sizeBytes: 64 });
  });
  it('redirecionamento segue sem a chave', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://cdn.example.com/x' } }))
      .mockResolvedValueOnce(ok(jpeg()));
    await new ZernioClient('k', f as unknown as typeof fetch).downloadMedia('m1', 1000, 1000);
    expect(f.mock.calls[1][0]).toBe('https://cdn.example.com/x');
    expect(f.mock.calls[1][1].headers).toBeUndefined();
  });
  it('códigos de erro', async () => {
    const code = async (res: Response | Error, id = 'm1', max = 1000) => {
      const f = vi.fn(); if (res instanceof Error) f.mockRejectedValue(res); else f.mockResolvedValue(res);
      try { await new ZernioClient('k', f as unknown as typeof fetch).downloadMedia(id, max, 1000); } catch (e) { return [(e as MediaError).code, (e as MediaError).retryable]; }
      return null;
    };
    expect(await code(new Response('x', { status: 400 }))).toEqual(['media_reference_invalid', false]);
    expect(await code(new Response('x', { status: 401 }))).toEqual(['media_download_denied', false]);
    expect(await code(new Response('x', { status: 503 }))).toEqual(['media_provider_error', true]);
    expect(await code(ok(jpeg(), { 'content-length': '5000' }))).toEqual(['media_too_large', false]);
    expect(await code(ok(new Uint8Array(2000)))).toEqual(['media_too_large', false]);
    expect(await code(new TypeError('network'))).toEqual(['media_provider_error', true]);
    expect(await code(ok(jpeg()), '../x')).toEqual(['media_reference_invalid', false]);
  });
  it('tempo esgotado', async () => {
    const f = vi.fn((_u: string, init: RequestInit) => new Promise((_r, rej) => init.signal!.addEventListener('abort', () => rej(new Error('abort')))));
    await expect(new ZernioClient('k', f as unknown as typeof fetch).downloadMedia('m1', 1000, 10)).rejects.toMatchObject({ code: 'media_download_timeout', retryable: true });
  });
});

describe('processamento dos anexos', () => {
  const claimed = (over: Record<string, unknown> = {}) => ({
    id: 'a1', workspace_id: 'w1', conversation_id: 'c1', kind: 'audio', provider: 'zernio',
    provider_attachment_id: 'm1', declared_mime_type: 'audio/ogg', attempts: 1, ...over,
  });
  const deps = (over: Partial<MediaDeps> = {}, rows = [claimed()]) => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const d: MediaDeps = {
      rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
        calls.push([fn, args]);
        if (fn === 'aura_claim_attachments') return { data: rows, error: null };
        if (fn === 'aura_attachments_to_purge') return { data: [{ id: 'a1', storage_path: 'w1/c1/a1.jpeg' }], error: null };
        if (fn === 'aura_mark_attachments_purged') return { data: 1, error: null };
        return { data: null, error: null };
      }),
      loadLimits: async () => null,
      download: vi.fn(async () => ({ bytes: oggOpus(), mimeType: 'audio/ogg', sizeBytes: 64 })),
      upload: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
      ...over,
    };
    return { d, calls };
  };

  it('baixa, valida, grava e registra', async () => {
    const { d, calls } = deps();
    expect(await processAttachments(d, ['a1'])).toEqual({ processed: 1, failed: 0, retry: 0 });
    expect(d.upload).toHaveBeenCalledWith('w1/c1/a1.oggopus', expect.any(Uint8Array), 'audio/ogg');
    const finish = calls.find(([fn]) => fn === 'aura_finish_attachment')![1];
    expect(finish.p_result).toMatchObject({ ok: true, format: 'ogg-opus', sizeBytes: 64, storagePath: 'w1/c1/a1.oggopus' });
    expect(String((finish.p_result as Record<string, unknown>).sha256)).toMatch(/^[0-9a-f]{64}$/);
  });
  it('falha temporária pede nova tentativa', async () => {
    const { d, calls } = deps({ download: vi.fn(async () => { throw new MediaError('media_download_timeout', 'x', true); }) });
    expect(await processAttachments(d, null)).toEqual({ processed: 0, failed: 0, retry: 1 });
    expect(calls.find(([fn]) => fn === 'aura_finish_attachment')![1].p_result).toEqual({ ok: false, code: 'media_download_timeout', retry: true });
  });
  it('arquivo inválido falha de vez e não grava', async () => {
    const { d } = deps({ download: vi.fn(async () => ({ bytes: jpeg(), mimeType: 'image/jpeg', sizeBytes: 64 })) });
    expect(await processAttachments(d, ['a1'])).toEqual({ processed: 0, failed: 1, retry: 0 });
    expect(d.upload).not.toHaveBeenCalled();
  });
  it('falha no Storage tenta de novo', async () => {
    const { d } = deps({ upload: vi.fn(async () => { throw new Error('down'); }) });
    expect(await processAttachments(d, ['a1'])).toEqual({ processed: 0, failed: 0, retry: 1 });
  });
  it('lista vazia não chama o banco', async () => {
    const { d } = deps();
    await processAttachments(d, []);
    expect(d.rpc).not.toHaveBeenCalled();
  });
  it('limpa arquivos fora do prazo', async () => {
    const { d } = deps();
    expect(await purgeExpiredAttachments(d)).toBe(1);
    expect(d.remove).toHaveBeenCalledWith(['w1/c1/a1.jpeg']);
  });
});
