// Só roda no Deno (imports npm:); fora do typecheck do Node (ver tsconfig.json). Tipos conferidos em check:functions.
/** Liga o processamento de mídia (media-runner.ts) ao Supabase e ao provedor de WhatsApp. */
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';
import { INBOUND_BUCKET, type MediaDeps } from './media-runner.ts';
import { MediaError } from './media.ts';
import { ZernioClient } from './zernio.ts';

export function mediaDeps(db: SupabaseClient): MediaDeps {
  let zernio: ZernioClient | null = null;
  return {
    rpc: (fn, args) => db.rpc(fn, args),
    loadLimits: async () => (await db.from('platform_settings').select('value').eq('key', 'media_limits').maybeSingle()).data?.value,
    download: (provider, ref, maxBytes, timeoutMs) => {
      if (provider !== 'zernio') throw new MediaError('media_reference_invalid', `Provedor ${provider} sem download.`);
      zernio ??= new ZernioClient((Deno.env.get('ZERNIO_API_KEY') || '').trim());
      return zernio.downloadMedia(ref, maxBytes, timeoutMs);
    },
    upload: async (path, bytes, contentType) => {
      const { error } = await db.storage.from(INBOUND_BUCKET).upload(path, bytes, { contentType, upsert: true });
      if (error) throw new Error(error.message);
    },
    remove: async (paths) => {
      const { error } = await db.storage.from(INBOUND_BUCKET).remove(paths);
      if (error) throw new Error(error.message);
    },
  };
}
