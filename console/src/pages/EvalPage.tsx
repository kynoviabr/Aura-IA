import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FlaskConical, Loader2, ThumbsDown, ThumbsUp } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { BrandButton } from '@/components/ui/brand-button';
import { Progress } from '@/components/ui/progress';
import { StatusPill } from '@/components/StatusPill';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/contexts/AuthContext';
import { consoleApi } from '@/lib/api';
import { dateTime, num, PROVIDER_LABEL, usd } from '@/lib/format';
import { cn } from '@/lib/utils';

type Pair = { id: string; title: string; models: { provider: string; model: string }[] };
type Run = { id: string; title: string; status: string; total: number; completed: number; error: string | null; created_by_email: string | null; created_at: string; finished_at: string | null; models: { provider: string; model: string }[] };
type Result = { id: string; scenario_id: string; scenario_title: string; category: string; expectation: string | null; provider: string; model: string;
  output: string | null; outcome: string; error: string | null; latency_ms: number | null; input_tokens: number; output_tokens: number; cost_usd: number; rating: number | null };
type Msg = { role: 'user' | 'assistant'; content: string };

const MODEL_LABEL: Record<string, string> = {
  'claude-haiku-5-5': 'Claude Haiku 5.5', 'claude-sonnet-5-5': 'Claude Sonnet 5.5', 'claude-opus-5-5': 'Claude Opus 5.5',
  'gpt-6-luna': 'GPT-6 Luna', 'gpt-6.1-terra': 'GPT-6.1 Terra', 'gpt-6.1-sol': 'GPT-6.1 Sol',
};
const label = (m: string) => MODEL_LABEL[m] || m;

/** Prova lado a lado: as mesmas conversas para dois modelos; a equipe compara e marca 👍/👎. */
export default function EvalPage() {
  const { can } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const pairs = useQuery({ queryKey: ['eval-pairs'], queryFn: () => consoleApi<{ pairs: Pair[]; scenarios: number }>('eval_pairs') });
  const runs = useQuery({
    queryKey: ['eval-runs'], queryFn: () => consoleApi<{ runs: Run[] }>('eval_runs'),
    refetchInterval: (q) => (q.state.data?.runs.some((r) => r.status === 'running') ? 4000 : false),
  });
  const start = useMutation({
    mutationFn: (pair: string) => consoleApi<{ runId: string }>('eval_start', { pair }),
    onSuccess: (r) => { setSelected(r.runId); qc.invalidateQueries({ queryKey: ['eval-runs'] }); toast({ title: 'Prova iniciada', description: 'As respostas aparecem conforme chegam (1 a 2 minutos).' }); },
    onError: (e) => toast({ title: 'Não foi possível iniciar', description: (e as Error).message, variant: 'destructive' }),
  });
  const current = selected || runs.data?.runs[0]?.id || null;

  return (
    <div>
      <PageHeader title="Avaliação de IA" description={`Prova lado a lado: as mesmas ${pairs.data?.scenarios ?? ''} conversas típicas de clínica para dois modelos. Compare as respostas, o tempo e o custo, e marque 👍 ou 👎.`} />

      {can(['owner', 'operator']) && (
        <div className="mb-4 grid gap-3 md:grid-cols-2">
          {(pairs.data?.pairs ?? []).map((p) => (
            <Card key={p.id} className="shadow-card"><CardContent className="flex items-center justify-between gap-3 p-4">
              <div><p className="font-medium">{p.title}</p><p className="text-xs text-muted-foreground">{p.models.map((m) => `${label(m.model)} (${PROVIDER_LABEL[m.provider]})`).join(' × ')}</p></div>
              <BrandButton size="sm" disabled={start.isPending} onClick={() => start.mutate(p.id)}>
                {start.isPending && start.variables === p.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FlaskConical className="h-3.5 w-3.5" />} Rodar
              </BrandButton>
            </CardContent></Card>
          ))}
        </div>
      )}

      {(runs.data?.runs.length ?? 0) > 0 && (
        <div className="mb-4 flex flex-wrap gap-1 text-xs">
          {runs.data!.runs.map((r) => (
            <button key={r.id} onClick={() => setSelected(r.id)}
              className={cn('rounded-full px-3 py-1', current === r.id ? 'bg-primary text-primary-foreground' : 'bg-muted hover:bg-muted/70')}>
              {r.title.split(':')[0]} · {dateTime(r.created_at)}{r.status === 'running' ? ' · rodando' : ''}
            </button>
          ))}
        </div>
      )}

      {current ? <RunView id={current} /> : runs.isLoading ? <p className="text-sm text-muted-foreground">Carregando…</p> : (
        <p className="text-sm text-muted-foreground">Nenhuma prova ainda. Escolha uma acima e clique em Rodar.</p>
      )}
    </div>
  );
}

function RunView({ id }: { id: string }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['eval-run', id], queryFn: () => consoleApi<{ run: Run; results: Result[]; scenarios: Record<string, Msg[]> }>('eval_run', { id }),
    refetchInterval: (q) => (q.state.data?.run.status === 'running' ? 3000 : false),
  });
  const rate = useMutation({
    mutationFn: ({ r, v }: { r: Result; v: number | null }) => consoleApi('eval_rate', { id: r.id, rating: v }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['eval-run', id] }),
  });
  if (!data) return <p className="text-sm text-muted-foreground">Carregando…</p>;
  const { run, results, scenarios } = data;
  const models = run.models.map((m) => m.model);
  const byScenario = new Map<string, Result[]>();
  for (const r of results) byScenario.set(r.scenario_id, [...(byScenario.get(r.scenario_id) || []), r]);

  const summary = models.map((m) => {
    const rs = results.filter((r) => r.model === m);
    const ok = rs.filter((r) => r.outcome === 'ok');
    return {
      model: m, provider: run.models.find((x) => x.model === m)?.provider || '', count: rs.length, errors: rs.length - ok.length,
      avgMs: ok.length ? Math.round(ok.reduce((s, r) => s + (r.latency_ms || 0), 0) / ok.length) : 0,
      cost: rs.reduce((s, r) => s + Number(r.cost_usd), 0),
      perAnswer: ok.length ? rs.reduce((s, r) => s + Number(r.cost_usd), 0) / ok.length : 0,
      up: rs.filter((r) => r.rating === 1).length, down: rs.filter((r) => r.rating === -1).length,
    };
  });

  return (
    <div className="space-y-4">
      {run.status === 'running' && (
        <Card className="shadow-card"><CardContent className="space-y-2 p-4">
          <p className="flex items-center gap-2 text-sm"><Loader2 className="h-4 w-4 animate-spin" /> Rodando: {run.completed} de {run.total} respostas</p>
          <Progress value={run.total ? (run.completed / run.total) * 100 : 0} />
        </CardContent></Card>
      )}
      {run.status === 'failed' && <p className="rounded-lg bg-[hsl(var(--danger-bg))] p-3 text-sm text-[hsl(var(--danger-text))]">A prova parou: {run.error}</p>}

      <div className="grid gap-3 md:grid-cols-2">
        {summary.map((s) => (
          <Card key={s.model} className="shadow-card"><CardContent className="p-4">
            <p className="font-heading text-lg font-semibold">{label(s.model)}</p>
            <p className="text-xs text-muted-foreground">{PROVIDER_LABEL[s.provider]}</p>
            <div className="mt-3 grid grid-cols-4 gap-2 text-center">
              <Stat label="Avaliação" value={`${s.up} 👍 · ${s.down} 👎`} />
              <Stat label="Tempo médio" value={s.avgMs ? `${(s.avgMs / 1000).toFixed(1).replace('.', ',')} s` : '—'} />
              <Stat label="Custo por resposta" value={usd(s.perAnswer)} />
              <Stat label="Falhas" value={num(s.errors)} bad={s.errors > 0} />
            </div>
            <p className="mt-2 text-xs text-muted-foreground">Custo total da prova: {usd(s.cost)} · {num(s.count)} resposta(s)</p>
          </CardContent></Card>
        ))}
      </div>

      {[...byScenario.entries()].map(([sid, rs]) => {
        const first = rs[0];
        const convo = scenarios[sid] || [];
        return (
          <Card key={sid} className="shadow-card">
            <CardHeader className="pb-2">
              <div className="flex flex-wrap items-center gap-2"><CardTitle className="text-base">{first.scenario_title}</CardTitle><StatusPill tone="off">{first.category}</StatusPill></div>
              {first.expectation && <p className="text-xs text-muted-foreground"><b>Boa resposta:</b> {first.expectation}</p>}
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1 rounded-lg bg-[#efeae2] p-3">
                {convo.map((m, i) => (
                  <div key={i} className={cn('flex', m.role === 'assistant' ? 'justify-end' : 'justify-start')}>
                    <p className={cn('max-w-[85%] whitespace-pre-wrap rounded-lg px-2.5 py-1.5 text-sm shadow-sm', m.role === 'assistant' ? 'bg-[#d9fdd3]' : 'bg-white')}>{m.content}</p>
                  </div>
                ))}
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                {models.map((m) => {
                  const r = rs.find((x) => x.model === m);
                  return (
                    <div key={m} className="rounded-lg border p-3">
                      <div className="mb-2 flex items-center justify-between gap-2 text-xs">
                        <span className="font-semibold">{label(m)}</span>
                        {r && <span className="text-muted-foreground">{r.latency_ms ? `${(r.latency_ms / 1000).toFixed(1).replace('.', ',')} s` : ''} · {usd(r.cost_usd)} · {num(r.output_tokens)} tokens</span>}
                      </div>
                      {!r ? <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> aguardando…</p>
                        : r.outcome !== 'ok' ? <p className="text-sm text-[hsl(var(--danger-text))]">{r.outcome === 'refused' ? 'Recusou responder.' : r.error}</p>
                        : <p className="whitespace-pre-wrap rounded-lg bg-[#d9fdd3] px-2.5 py-1.5 text-sm">{r.output}</p>}
                      {r && can(['owner', 'operator']) && (
                        <div className="mt-2 flex gap-1">
                          <button aria-label="Boa" onClick={() => rate.mutate({ r, v: r.rating === 1 ? null : 1 })}
                            className={cn('rounded-btn p-1.5 hover:bg-muted', r.rating === 1 && 'bg-[hsl(var(--success-bg))] text-[hsl(var(--success))]')}><ThumbsUp className="h-4 w-4" /></button>
                          <button aria-label="Ruim" onClick={() => rate.mutate({ r, v: r.rating === -1 ? null : -1 })}
                            className={cn('rounded-btn p-1.5 hover:bg-muted', r.rating === -1 && 'bg-[hsl(var(--danger-bg))] text-[hsl(var(--danger-text))]')}><ThumbsDown className="h-4 w-4" /></button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

function Stat({ label: l, value, bad }: { label: string; value: string; bad?: boolean }) {
  return <div><p className="text-[10px] uppercase tracking-wide text-muted-foreground">{l}</p><p className={cn('text-sm font-semibold', bad && 'text-[hsl(var(--danger-text))]')}>{value}</p></div>;
}
