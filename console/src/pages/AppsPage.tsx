import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Loader2, Pencil, Plus, RotateCcw } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { BrandButton } from '@/components/ui/brand-button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/hooks/use-toast';
import { StatusPill } from '@/components/StatusPill';
import { SecretReveal } from '@/components/SecretReveal';
import { useAuth } from '@/contexts/AuthContext';
import { consoleApi } from '@/lib/api';
import { ago, appState, dateTime, num } from '@/lib/format';

type App = {
  id: string; slug: string; name: string; api_key_prefix: string | null; webhook_url: string | null; api_base_url: string | null; is_active: boolean; created_at: string;
  last_delivery_ok_at: string | null; last_delivery_error_at: string | null; last_delivery_error: string | null; pending: number; failed: number; workspaces: number;
};

/** Produtos que usam a Aura IA: chave de acesso, endereço de avisos e se os avisos estão chegando. */
export default function AppsPage() {
  const { can } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<App | 'new' | null>(null);
  const [reveal, setReveal] = useState<{ title: string; items: { label: string; value: string }[] } | null>(null);
  const [eventsOf, setEventsOf] = useState<App | null>(null);
  const { data, isLoading } = useQuery({ queryKey: ['apps'], queryFn: () => consoleApi<{ apps: App[] }>('apps'), refetchInterval: 60_000 });
  const refresh = () => qc.invalidateQueries({ queryKey: ['apps'] });
  const fail = (e: unknown) => toast({ title: 'Não foi possível', description: (e as Error).message, variant: 'destructive' });

  const rotate = useMutation({
    mutationFn: (a: App) => consoleApi<{ apiKey: string }>('app_rotate_key', { id: a.id }),
    onSuccess: (r, a) => { setReveal({ title: `Nova chave do ${a.name}`, items: [{ label: 'AURA_API_KEY', value: r.apiKey }] }); refresh(); },
    onError: fail,
  });
  const retry = useMutation({
    mutationFn: (a: App) => consoleApi<{ retried: number }>('app_retry', { id: a.id }),
    onSuccess: (r) => { toast({ title: `${r.retried} aviso(s) colocados para reenviar` }); refresh(); },
    onError: fail,
  });

  return (
    <div>
      <PageHeader title="Aplicações conectadas" description="Os produtos da Kynovia que usam a Aura IA. Cada um tem a própria chave e recebe os avisos (mensagem nova, contato novo).">
        {can(['owner']) && <BrandButton onClick={() => setEditing('new')}><Plus className="h-4 w-4" /> Nova aplicação</BrandButton>}
      </PageHeader>
      {isLoading ? <p className="text-sm text-muted-foreground">Carregando…</p> : (
        <div className="grid gap-4 lg:grid-cols-2">
          {(data?.apps ?? []).map((a) => {
            const st = appState(a);
            return (
              <Card key={a.id} className="shadow-card"><CardContent className="space-y-3 p-5">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-heading text-lg font-semibold">{a.name}</p>
                    <p className="text-xs text-muted-foreground">{a.slug} · {num(a.workspaces)} empresa(s) · criada em {dateTime(a.created_at)}</p>
                  </div>
                  <StatusPill tone={st.tone}>{st.label}</StatusPill>
                </div>
                <div className="space-y-1 text-sm">
                  <p><span className="text-muted-foreground">Chave:</span> <code>{a.api_key_prefix}…</code></p>
                  <p className="truncate"><span className="text-muted-foreground">Avisos para:</span> {a.webhook_url || '—'}</p>
                  <p className="truncate"><span className="text-muted-foreground">API do produto (dados para a IA):</span> {a.api_base_url || '—'}</p>
                  <p><span className="text-muted-foreground">Último aviso entregue:</span> {ago(a.last_delivery_ok_at)}</p>
                  {a.last_delivery_error && <p className="text-xs text-[hsl(var(--danger-text))]">Último erro ({ago(a.last_delivery_error_at)}): {a.last_delivery_error}</p>}
                  <p className="text-xs text-muted-foreground">{num(a.pending)} na fila · {num(a.failed)} com falha</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <BrandButton size="sm" variant="outline" onClick={() => setEventsOf(a)}>Ver avisos</BrandButton>
                  {a.failed > 0 && can(['owner', 'operator']) && <BrandButton size="sm" variant="outline" onClick={() => retry.mutate(a)}><RotateCcw className="h-3.5 w-3.5" /> Reenviar com falha</BrandButton>}
                  {can(['owner']) && <BrandButton size="sm" variant="outline" onClick={() => setEditing(a)}><Pencil className="h-3.5 w-3.5" /> Editar</BrandButton>}
                  {can(['owner']) && (
                    <BrandButton size="sm" variant="ghost" disabled={rotate.isPending}
                      onClick={() => { if (confirm(`Gerar nova chave para ${a.name}? A chave atual para de funcionar na hora.`)) rotate.mutate(a); }}>
                      <KeyRound className="h-3.5 w-3.5" /> Nova chave
                    </BrandButton>
                  )}
                </div>
              </CardContent></Card>
            );
          })}
        </div>
      )}

      {editing && <AppDialog app={editing === 'new' ? null : editing} onClose={() => setEditing(null)}
        onCreated={(s, name) => setReveal({ title: `Chaves do ${name}`, items: [{ label: 'AURA_API_KEY', value: s.api_key }, { label: 'AURA_WEBHOOK_SECRET', value: s.webhook_secret }] })}
        onSaved={refresh} />}
      {reveal && <SecretReveal open title={reveal.title} items={reveal.items} onClose={() => setReveal(null)} />}
      {eventsOf && <EventsDialog app={eventsOf} onClose={() => setEventsOf(null)} />}
    </div>
  );
}

function AppDialog({ app, onClose, onCreated, onSaved }: { app: App | null; onClose: () => void; onCreated: (s: { api_key: string; webhook_secret: string }, name: string) => void; onSaved: () => void }) {
  const { toast } = useToast();
  const [name, setName] = useState(app?.name || '');
  const [slug, setSlug] = useState(app?.slug || '');
  const [url, setUrl] = useState(app?.webhook_url || '');
  const [apiUrl, setApiUrl] = useState(app?.api_base_url || '');
  const [active, setActive] = useState(app?.is_active ?? true);
  const save = useMutation({
    mutationFn: async () => app
      ? consoleApi('app_update', { id: app.id, name, webhookUrl: url, apiBaseUrl: apiUrl, isActive: active })
      : consoleApi<{ secrets: { api_key: string; webhook_secret: string } }>('app_create', { name, slug, webhookUrl: url }),
    onSuccess: (r) => { onSaved(); onClose(); if (!app) onCreated((r as { secrets: { api_key: string; webhook_secret: string } }).secrets, name); else toast({ title: 'Salvo' }); },
    onError: (e) => toast({ title: 'Não foi possível', description: (e as Error).message, variant: 'destructive' }),
  });
  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>{app ? `Editar ${app.name}` : 'Nova aplicação'}</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5"><Label>Nome</Label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="ex.: Belariz" /></div>
          {!app && <div className="space-y-1.5"><Label>Identificador</Label><Input value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} placeholder="ex.: belariz" /><p className="text-xs text-muted-foreground">Letras minúsculas, números e hífen. Não muda depois.</p></div>}
          <div className="space-y-1.5"><Label>Endereço de avisos (webhook)</Label><Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…/functions/v1/aura-webhook" /></div>
          {app && <div className="space-y-1.5"><Label>API do produto (dados para a IA)</Label><Input value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} placeholder="https://…/functions/v1/aura-api" /><p className="text-xs text-muted-foreground">Onde a Aura busca catálogo e dados da empresa. Assinado com o mesmo segredo dos avisos.</p></div>}
          {app && <div className="flex items-center justify-between rounded-lg border p-3"><span className="text-sm">Aplicação ativa</span><Switch checked={active} onCheckedChange={setActive} /></div>}
          <BrandButton className="w-full" disabled={save.isPending || !name || (!app && !slug)} onClick={() => save.mutate()}>{save.isPending && <Loader2 className="h-4 w-4 animate-spin" />} {app ? 'Salvar' : 'Criar e gerar chaves'}</BrandButton>
        </div>
      </DialogContent>
    </Dialog>
  );
}

type Ev = { id: string; type: string; status: string; attempts: number; last_error: string | null; created_at: string; delivered_at: string | null };
const EV_TONE: Record<string, 'ok' | 'warn' | 'bad'> = { delivered: 'ok', pending: 'warn', failed: 'bad' };
const EV_LABEL: Record<string, string> = { delivered: 'Entregue', pending: 'Na fila', failed: 'Falhou' };

function EventsDialog({ app, onClose }: { app: App; onClose: () => void }) {
  const { data, isLoading } = useQuery({ queryKey: ['app-events', app.id], queryFn: () => consoleApi<{ events: Ev[] }>('app_events', { id: app.id }) });
  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>Últimos avisos para {app.name}</DialogTitle></DialogHeader>
        {isLoading ? <p className="text-sm text-muted-foreground">Carregando…</p> : !data?.events.length ? <p className="text-sm text-muted-foreground">Nenhum aviso ainda.</p> : (
          <ul className="max-h-[60vh] divide-y overflow-y-auto">
            {data.events.map((e) => (
              <li key={e.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <div className="min-w-0"><p className="font-medium">{e.type}</p><p className="text-xs text-muted-foreground">{dateTime(e.created_at)} · {e.attempts} tentativa(s){e.last_error && ` · ${e.last_error}`}</p></div>
                <StatusPill tone={EV_TONE[e.status] || 'off'}>{EV_LABEL[e.status] || e.status}</StatusPill>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
