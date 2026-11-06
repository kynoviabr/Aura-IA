import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL || 'https://kkkxyvchdtjagvmevxve.supabase.co';
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || '';

/** Login do Console (equipe Kynovia) no Supabase da Aura IA. */
export const supabase = createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true } });
