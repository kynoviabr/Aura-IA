import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { Search } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { StatusPill } from '@/components/StatusPill';
import { consoleApi } from '@/lib/api';
import { ago, channelState, num, phone, usd } from '@/lib/format';

export type WorkspaceRow = {
  id: string; name: string; external_id: string; status: string; app_name: string; app_slug: string;
  channel_id: string | null; channel_status: string; health: string; health_detail: string | null; phone_number: string | null;
  last_inbound_at: string | null; last_outbound_at: string | null; last_error: string | null; conversations: number; messages_month: number;
  ai_cost_month_usd: number; ai_credits_month: number; ai_calls_month: number; credit_balance: number | null; hard_stop: boolean; alerts_open: number;
};

const FILTERS: Record<string, (w: WorkspaceRow) => boolean> = {
  todas: () => true,
  problema: (w) => ['bad', 'warn'].includes(channelState(w.channel_status, w.health).tone) || w.alerts_open > 0,
  'sem-credito': (w) => w.credit_balance !== null && Number(w.credit_balance) <= 0,
  'sem-whatsapp': (w) => w.channel_status === 'not_started',
};

/** Todas as empresas de todos os produtos: número, situação, movimento, custo de IA e créditos. */
export default function WorkspacesPage() {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState('');
  const situacao = params.get('situacao') || 'todas';
  const app = params.get('produto') || 'todos';
  const { data, isLoading } = useQuery({ queryKey: ['workspaces'], queryFn: () => consoleApi<{ workspaces: WorkspaceRow[] }>('workspaces'), refetchInterval: 60_000 });
  const rows = data?.workspaces ?? [];
  const apps = [...new Set(rows.map((r) => r.app_name))];
  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    const digits = term.replace(/\D/g, '');
    return rows.filter((w) => (FILTERS[situacao] ?? FILTERS.todas)(w))
      .filter((w) => app === 'todos' || w.app_name === app)
      .filter((w) => !term || w.name.toLowerCase().includes(term) || (digits.length >= 3 && (w.phone_number || '').replace(/\D/g, '').includes(digits)));
  }, [rows, q, situacao, app]);
  const set = (k: string, v: string) => { const n = new URLSearchParams(params); n.set(k, v); setParams(n, { replace: true }); };

  return (
    <div>
      <PageHeader title="Empresas e números" description="Cada clínica ou estúdio, o número de WhatsApp ligado, a situação e quanto de IA consumiu no mês." />
      <div className="mb-4 flex flex-wrap gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input className="pl-8" placeholder="Buscar empresa ou número" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Select value={app} onValueChange={(v) => set('produto', v)}>
          <SelectTrigger className="w-[170px]"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="todos">Todos os produtos</SelectItem>{apps.map((a) => <SelectItem key={a} value={a}>{a}</SelectItem>)}</SelectContent>
        </Select>
        <Select value={situacao} onValueChange={(v) => set('situacao', v)}>
          <SelectTrigger className="w-[190px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="todas">Todas as situações</SelectItem>
            <SelectItem value="problema">Com problema</SelectItem>
            <SelectItem value="sem-credito">Sem crédito</SelectItem>
            <SelectItem value="sem-whatsapp">Sem WhatsApp</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Card className="shadow-card"><CardContent className="p-0">
        {isLoading ? <p className="p-6 text-sm text-muted-foreground">Carregando…</p> : filtered.length === 0 ? (
          <p className="p-6 text-sm text-muted-foreground">Nenhuma empresa encontrada.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b bg-bg-subtle text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-2.5 font-semibold">Empresa</th>
                  <th className="px-4 py-2.5 font-semibold">Número</th>
                  <th className="px-4 py-2.5 font-semibold">Situação</th>
                  <th className="px-4 py-2.5 font-semibold">Última mensagem</th>
                  <th className="px-4 py-2.5 text-right font-semibold">Mensagens/mês</th>
                  <th className="px-4 py-2.5 text-right font-semibold">IA no mês</th>
                  <th className="px-4 py-2.5 text-right font-semibold">Créditos</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {filtered.map((w) => {
                  const st = channelState(w.channel_status, w.health);
                  const last = [w.last_inbound_at, w.last_outbound_at].filter(Boolean).sort().pop() || null;
                  const credit = w.credit_balance === null ? null : Number(w.credit_balance);
                  return (
                    <tr key={w.id} className="hover:bg-bg-subtle/60">
                      <td className="px-4 py-3">
                        <Link to={`/empresas/${w.id}`} className="font-medium text-foreground hover:text-primary">{w.name}</Link>
                        <p className="text-xs text-muted-foreground">{w.app_name}{w.alerts_open > 0 && <span className="text-[hsl(var(--danger-text))]"> · {w.alerts_open} alerta(s)</span>}</p>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">{w.phone_number ? phone(w.phone_number) : <span className="text-muted-foreground">—</span>}</td>
                      <td className="px-4 py-3"><StatusPill tone={st.tone}>{st.label}</StatusPill>{w.health_detail && st.tone !== 'ok' && <p className="mt-1 max-w-[220px] truncate text-xs text-muted-foreground" title={w.health_detail}>{w.health_detail}</p>}</td>
                      <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">{ago(last)}</td>
                      <td className="px-4 py-3 text-right">{num(w.messages_month)}</td>
                      <td className="px-4 py-3 text-right whitespace-nowrap">{usd(w.ai_cost_month_usd)}<p className="text-xs text-muted-foreground">{num(w.ai_calls_month)} uso(s)</p></td>
                      <td className={`px-4 py-3 text-right whitespace-nowrap ${credit !== null && credit <= 0 ? 'font-semibold text-[hsl(var(--danger-text))]' : ''}`}>{credit === null ? <span className="text-muted-foreground">sem carteira</span> : num(credit, 1)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent></Card>
    </div>
  );
}
