import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { AlertTriangle, Bell, Building2, MessagesSquare, Phone, Sparkles, Wallet } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { BrandStat } from '@/components/ui/brand-stat';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusPill } from '@/components/StatusPill';
import { UsageChart, type UsageDay } from '@/components/UsageChart';
import { AlertList, type Alert } from '@/components/AlertList';
import { consoleApi } from '@/lib/api';
import { ago, num, PROVIDER_LABEL, usd } from '@/lib/format';

type Overview = {
  overview: {
    apps: number; workspaces: number; channels_connected: number; channels_problem: number; messages_today: number; messages_in_today: number;
    ai_cost_month_usd: number; ai_credits_month: number; ai_calls_month: number; alerts_open: number; alerts_critical: number;
    events_pending: number; events_failed: number; wallets_empty: number;
  };
  usage: UsageDay[];
  alerts: Alert[];
  providers: { provider: string; enabled: boolean; status: string; key_hint: string | null; balance_usd: number | null; low_balance_usd: number; last_check_at: string | null; last_error: string | null; recharge_url: string }[];
};

export default function OverviewPage() {
  const { data, isLoading } = useQuery({ queryKey: ['overview'], queryFn: () => consoleApi<Overview>('overview'), refetchInterval: 60_000 });
  const o = data?.overview;
  const allOk = o && o.alerts_open === 0;

  return (
    <div>
      <PageHeader title="Visão geral" description="WhatsApp e IA de todos os produtos da Kynovia, num lugar só.">
        {o && <StatusPill tone={allOk ? 'ok' : o.alerts_critical ? 'bad' : 'warn'}>{allOk ? 'Tudo funcionando' : `${o.alerts_open} alerta(s) aberto(s)`}</StatusPill>}
      </PageHeader>

      {isLoading || !o ? <p className="text-sm text-muted-foreground">Carregando…</p> : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <BrandStat label="Empresas ativas" value={num(o.workspaces)} icon={Building2} />
            <BrandStat label="Números conectados" value={num(o.channels_connected)} icon={Phone} />
            <BrandStat label="Mensagens hoje" value={num(o.messages_today)} icon={MessagesSquare} />
            <BrandStat label="Custo de IA no mês" value={usd(o.ai_cost_month_usd)} icon={Sparkles} />
          </div>

          <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <ProblemTile to="/empresas?situacao=problema" label="Números com problema" value={o.channels_problem} />
            <ProblemTile to="/alertas" label="Alertas críticos" value={o.alerts_critical} icon={Bell} />
            <ProblemTile to="/aplicacoes" label="Avisos com falha" value={o.events_failed} hint={o.events_pending ? `${o.events_pending} na fila` : undefined} />
            <ProblemTile to="/empresas?situacao=sem-credito" label="Empresas sem crédito" value={o.wallets_empty} icon={Wallet} />
          </div>

          <div className="mt-6 grid gap-4 lg:grid-cols-3">
            <Card className="shadow-card lg:col-span-2">
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Custo de IA · últimos 30 dias</CardTitle>
                <p className="text-xs text-muted-foreground">{num(o.ai_calls_month)} uso(s) no mês · {num(o.ai_credits_month, 1)} créditos cobrados das empresas</p>
              </CardHeader>
              <CardContent><UsageChart data={data!.usage} /></CardContent>
            </Card>
            <Card className="shadow-card">
              <CardHeader className="pb-2"><CardTitle className="text-base">Provedores de IA</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                {data!.providers.map((p) => (
                  <Link key={p.provider} to="/ia" className="block rounded-lg border p-3 hover:border-border-hover">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium">{PROVIDER_LABEL[p.provider]}</span>
                      <StatusPill tone={!p.key_hint ? 'off' : p.status === 'ok' ? 'ok' : p.status === 'error' ? 'bad' : 'warn'}>
                        {!p.key_hint ? 'Sem chave' : p.status === 'ok' ? 'Funcionando' : p.status === 'error' ? 'Com erro' : 'Não testada'}
                      </StatusPill>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {p.balance_usd !== null ? `Saldo estimado ${usd(p.balance_usd)}` : 'Saldo não informado'} · testada {ago(p.last_check_at)}
                    </p>
                    {p.last_error && <p className="mt-1 text-xs text-[hsl(var(--danger-text))]">{p.last_error}</p>}
                  </Link>
                ))}
              </CardContent>
            </Card>
          </div>

          <Card className="mt-4 shadow-card">
            <CardHeader className="flex-row items-center justify-between pb-0">
              <CardTitle className="text-base">Alertas abertos</CardTitle>
              <Link to="/alertas" className="text-xs font-medium text-primary hover:underline">Ver todos</Link>
            </CardHeader>
            <CardContent className="p-0 pt-2"><AlertList alerts={data!.alerts} /></CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function ProblemTile({ to, label, value, hint, icon: Icon = AlertTriangle }: { to: string; label: string; value: number; hint?: string; icon?: typeof AlertTriangle }) {
  const bad = value > 0;
  return (
    <Link to={to} className={`rounded-card border p-4 shadow-stripe-sm transition-all hover:-translate-y-0.5 hover:shadow-stripe-md ${bad ? 'border-[hsl(var(--danger-text)/0.35)] bg-[hsl(var(--danger-bg))]' : 'bg-card'}`}>
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground"><Icon className="h-3.5 w-3.5" /> {label}</div>
      <p className={`mt-1 font-heading text-2xl font-bold ${bad ? 'text-[hsl(var(--danger-text))]' : ''}`}>{num(value)}</p>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </Link>
  );
}
