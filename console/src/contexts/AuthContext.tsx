import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import { consoleApi } from '@/lib/api';

export type ConsoleMe = { id: string; email: string; role: 'owner' | 'operator' | 'viewer' };

type AuthState = {
  session: Session | null;
  me: ConsoleMe | null;
  loading: boolean;
  denied: string | null;
  signOut: () => Promise<void>;
  can: (roles: ConsoleMe['role'][]) => boolean;
};

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [me, setMe] = useState<ConsoleMe | null>(null);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); if (!data.session) setLoading(false); });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => { setSession(s); if (!s) { setMe(null); setLoading(false); } });
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) return;
    setLoading(true);
    consoleApi<{ me: ConsoleMe }>('me')
      .then((r) => { setMe(r.me); setDenied(null); })
      .catch((e) => { setMe(null); setDenied((e as Error).message); })
      .finally(() => setLoading(false));
  }, [session?.user.id]);

  const value: AuthState = {
    session, me, loading, denied,
    signOut: async () => { await supabase.auth.signOut(); },
    can: (roles) => !!me && roles.includes(me.role),
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth fora do AuthProvider');
  return v;
}
