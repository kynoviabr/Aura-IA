import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PageHeader } from '@/components/ui/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { AlertList, type Alert } from '@/components/AlertList';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/contexts/AuthContext';
import { consoleApi } from '@/lib/api';

/** Alertas: abrem e fecham sozinhos (ex.: número reconectou, crédito recarregado); dá para fechar à mão. */
export default function AlertsPage() {
  const { can } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [status, setStatus] = useState<'open' | 'resolved' | 'all'>('open');
  const { data, isLoading } = useQuery({ queryKey: ['alerts', status], queryFn: () => consoleApi<{ alerts: Alert[] }>('alerts', { status }), refetchInterval: 60_000 });
  const resolve = useMutation({
    mutationFn: (a: Alert) => consoleApi('alert_resolve', { id: a.id }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['alerts'] }); qc.invalidateQueries({ queryKey: ['overview'] }); qc.invalidateQueries({ queryKey: ['alerts-count'] }); },
    onError: (e) => toast({ title: 'Não foi possível', description: (e as Error).message, variant: 'destructive' }),
  });
  const tabs: [typeof status, string][] = [['open', 'Abertos'], ['resolved', 'Resolvidos'], ['all', 'Todos']];
  return (
    <div>
      <PageHeader title="Alertas" description="Número desconectado, chave de IA com erro, crédito acabando, produto sem receber avisos. Fecham sozinhos quando o problema é resolvido." />
      <div className="mb-3 flex gap-1 text-xs">
        {tabs.map(([k, l]) => <button key={k} onClick={() => setStatus(k)} className={`rounded-full px-3 py-1 ${status === k ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}>{l}</button>)}
      </div>
      <Card className="shadow-card"><CardContent className="p-0">
        {isLoading ? <p className="p-5 text-sm text-muted-foreground">Carregando…</p> : (
          <AlertList alerts={data?.alerts ?? []} onResolve={can(['owner', 'operator']) ? (a) => resolve.mutate(a) : undefined}
            empty={status === 'open' ? 'Nenhum alerta aberto. Tudo funcionando.' : 'Nada por aqui.'} />
        )}
      </CardContent></Card>
    </div>
  );
}
