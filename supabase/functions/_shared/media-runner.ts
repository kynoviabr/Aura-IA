/**
 * Baixa os anexos recebidos e guarda no bucket privado (MM-0).
 * Chamado em segundo plano pelo webhook (download imediato) e a cada minuto pelo dispatch-events
 * (novas tentativas e limpeza dos arquivos que passaram do prazo de guarda).
 * Nunca registra em log URL, chave ou conteúdo: só ids e códigos de erro.
 */
import { MediaError, mediaLimits, sha256Hex, storagePath, validateMedia, type DownloadedMedia, type MediaKind, type MediaLimits } from './media.ts';

type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;

export const INBOUND_BUCKET = 'inbound-media';

export type MediaDeps = {
  rpc: Rpc;
  /** Limites salvos em platform_settings (chave media_limits). */
  loadLimits: () => Promise<unknown>;
  download: (provider: string, ref: string, maxBytes: number, timeoutMs: number) => Promise<DownloadedMedia>;
  upload: (path: string, bytes: Uint8Array, contentType: string) => Promise<void>;
  remove: (paths: string[]) => Promise<void>;
};

type Claimed = {
  id: string; workspace_id: string; conversation_id: string; kind: MediaKind; provider: string;
  provider_attachment_id: string; declared_mime_type: string | null; attempts: number;
};

export type MediaRunResult = { processed: number; failed: number; retry: number };

async function processOne(deps: MediaDeps, a: Claimed, limits: MediaLimits): Promise<'processed' | 'failed' | 'retry'> {
  let result: Record<string, unknown>;
  let outcome: 'processed' | 'failed' | 'retry';
  try {
    const media = await deps.download(a.provider, a.provider_attachment_id, limits.maxBytes[a.kind], limits.timeoutMs);
    if (!media.mimeType && a.declared_mime_type) media.mimeType = a.declared_mime_type;
    const { format, mimeType } = validateMedia(a.kind, media, limits);
    const path = storagePath(a.workspace_id, a.conversation_id, a.id, format);
    try {
      await deps.upload(path, media.bytes, mimeType);
    } catch {
      throw new MediaError('media_storage_error', 'Falha ao gravar no Storage.', true);
    }
    result = { ok: true, mimeType, format, sizeBytes: media.sizeBytes, sha256: await sha256Hex(media.bytes), storagePath: path };
    outcome = 'processed';
  } catch (e) {
    const err = e instanceof MediaError ? e : new MediaError('media_provider_error', 'Erro inesperado.', true);
    result = { ok: false, code: err.code, retry: err.retryable };
    outcome = err.retryable && a.attempts < limits.maxAttempts ? 'retry' : 'failed';
    console.warn('media', a.id, err.code, `tentativa ${a.attempts}`);
  }
  const { error } = await deps.rpc('aura_finish_attachment', { p_id: a.id, p_result: result });
  if (error) console.error('aura_finish_attachment', a.id, error.message);
  return outcome;
}

/** Baixa os anexos pedidos (ids) ou, sem ids, os que estão na hora de tentar de novo. */
export async function processAttachments(deps: MediaDeps, ids: string[] | null, limit = 10): Promise<MediaRunResult> {
  const out: MediaRunResult = { processed: 0, failed: 0, retry: 0 };
  if (ids && !ids.length) return out;
  const { data, error } = await deps.rpc('aura_claim_attachments', { p_ids: ids, p_limit: limit });
  if (error) throw new Error(error.message);
  const claimed = (data as Claimed[]) || [];
  if (!claimed.length) return out;
  const limits = mediaLimits(await deps.loadLimits().catch(() => null));
  for (const a of claimed) out[await processOne(deps, a, limits)]++;
  return out;
}

/** Apaga do Storage os arquivos que passaram do prazo de guarda. */
export async function purgeExpiredAttachments(deps: MediaDeps, limit = 50): Promise<number> {
  const { data, error } = await deps.rpc('aura_attachments_to_purge', { p_limit: limit });
  if (error) throw new Error(error.message);
  const rows = (data as Array<{ id: string; storage_path: string }>) || [];
  if (!rows.length) return 0;
  await deps.remove(rows.map((r) => r.storage_path));
  const { data: n, error: markError } = await deps.rpc('aura_mark_attachments_purged', { p_ids: rows.map((r) => r.id) });
  if (markError) throw new Error(markError.message);
  return Number(n) || 0;
}
