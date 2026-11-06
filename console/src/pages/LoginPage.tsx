import { useState } from 'react';
import { Activity, Loader2 } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { BrandButton } from '@/components/ui/brand-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/contexts/AuthContext';

export default function LoginPage() {
  const { denied, session, signOut } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [resetSent, setResetSent] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError('');
    const { error: err } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (err) setError(err.message === 'Invalid login credentials' ? 'E-mail ou senha incorretos.' : err.message);
  };

  const reset = async () => {
    if (!email) { setError('Digite seu e-mail para receber o link.'); return; }
    await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/nova-senha` });
    setResetSent(true);
  };

  return (
    <div className="min-h-screen gradient-hero flex items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-modal bg-card p-8 shadow-stripe-xl">
        <div className="mb-6 flex items-center gap-3">
          <div className="w-10 h-10 rounded-btn bg-primary flex items-center justify-center shadow-glow"><Activity className="w-5 h-5 text-white" /></div>
          <div>
            <h1 className="font-heading text-xl font-bold">Aura IA</h1>
            <p className="text-xs text-muted-foreground">Console da plataforma · Kynovia</p>
          </div>
        </div>
        {session && denied ? (
          <div className="space-y-4">
            <p className="text-sm">{denied}</p>
            <p className="text-xs text-muted-foreground">Peça a um dono do Console para liberar o seu e-mail.</p>
            <BrandButton variant="outline" className="w-full" onClick={signOut}>Entrar com outra conta</BrandButton>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-1.5"><Label htmlFor="email">E-mail</Label><Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></div>
            <div className="space-y-1.5"><Label htmlFor="pass">Senha</Label><Input id="pass" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} /></div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            {resetSent && <p className="text-sm text-[hsl(var(--success))]">Enviamos o link para criar a senha.</p>}
            <BrandButton type="submit" className="w-full" disabled={busy}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Entrar</BrandButton>
            <button type="button" onClick={reset} className="w-full text-center text-xs text-primary hover:underline">Esqueci ou ainda não tenho senha</button>
          </form>
        )}
      </div>
    </div>
  );
}
