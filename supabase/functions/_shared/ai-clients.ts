// Só roda no Deno (imports npm:); fora do typecheck do Node (ver tsconfig.json). Tipos conferidos em check:functions.
/** Clientes dos provedores de IA com as chaves guardadas no cofre (só no servidor). */
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';
import Anthropic from 'npm:@anthropic-ai/sdk@0.137.0';
import OpenAI from 'npm:openai@7.39.0';
import type { Clients } from './llm.ts';

export async function aiClients(db: SupabaseClient): Promise<Clients> {
  const [{ data: ak }, { data: ok }] = await Promise.all([
    db.rpc('aura_get_provider_key', { p_provider: 'anthropic' }),
    db.rpc('aura_get_provider_key', { p_provider: 'openai' }),
  ]);
  return {
    anthropic: ak ? (new Anthropic({ apiKey: String(ak), maxRetries: 2 }) as unknown as Clients['anthropic']) : undefined,
    openai: ok ? (new OpenAI({ apiKey: String(ok), maxRetries: 2 }) as unknown as Clients['openai']) : undefined,
  };
}
