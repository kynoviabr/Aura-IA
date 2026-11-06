import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Pencil, Plus } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { BrandButton } from '@/components/ui/brand-button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/hooks/use-toast';
import { StatusPill } from '@/components/StatusPill';
import { useAuth } from '@/contexts/AuthContext';
import { consoleApi } from '@/lib/api';
import { brl, num, usd } from '@/lib/format';
import type { WorkspaceRow } from './WorkspacesPage';

type Pkg = { id: string; name: string; credits: number; price_brl: number; active: boolean };

/** Pacotes de créditos de IA que a Kynovia vende, e o saldo de cada empresa. */
export default function CreditsPage() {
  const { can } = useAuth();
  const [editing, setEditing] = useState<Pkg | 'new' | null>(null);
  const packages = useQuery({ queryKey: ['packages'], queryFn: () => consoleApi<{ packages: Pkg[] }>('packages') });
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => consoleApi<{ settings: Record<string, unknown> }>('settings') });
  const workspaces = useQuery({ queryKey: ['workspaces'], queryFn: () => consoleApi<{ workspaces: WorkspaceRow[] }>('workspaces') });
  const rate = Number(settings.data?.settings.credits_per_usd ?? 1000);
  const rows = [...(workspaces.data?.workspaces ?? [])].sort((a, b) => Number(a.credit_balance ?? 0) - Number(b.credit_balance ?? 0));

  return (
    <div>
      <PageHeader title="Créditos e pacotes" description={`Cada uso de IA consome créditos conforme o custo real (hoje: ${num(rate)} créditos = ${usd(1)} de custo). Você vende pacotes de créditos às empresas.`}>
        {can(['owner']) && <BrandButton onClick={() => setEditing('new')}><Plus className="h-4 w-4" /> Novo pacote</BrandButton>}
      </PageHeader>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {(packages.data?.packages ?? []).map((p) => {
          const cost = Number(p.credits) / rate;
          const margin = Number(p.price_brl) > 0 ? p.price_brl : 0;
          return (
            <Card key={p.id} className={`shadow-card ${p.active ? '' : 'opacity-60'}`}><CardContent className="space-y-2 p-5">
              <div className="flex items-start justify-between gap-2"><p className="font-heading font-semibold">{p.name}</p>{!p.active && <StatusPill tone="off">Inativo</StatusPill>}</div>
              <p className="font-heading text-2xl font-bold">{num(p.credits)} <span className="text-sm font-medium text-muted-foreground">créditos</span></p>
              <p className="text-sm">{brl(p.price_brl)}</p>
              <p className="text-xs text-muted-foreground">Custo de IA coberto: até {usd(cost)}{margin ? '' : ''}</p>
              {can(['owner']) && <button className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline" onClick={() => setEditing(p)}><Pencil className="h-3 w-3" /> Editar</button>}
            </CardContent></Card>
          );
        })}
        {packages.data && packages.data.packages.length === 0 && <p className="text-sm text-muted-foreground">Nenhum pacote cadastrado ainda.</p>}
      </div>

      <Card className="mt-6 shadow-card">
        <CardHeader className="pb-2"><CardTitle className="text-base">Saldo por empresa</CardTitle></CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b bg-bg-subtle text-left text-xs uppercase tracking-wide text-muted-foreground"><tr><th className="px-4 py-2.5">Empresa</th><th className="px-4 py-2.5">Produto</th><th className="px-4 py-2.5 text-right">Consumo no mês</th><th className="px-4 py-2.5 text-right">Saldo</th></tr></thead>
            <tbody className="divide-y">{rows.map((w) => {
              const bal = w.credit_balance === null ? null : Number(w.credit_balance);
              return (
                <tr key={w.id}>
                  <td className="px-4 py-2.5"><Link className="font-medium hover:text-primary" to={`/empresas/${w.id}`}>{w.name}</Link></td>
                  <td className="px-4 py-2.5 text-muted-foreground">{w.app_name}</td>
                  <td className="px-4 py-2.5 text-right">{num(w.ai_credits_month, 1)} <span className="text-xs text-muted-foreground">({usd(w.ai_cost_month_usd)})</span></td>
                  <td className={`px-4 py-2.5 text-right font-medium ${bal !== null && bal <= 0 ? 'text-[hsl(var(--danger-text))]' : ''}`}>{bal === null ? <span className="font-normal text-muted-foreground">sem carteira</span> : num(bal, 1)}</td>
                </tr>
              );
            })}</tbody>
          </table>
        </CardContent>
      </Card>
      {editing && <PackageDialog pkg={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function PackageDialog({ pkg, onClose }: { pkg: Pkg | null; onClose: () => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [name, setName] = useState(pkg?.name || '');
  const [credits, setCredits] = useState(pkg ? String(pkg.credits) : '');
  const [price, setPrice] = useState(pkg ? String(pkg.price_brl) : '');
  const [active, setActive] = useState(pkg?.active ?? true);
  const save = useMutation({
    mutationFn: () => consoleApi('package_save', { id: pkg?.id, name, credits: Number(credits), priceBrl: Number(price.replace(',', '.')), active }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['packages'] }); toast({ title: 'Pacote salvo' }); onClose(); },
    onError: (e) => toast({ title: 'Não foi possível', description: (e as Error).message, variant: 'destructive' }),
  });
  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>{pkg ? 'Editar pacote' : 'Novo pacote'}</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5"><Label>Nome</Label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="ex.: Essencial IA" /></div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5"><Label>Créditos</Label><Input inputMode="numeric" value={credits} onChange={(e) => setCredits(e.target.value)} placeholder="ex.: 5000" /></div>
            <div className="space-y-1.5"><Label>Preço de venda (R$)</Label><Input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="ex.: 49,90" /></div>
          </div>
          <div className="flex items-center justify-between rounded-lg border p-3"><span className="text-sm">Disponível para venda</span><Switch checked={active} onCheckedChange={setActive} /></div>
          <BrandButton className="w-full" disabled={save.isPending || !name || !credits || !price} onClick={() => save.mutate()}>Salvar</BrandButton>
        </div>
      </DialogContent>
    </Dialog>
  );
}
