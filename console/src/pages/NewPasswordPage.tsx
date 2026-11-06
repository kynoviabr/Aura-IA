import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { BrandButton } from '@/components/ui/brand-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/** Link do e-mail (convite ou "esqueci a senha"): define a senha e entra. */
export default function NewPasswordPage() {
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < 10) { setError('Use pelo menos 10 caracteres.'); return; }
    const { error: err } = await supabase.auth.updateUser({ password });
    if (err) setError(err.message); else navigate('/', { replace: true });
  };
  return (
    <div className="min-h-screen gradient-hero flex items-center justify-center p-4">
      <form onSubmit={save} className="w-full max-w-sm space-y-4 rounded-modal bg-card p-8 shadow-stripe-xl">
        <h1 className="font-heading text-xl font-bold">Criar senha do Console</h1>
        <div className="space-y-1.5"><Label htmlFor="np">Nova senha</Label><Input id="np" type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <BrandButton type="submit" className="w-full">Salvar e entrar</BrandButton>
      </form>
    </div>
  );
}
