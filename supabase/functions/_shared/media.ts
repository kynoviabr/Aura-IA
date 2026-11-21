/**
 * Mídia do canal (MM-0): tipos neutros de provedor, limites e validação do arquivo baixado.
 * O formato bruto de cada provedor fica no adaptador dele (ex.: zernio.ts); aqui só o formato da Aura.
 */

export type MediaKind = 'audio' | 'image' | 'video' | 'document';

/** Anexo recebido, já no formato da Aura. Nunca guarda URL nem chave do provedor. */
export type InboundAttachment = {
  index: number;
  /** null = tipo que a Aura ainda não trata (figurinha, localização...). Fica registrado como `unsupported`. */
  kind: MediaKind | null;
  providerType: string;
  /** Id do arquivo no provedor (no WhatsApp/Zernio, o mediaId). null = sem como baixar. */
  providerAttachmentId: string | null;
  mimeType: string | null;
  fileName: string | null;
  /** true = áudio gravado no WhatsApp (mensagem de voz); false = arquivo de áudio. */
  voice: boolean;
};

export type DownloadedMedia = { bytes: Uint8Array; mimeType: string | null; sizeBytes: number };

/** Erros de mídia com código fixo (docs/ROADMAP_MENSAGERIA_MULTIMODAL.md §9.2). Nunca vão para o cliente final. */
export type MediaErrorCode =
  | 'media_reference_invalid' // provedor não acha mais o arquivo (expirou na Meta, id errado)
  | 'media_download_timeout'
  | 'media_download_denied' // chave recusada
  | 'media_provider_error' // falha temporária do provedor
  | 'media_too_large'
  | 'media_mime_unsupported'
  | 'media_content_invalid'
  | 'media_storage_error';

export class MediaError extends Error {
  constructor(public code: MediaErrorCode, message: string, public retryable = false) {
    super(message);
  }
}

export type MediaLimits = {
  maxBytes: Record<MediaKind, number>;
  timeoutMs: number;
  maxAttempts: number;
};

const MB = 1024 * 1024;

/** Limites padrão (WhatsApp: imagem 5 MB, vídeo e áudio 16 MB). Documento limitado pela memória da função. */
export const DEFAULT_MEDIA_LIMITS: MediaLimits = {
  maxBytes: { image: 5 * MB, video: 16 * MB, audio: 16 * MB, document: 25 * MB },
  timeoutMs: 20_000,
  maxAttempts: 4,
};

/** Junta os limites salvos em platform_settings (chave media_limits) com os padrões. Valores inválidos são ignorados. */
export function mediaLimits(setting: unknown): MediaLimits {
  const s = (setting && typeof setting === 'object' ? setting : {}) as Record<string, unknown>;
  const pos = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d);
  const mb = (s.max_mb && typeof s.max_mb === 'object' ? s.max_mb : {}) as Record<string, unknown>;
  const d = DEFAULT_MEDIA_LIMITS;
  return {
    maxBytes: {
      image: pos(mb.image, d.maxBytes.image / MB) * MB,
      video: pos(mb.video, d.maxBytes.video / MB) * MB,
      audio: pos(mb.audio, d.maxBytes.audio / MB) * MB,
      document: pos(mb.document, d.maxBytes.document / MB) * MB,
    },
    timeoutMs: pos(s.timeout_ms, d.timeoutMs),
    maxAttempts: Math.floor(pos(s.max_attempts, d.maxAttempts)),
  };
}

/** Formato real pelos primeiros bytes (não confia só no Content-Type do provedor). */
export function detectFormat(b: Uint8Array): string | null {
  if (b.length < 12) return null;
  const s = (i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));
  if (s(0, 4) === 'OggS') return s(28, 8) === 'OpusHead' ? 'ogg-opus' : 'ogg';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (s(1, 3) === 'PNG') return 'png';
  if (s(0, 4) === 'RIFF' && s(8, 4) === 'WEBP') return 'webp';
  if (s(0, 4) === 'RIFF' && s(8, 4) === 'WAVE') return 'wav';
  if (s(4, 4) === 'ftyp') {
    const brand = s(8, 4).trim().toLowerCase();
    if (brand.startsWith('3g')) return '3gp';
    if (brand.startsWith('m4a') || brand === 'm4b') return 'm4a';
    if (brand === 'qt') return 'mov';
    return 'mp4';
  }
  if (s(0, 6) === '#!AMR\n') return 'amr';
  if (s(0, 3) === 'ID3') return 'mp3';
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return (b[1] & 0x06) === 0 ? 'aac' : 'mp3'; // ADTS (layer 0) ou MPEG áudio
  if (s(0, 5) === '%PDF-') return 'pdf';
  if (s(0, 4) === 'PK\u0003\u0004') return 'office'; // docx, xlsx, pptx (zip)
  if (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) return 'office-legacy'; // doc, xls, ppt
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'webm';
  return null;
}

/** Formatos aceitos por tipo e o MIME gravado no Storage. */
const ALLOWED: Record<MediaKind, Record<string, string>> = {
  audio: { 'ogg-opus': 'audio/ogg', ogg: 'audio/ogg', mp3: 'audio/mpeg', aac: 'audio/aac', amr: 'audio/amr', m4a: 'audio/mp4', mp4: 'audio/mp4' },
  image: { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' },
  video: { mp4: 'video/mp4', '3gp': 'video/3gpp', mov: 'video/quicktime' },
  document: {
    pdf: 'application/pdf', office: 'application/octet-stream', 'office-legacy': 'application/octet-stream',
  },
};

/**
 * Confere o arquivo baixado: tamanho real e formato pelos bytes.
 * Devolve o formato detectado e o MIME seguro para gravar.
 */
export function validateMedia(kind: MediaKind, media: DownloadedMedia, limits: MediaLimits): { format: string; mimeType: string } {
  if (media.sizeBytes === 0) throw new MediaError('media_content_invalid', 'Arquivo vazio.');
  if (media.sizeBytes > limits.maxBytes[kind]) throw new MediaError('media_too_large', 'Arquivo maior que o limite.');
  const format = detectFormat(media.bytes);
  if (!format) throw new MediaError('media_content_invalid', 'Formato do arquivo não reconhecido.');
  const mime = ALLOWED[kind][format];
  if (!mime) throw new MediaError('media_mime_unsupported', `Formato ${format} não aceito para ${kind}.`);
  // Documento do Office: mantém o MIME do provedor quando ele é de Office; senão, binário genérico.
  if (mime === 'application/octet-stream' && media.mimeType && /officedocument|msword|ms-excel|ms-powerpoint/.test(media.mimeType)) {
    return { format, mimeType: media.mimeType };
  }
  return { format, mimeType: mime };
}

/** Caminho no bucket privado: sempre começa pela empresa (isolamento). */
export function storagePath(workspaceId: string, conversationId: string, attachmentId: string, format: string): string {
  const ext = format.replace(/[^a-z0-9]/g, '').slice(0, 8) || 'bin';
  return `${workspaceId}/${conversationId}/${attachmentId}.${ext}`;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
