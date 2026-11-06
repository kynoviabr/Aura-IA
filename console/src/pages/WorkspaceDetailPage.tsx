import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Coins, Loader2, RefreshCw, Stethoscope } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { BrandButton } from '@/components/ui/brand-button';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { StatusPill } from '@/components/StatusPill';
import { UsageChart, type UsageDay } from '@/components/UsageChart';
import { AlertList, type Alert } from '@/components/AlertList';
import { useAuth } from '@/contexts/AuthContext';
import { consoleApi } from '@/lib/api';
import { ago, brl, channelState, dateTime, FEATURE_LABEL, num, phone, usd } from '@/lib/format';

type Detail = {
  workspace: { id: string; name: string; external_id: string; status: string; timezone: string; created_at: string; app: { name: string; slug: string } };
  channel: null | { id: string; status: string; health: string; health_detail: string | null; health_checked_at: string | null; phone_number: string | null;
    display_name: string | null; connected_at: string | null; last_inbound_at: string | null; last_outbound_at: string | null; last_error: string | null; last_error_at: string | null };
  wallet: null | { balance: number; hard_stop: boolean; last_grant: number | null };
  ledger: { id: number; kind: string; amount: number; balance_after: number; note: string | null; created_at: string }[];
  usage: UsageDay[];
  alerts: Alert[];
  breakdown: Record<string, { calls: number; cost_usd: number; credits: number; input: number; output: number }>;
  suggestions?: { total: number; sent: number; sent_edited: number; errors: number };
  turns?: Turn[];
};
type Turn = {
  id: string; outcome: 'sent' | 'fallback' | 'skipped' | 'error'; handoff: boolean; sent_text: string | null; error: string | null;
  tools: { name: string; summary?: string }[]; booking_id: string | null; latency_ms: number | null; model: string; created_at: string;
};
const TURN_LABEL: Record<Turn['outcome'], { label: string; tone: 'ok' | 'warn' | 'bad' }> = {
  sent: { label: 'Respondeu', tone: 'ok' }, fallback: { label: 'Passou para a equipe', tone: 'warn' },
  skipped: { label: 'Não respondeu', tone: 'warn' }, error: { label: 'Erro', tone: 'bad' },
};
const TOOL_LABEL: Record<string, string> = {
  verificar_horarios: 'consultou agenda', agendar: 'agendou', meus_agendamentos: 'viu agendamentos',
  cancelar_agendamento: 'cancelou', passar_para_equipe: 'chamou a equipe',
};
type Pkg = { id: string; name: string; credits: number; price_brl: number; active: boolean };
type Template = { name: string; language: string; category: string; status: string; body: string };

const KIND_LABEL: Record<string, string> = { purchase: 'Compra de pacote', bonus: 'Bônus', adjustment: 'Ajuste', usage: 'Uso' };
const TEMPLATE_STATUS: Record<string, { label: string; tone: 'ok' | 'warn' | 'bad' | 'off' }> = {
  APPROVED: { label: 'Aprovado', tone: 'ok' }, PENDING: { label: 'Em revisão', tone: 'warn' }, REJECTED: { label: 'Recusado', tone: 'bad' },
};

export default function WorkspaceDetailPage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [grantOpen, setGrantOpen] = useState(false);
  const { data, isLoading } = useQuery({ queryKey: ['workspace', id], queryFn: () => consoleApi<Detail>('workspace', { id }) });
  const ch = data?.channel;
  const templates = useQuery({
    queryKey: ['templates', ch?.id], enabled: !!ch?.id && ch.status === 'connected',
    queryFn: () => consoleApi<{ templates: Template[] }>('channel_templates', { id: ch!.id }),
  });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['workspace', id] }); qc.invalidateQueries({ queryKey: ['workspaces'] }); };
  const fail = (e: unknown) => toast({ title: 'Não foi possível', description: (e as Error).message, variant: 'destructive' });

  const check = useMutation({
    mutationFn: () => consoleApi<{ health: string; detail: string | null }>('channel_check', { id: ch!.id }),
    onSuccess: (r) => { toast({ title: r.health === 'healthy' ? 'Número funcionando' : 'Número com problema', description: r.detail || undefined }); refresh(); },
    onError: fail,
  });
  const createTemplates = useMutation({
    mutationFn: () => consoleApi<{ result: { created: string[]; existing: string[]; failed: { name: string; error: string }[] } }>('channel_templates_create', { id: ch!.id }),
    onSuccess: (r) => {
      toast({ title: `${r.result.created.length} modelo(s) enviados para aprovação`, description: r.result.failed.length ? `Falharam: ${r.result.failed.map((f) => `${f.name} (${f.error})`).join(', ')}` : undefined });
      templates.refetch();
    },
    onError: fail,
  });
  const hardStop = useMutation({
    mutationFn: (v: boolean) => consoleApi('wallet_update', { workspaceId: id, hardStop: v }),
    onSuccess: refresh, onError: fail,
  });

  if (isLoading || !data) return <p className="text-sm text-muted-foreground">Carregando…</p>;
  const st = channelState(ch?.status, ch?.health);
  const balance = data.wallet ? Number(data.wallet.balance) : null;
  const monthCost = data.usage.reduce((s, d) => s + Number(d.cost_usd), 0);
  const monthCredits = data.usage.reduce((s, d) => s + Number(d.credits), 0);

  return (
    <div>
      <Link to="/empresas" className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" /> Empresas</Link>
      <PageHeader title={data.workspace.name} description={`${data.workspace.app.name} · id no produto: ${data.workspace.external_id}`}>
        <StatusPill tone={st.tone}>{st.label}</StatusPill>
      </PageHeader>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="shadow-card">
          <CardHeader className="flex-row items-center justify-between pb-2">
            <CardTitle className="text-base">WhatsApp</CardTitle>
            {ch && ch.status !== 'not_started' && can(['owner', 'operator']) && (
              <BrandButton size="sm" variant="outline" onClick={() => check.mutate()} disabled={check.isPending}>
                {check.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Stethoscope className="h-3.5 w-3.5" />} Verificar agora
              </BrandButton>
            )}
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {!ch ? <p className="text-muted-foreground">Esta empresa ainda não conectou um número.</p> : (
              <>
                <Row label="Número" value={ch.phone_number ? phone(ch.phone_number) : '—'} />
                <Row label="Nome no WhatsApp" value={ch.display_name || '—'} />
                <Row label="Conectado em" value={dateTime(ch.connected_at)} />
                <Row label="Última mensagem recebida" value={ago(ch.last_inbound_at)} />
                <Row label="Última mensagem enviada" value={ago(ch.last_outbound_at)} />
                <Row label="Última verificação" value={ago(ch.health_checked_at)} />
                {ch.health_detail && <p className="rounded-lg bg-[hsl(var(--warning-bg))] p-2 text-xs text-[hsl(var(--warning))]">{ch.health_detail}</p>}
                {ch.last_error && <p className="rounded-lg bg-[hsl(var(--danger-bg))] p-2 text-xs text-[hsl(var(--danger-text))]">Último erro de envio ({ago(ch.last_error_at)}): {ch.last_error}</p>}
              </>
            )}
          </CardContent>
        </Card>

        <Card className="shadow-card">
          <CardHeader className="flex-row items-center justify-between pb-2">
            <CardTitle className="text-base">Créditos de IA</CardTitle>
            {can(['owner', 'operator']) && <BrandButton size="sm" onClick={() => setGrantOpen(true)}><Coins className="h-3.5 w-3.5" /> Adicionar créditos</BrandButton>}
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div>
              <p className="label-stripe">Saldo</p>
              <p className={`font-heading text-3xl font-bold ${balance !== null && balance <= 0 ? 'text-[hsl(var(--danger-text))]' : ''}`}>{balance === null ? '—' : num(balance, 1)}</p>
              <p className="text-xs text-muted-foreground">Últimos 30 dias: {num(monthCredits, 1)} créditos · custo real {usd(monthCost)}</p>
            </div>
            <div className="flex items-center justify-between rounded-lg border p-3">
              <div>
                <p className="font-medium">Parar a IA quando o crédito acabar</p>
                <p className="text-xs text-muted-foreground">Desligado: a empresa continua usando e o saldo fica negativo (ex.: contrato mensal).</p>
              </div>
              <Switch checked={data.wallet?.hard_stop ?? true} disabled={!can(['owner', 'operator'])} onCheckedChange={(v) => hardStop.mutate(v)} />
            </div>
            {data.ledger.length > 0 && (
              <ul className="divide-y rounded-lg border">
                {data.ledger.slice(0, 8).map((l) => (
                  <li key={l.id} className="flex items-center justify-between gap-2 px-3 py-2 text-xs">
                    <span>{KIND_LABEL[l.kind] || l.kind}{l.note && <span className="text-muted-foreground"> · {l.note}</span>}</span>
                    <span className="whitespace-nowrap"><b className={Number(l.amount) < 0 ? 'text-[hsl(var(--danger-text))]' : 'text-[hsl(var(--success))]'}>{Number(l.amount) > 0 ? '+' : ''}{num(l.amount, 1)}</b> <span className="text-muted-foreground">· {dateTime(l.created_at)}</span></span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="mt-4 shadow-card">
        <CardHeader className="pb-2"><CardTitle className="text-base">Uso de IA · últimos 30 dias</CardTitle></CardHeader>
        <CardContent>
          <UsageChart data={data.usage} />
          {!!data.suggestions?.total && (
            <p className="mt-3 text-sm text-muted-foreground">
              Copiloto: <b className="text-foreground">{num(data.suggestions.total)}</b> sugestões ·{' '}
              <b className="text-foreground">{num(data.suggestions.sent)}</b> enviadas sem mudar ·{' '}
              <b className="text-foreground">{num(data.suggestions.sent_edited)}</b> enviadas com ajuste ·{' '}
              {num(Math.round(((data.suggestions.sent + data.suggestions.sent_edited) / data.suggestions.total) * 100))}% aproveitadas
              {data.suggestions.errors > 0 && <> · {num(data.suggestions.errors)} com erro</>}
            </p>
          )}
          {Object.keys(data.breakdown).length > 0 && (
            <table className="mt-4 w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground"><tr><th className="py-1">Uso · modelo</th><th className="py-1 text-right">Usos</th><th className="py-1 text-right">Tokens (entrada/saída)</th><th className="py-1 text-right">Custo</th><th className="py-1 text-right">Créditos</th></tr></thead>
              <tbody className="divide-y">
                {Object.entries(data.breakdown).map(([k, v]) => {
                  const [feature, model] = k.split(' · ');
                  return <tr key={k}><td className="py-1.5">{FEATURE_LABEL[feature] || feature} · {model}</td><td className="py-1.5 text-right">{num(v.calls)}</td><td className="py-1.5 text-right">{num(v.input)} / {num(v.output)}</td><td className="py-1.5 text-right">{usd(v.cost_usd)}</td><td className="py-1.5 text-right">{num(v.credits, 1)}</td></tr>;
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card className="mt-4 shadow-card">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Atendimento automático</CardTitle>
          <p className="text-sm text-muted-foreground">
            Modo da IA: <b className="text-foreground">{({ off: 'Desligada', copilot: 'Sugerir resposta', auto: 'Automático' } as Record<string, string>)[String((data.workspace as { ai_mode?: string }).ai_mode)] || '—'}</b> (a empresa escolhe no produto).
          </p>
        </CardHeader>
        <CardContent>
          {!data.turns?.length ? <p className="text-sm text-muted-foreground">Nenhuma resposta automática ainda.</p> : (
            <ul className="divide-y rounded-lg border">
              {data.turns.map((t) => (
                <li key={t.id} className="space-y-1 px-4 py-2.5 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusPill tone={TURN_LABEL[t.outcome].tone}>{TURN_LABEL[t.outcome].label}</StatusPill>
                    {t.handoff && <StatusPill tone="warn">Equipe chamada</StatusPill>}
                    {t.booking_id && <StatusPill tone="ok">Agenda alterada</StatusPill>}
                    <span className="text-xs text-muted-foreground">{dateTime(t.created_at)} · {t.model}{t.latency_ms ? ` · ${(t.latency_ms / 1000).toFixed(1)}s` : ''}</span>
                  </div>
                  {t.tools.length > 0 && <p className="text-xs text-muted-foreground">Ações: {t.tools.map((x) => TOOL_LABEL[x.name] || x.name).join(', ')}</p>}
                  {t.sent_text && <p className="whitespace-pre-wrap">{t.sent_text}</p>}
                  {t.error && <p className="text-xs text-[hsl(var(--danger-text))]">{t.error}</p>}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {ch?.status === 'connected' && (
        <Card className="mt-4 shadow-card">
          <CardHeader className="flex-row items-center justify-between pb-2">
            <CardTitle className="text-base">Modelos de mensagem (Meta)</CardTitle>
            {can(['owner', 'operator']) && (
              <BrandButton size="sm" variant="outline" onClick={() => createTemplates.mutate()} disabled={createTemplates.isPending}>
                {createTemplates.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Criar modelos padrão que faltam
              </BrandButton>
            )}
          </CardHeader>
          <CardContent className="p-0">
            {templates.isLoading ? <p className="p-5 text-sm text-muted-foreground">Carregando…</p> : templates.error ? (
              <p className="p-5 text-sm text-muted-foreground">Não foi possível ler os modelos: {(templates.error as Error).message}</p>
            ) : !templates.data?.templates.length ? <p className="p-5 text-sm text-muted-foreground">Nenhum modelo neste número.</p> : (
              <ul className="divide-y">
                {templates.data.templates.map((t) => {
                  const s = TEMPLATE_STATUS[t.status] || { label: t.status || '—', tone: 'off' as const };
                  return (
                    <li key={`${t.name}-${t.language}`} className="flex items-start justify-between gap-3 px-5 py-3">
                      <div className="min-w-0"><p className="text-sm font-medium">{t.name} <span className="text-xs text-muted-foreground">· {t.language} · {t.category}</span></p><p className="truncate text-xs text-muted-foreground">{t.body}</p></div>
                      <StatusPill tone={s.tone}>{s.label}</StatusPill>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      )}

      <Card className="mt-4 shadow-card">
        <CardHeader className="pb-0"><CardTitle className="text-base">Alertas desta empresa</CardTitle></CardHeader>
        <CardContent className="p-0 pt-2"><AlertList alerts={data.alerts} empty="Nenhum alerta para esta empresa." /></CardContent>
      </Card>

      <GrantDialog open={grantOpen} onOpenChange={setGrantOpen} workspaceId={id} onDone={refresh} />
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return <div className="flex justify-between gap-3"><span className="text-muted-foreground">{label}</span><span className="text-right font-medium">{value}</span></div>;
}

function GrantDialog({ open, onOpenChange, workspaceId, onDone }: { open: boolean; onOpenChange: (v: boolean) => void; workspaceId: string; onDone: () => void }) {
  const { toast } = useToast();
  const [mode, setMode] = useState<'package' | 'manual'>('package');
  const [packageId, setPackageId] = useState('');
  const [amount, setAmount] = useState('');
  const [kind, setKind] = useState('bonus');
  const [note, setNote] = useState('');
  const packages = useQuery({ queryKey: ['packages'], queryFn: () => consoleApi<{ packages: Pkg[] }>('packages'), enabled: open });
  const grant = useMutation({
    mutationFn: () => consoleApi<{ balance: number }>('grant_credits', mode === 'package'
      ? { workspaceId, packageId, kind: 'purchase', note }
      : { workspaceId, amount: Number(amount.replace(',', '.')), kind, note }),
    onSuccess: (r) => { toast({ title: 'Créditos adicionados', description: `Novo saldo: ${num(r.balance, 1)}` }); onOpenChange(false); setNote(''); setAmount(''); onDone(); },
    onError: (e) => toast({ title: 'Não foi possível', description: (e as Error).message, variant: 'destructive' }),
  });
  const active = (packages.data?.packages ?? []).filter((p) => p.active);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>Adicionar créditos</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="flex gap-1 text-xs">
            <button type="button" onClick={() => setMode('package')} className={`rounded-full px-3 py-1 ${mode === 'package' ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}>Pacote vendido</button>
            <button type="button" onClick={() => setMode('manual')} className={`rounded-full px-3 py-1 ${mode === 'manual' ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}>Bônus ou ajuste</button>
          </div>
          {mode === 'package' ? (
            active.length === 0 ? <p className="text-sm text-muted-foreground">Nenhum pacote cadastrado. Crie em Créditos e pacotes.</p> : (
              <div className="space-y-1.5"><Label>Pacote</Label>
                <Select value={packageId} onValueChange={setPackageId}><SelectTrigger><SelectValue placeholder="Escolha o pacote" /></SelectTrigger>
                  <SelectContent>{active.map((p) => <SelectItem key={p.id} value={p.id}>{p.name} · {num(p.credits)} créditos · {brl(p.price_brl)}</SelectItem>)}</SelectContent></Select>
              </div>
            )
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5"><Label>Tipo</Label>
                <Select value={kind} onValueChange={setKind}><SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="bonus">Bônus (cortesia)</SelectItem><SelectItem value="adjustment">Ajuste (+ ou −)</SelectItem></SelectContent></Select>
              </div>
              <div className="space-y-1.5"><Label>Créditos</Label><Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="ex.: 500" /></div>
            </div>
          )}
          <div className="space-y-1.5"><Label>Observação</Label><Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="ex.: Pix recebido em 08/11, NF 123" /></div>
          <BrandButton className="w-full" disabled={grant.isPending || (mode === 'package' ? !packageId : !amount)} onClick={() => grant.mutate()}>
            {grant.isPending && <Loader2 className="h-4 w-4 animate-spin" />} Adicionar
          </BrandButton>
        </div>
      </DialogContent>
    </Dialog>
  );
}
