import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, KeyRound, Loader2, PlugZap } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { BrandButton } from '@/components/ui/brand-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/hooks/use-toast';
import { StatusPill } from '@/components/StatusPill';
import { useAuth } from '@/contexts/AuthContext';
import { consoleApi } from '@/lib/api';
import { ago, dateTime, num, PROVIDER_LABEL, usd } from '@/lib/format';

type Provider = {
  provider: string; enabled: boolean; status: string; key_hint: string | null; last_check_at: string | null; last_ok_at: string | null; last_error: string | null;
  balance_usd: number | null; balance_set_at: string | null; low_balance_usd: number; recharge_url: string;
};
type Price = { provider: string; model: string; label: string; input_per_mtok: number; cached_input_per_mtok: number; output_per_mtok: number; active: boolean };

/** Chaves da OpenAI e do Claude: cadastro seguro, teste, saldo estimado e recarga. */
export default function ProvidersPage() {
  const { data, isLoading } = useQuery({ queryKey: ['providers'], queryFn: () => consoleApi<{ providers: Provider[]; prices: Price[] }>('providers') });
  return (
    <div>
      <PageHeader title="Provedores de IA" description="As chaves ficam guardadas criptografadas e são testadas a cada 15 minutos. Os provedores não informam o saldo por API: registre o valor ao recarregar e a Aura desconta o que consome." />
      {isLoading || !data ? <p className="text-sm text-muted-foreground">Carregando…</p> : (
        <>
          <div className="grid gap-4 lg:grid-cols-2">{data.providers.map((p) => <ProviderCard key={p.provider} p={p} />)}</div>
          <Card className="mt-4 shadow-card">
            <CardHeader className="pb-2"><CardTitle className="text-base">Preços por milhão de tokens (US$)</CardTitle><p className="text-xs text-muted-foreground">Usados para calcular o custo de cada uso e os créditos cobrados.</p></CardHeader>
            <CardContent className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground"><tr><th className="py-1">Modelo</th><th className="py-1">Provedor</th><th className="py-1 text-right">Entrada</th><th className="py-1 text-right">Entrada em cache</th><th className="py-1 text-right">Saída</th></tr></thead>
                <tbody className="divide-y">{data.prices.map((m) => (
                  <tr key={m.model}><td className="py-1.5 font-medium">{m.label}<span className="ml-1 text-xs text-muted-foreground">{m.model}</span></td><td className="py-1.5">{PROVIDER_LABEL[m.provider]}</td><td className="py-1.5 text-right">{num(m.input_per_mtok, 2)}</td><td className="py-1.5 text-right">{num(m.cached_input_per_mtok, 2)}</td><td className="py-1.5 text-right">{num(m.output_per_mtok, 2)}</td></tr>
                ))}</tbody>
              </table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function ProviderCard({ p }: { p: Provider }) {
  const { can } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [key, setKey] = useState('');
  const [balance, setBalance] = useState('');
  const [low, setLow] = useState(String(p.low_balance_usd ?? 10));
  const refresh = () => { qc.invalidateQueries({ queryKey: ['providers'] }); qc.invalidateQueries({ queryKey: ['overview'] }); };
  const fail = (e: unknown) => toast({ title: 'Não foi possível', description: (e as Error).message, variant: 'destructive' });
  const testMsg = (r: { test: { ok: boolean; error?: string; latencyMs: number } }) =>
    toast({ title: r.test.ok ? 'Chave funcionando' : 'Chave com problema', description: r.test.ok ? `Resposta em ${r.test.latencyMs} ms` : r.test.error, variant: r.test.ok ? undefined : 'destructive' });

  const saveKey = useMutation({ mutationFn: () => consoleApi<{ test: { ok: boolean; error?: string; latencyMs: number } }>('provider_set_key', { provider: p.provider, key }), onSuccess: (r) => { setKey(''); testMsg(r); refresh(); }, onError: fail });
  const test = useMutation({ mutationFn: () => consoleApi<{ test: { ok: boolean; error?: string; latencyMs: number } }>('provider_test', { provider: p.provider }), onSuccess: (r) => { testMsg(r); refresh(); }, onError: fail });
  const update = useMutation({ mutationFn: (patch: Record<string, unknown>) => consoleApi('provider_update', { provider: p.provider, ...patch }), onSuccess: () => { toast({ title: 'Salvo' }); setBalance(''); refresh(); }, onError: fail });

  const tone = !p.key_hint ? 'off' : p.status === 'ok' ? 'ok' : p.status === 'error' ? 'bad' : 'warn';
  const owner = can(['owner']);
  const lowNow = p.balance_usd !== null && Number(p.balance_usd) < Number(p.low_balance_usd);

  return (
    <Card className="shadow-card">
      <CardHeader className="flex-row items-start justify-between gap-3 pb-2">
        <div><CardTitle className="text-base">{PROVIDER_LABEL[p.provider]}</CardTitle><p className="text-xs text-muted-foreground">{p.key_hint ? `Chave ${p.key_hint}` : 'Nenhuma chave cadastrada'} · testada {ago(p.last_check_at)}</p></div>
        <StatusPill tone={tone}>{!p.key_hint ? 'Sem chave' : p.status === 'ok' ? 'Funcionando' : p.status === 'error' ? 'Com erro' : 'Não testada'}</StatusPill>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {p.last_error && <p className="rounded-lg bg-[hsl(var(--danger-bg))] p-2 text-xs text-[hsl(var(--danger-text))]">{p.last_error}</p>}

        <div className="flex items-center justify-between rounded-lg border p-3">
          <div><p className="font-medium">Usar este provedor</p><p className="text-xs text-muted-foreground">Ligado: entra no teste automático e pode ser usado pela IA.</p></div>
          <Switch checked={p.enabled} disabled={!owner || !p.key_hint} onCheckedChange={(v) => update.mutate({ enabled: v })} />
        </div>

        <div className="rounded-lg border p-3">
          <p className="label-stripe">Saldo estimado</p>
          <p className={`font-heading text-2xl font-bold ${lowNow ? 'text-[hsl(var(--danger-text))]' : ''}`}>{p.balance_usd === null ? '—' : usd(p.balance_usd)}</p>
          <p className="text-xs text-muted-foreground">{p.balance_set_at ? `Registrado em ${dateTime(p.balance_set_at)}, menos o consumo desde então.` : 'Registre o saldo atual para acompanhar.'} Alerta abaixo de {usd(p.low_balance_usd)}.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <a href={p.recharge_url} target="_blank" rel="noreferrer"><BrandButton size="sm"><ExternalLink className="h-3.5 w-3.5" /> Recarregar no site</BrandButton></a>
          </div>
          {owner && (
            <div className="mt-3 grid grid-cols-2 gap-2">
              <div className="space-y-1"><Label className="text-xs">Saldo atual no site (US$)</Label>
                <div className="flex gap-1"><Input inputMode="decimal" value={balance} onChange={(e) => setBalance(e.target.value)} placeholder="ex.: 50" />
                  <BrandButton size="sm" variant="outline" disabled={!balance} onClick={() => update.mutate({ balanceUsd: Number(balance.replace(',', '.')) })}>Salvar</BrandButton></div></div>
              <div className="space-y-1"><Label className="text-xs">Avisar abaixo de (US$)</Label>
                <div className="flex gap-1"><Input inputMode="decimal" value={low} onChange={(e) => setLow(e.target.value)} />
                  <BrandButton size="sm" variant="outline" onClick={() => update.mutate({ lowBalanceUsd: Number(low.replace(',', '.')) })}>Salvar</BrandButton></div></div>
            </div>
          )}
        </div>

        {owner && (
          <div className="space-y-1.5">
            <Label>{p.key_hint ? 'Trocar a chave' : 'Cadastrar a chave'}</Label>
            <div className="flex gap-2">
              <Input type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder={p.provider === 'anthropic' ? 'sk-ant-…' : 'sk-…'} />
              <BrandButton className="shrink-0 whitespace-nowrap" disabled={key.length < 20 || saveKey.isPending} onClick={() => saveKey.mutate()}>{saveKey.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />} Salvar e testar</BrandButton>
            </div>
            <p className="text-xs text-muted-foreground">A chave é guardada criptografada e nunca mais aparece inteira.</p>
          </div>
        )}
        {p.key_hint && can(['owner', 'operator']) && (
          <BrandButton size="sm" variant="outline" disabled={test.isPending} onClick={() => test.mutate()}>{test.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PlugZap className="h-3.5 w-3.5" />} Testar agora</BrandButton>
        )}
      </CardContent>
    </Card>
  );
}
