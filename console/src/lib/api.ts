import { supabase } from './supabase';

export class ConsoleError extends Error {
  constructor(message: string, public code?: string) { super(message); }
}

/** Chama a função console-api da Aura IA (confere o login e o papel da pessoa). */
export async function consoleApi<T = Record<string, unknown>>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.functions.invoke('console-api', { body: { action, ...payload } });
  if (error) {
    const ctx = (error as { context?: unknown }).context;
    if (typeof Response !== 'undefined' && ctx instanceof Response) {
      const body = (await ctx.clone().json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
      if (body?.error?.message) throw new ConsoleError(body.error.message, body.error.code);
    }
    throw new ConsoleError(error.message);
  }
  return data as T;
}
