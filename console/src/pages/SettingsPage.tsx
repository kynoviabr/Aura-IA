import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2, UserPlus } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { BrandButton } from '@/components/ui/brand-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/contexts/AuthContext';
import { consoleApi } from '@/lib/api';
import { dateTime, ROLE_LABEL } from '@/lib/format';

type SettingsData = { settings: Record<string, unknown>; users: { user_id: string; email: string; role: string; created_at: string }[] };
type AuditEntry = { id: number; actor_email: string | null; action: string; target_type: string | null; target_id: string | null; detail: Record<string, unknown>; created_at: string };

const ACTION_LABEL: Record<string, string> = {
  provider_key_set: 'Cadastrou chave de IA', provider_updated: 'Alterou provedor de IA', credits_granted: 'Adicionou créditos', wallet_updated: 'Alterou carteira',
  package_saved: 'Salvou pacote', app_created: 'Criou aplicação', app_updated: 'Alterou aplicação', app_key_rotated: 'Gerou nova chave de aplicação',
  events_retried: 'Reenviou avisos', alert_resolved: 'Resolveu alerta', settings_saved: 'Alterou parâmetros', user_invited: 'Convidou pessoa',
  user_removed: 'Removeu pessoa', templates_created: 'Criou modelos de mensagem', eval_started: 'Rodou avaliação de IA',
};

export default function SettingsPage() {
  const { can, me } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['settings'], queryFn: () => consoleApi<SettingsData>('settings') });
  const audit = useQuery({ queryKey: ['audit'], queryFn: () => consoleApi<{ entries: AuditEntry[] }>('audit') });
  const [rate, setRate] = useState('');
  const [lowPct, setLowPct] = useState('');
  const [emails, setEmails] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('operator');
  useEffect(() => {
    if (!data) return;
    setRate(String(data.settings.credits_per_usd ?? 1000));
    setLowPct(String(data.settings.wallet_low_percent ?? 20));
    setEmails(((data.settings.alert_emails as string[]) || []).join(', '));
  }, [data]);
  const fail = (e: unknown) => toast({ title: 'Não foi possível', description: (e as Error).message, variant: 'destructive' });
  const save = useMutation({
    mutationFn: () => consoleApi('settings_save', { settings: {
      credits_per_usd: Number(rate), wallet_low_percent: Number(lowPct),
      alert_emails: emails.split(/[,\s;]+/).map((s) => s.trim()).filter(Boolean),
    } }),
    onSuccess: () => { toast({ title: 'Parâmetros salvos' }); qc.invalidateQueries({ queryKey: ['settings'] }); },
    onError: fail,
  });
  const invite = useMutation({
    mutationFn: () => consoleApi('user_invite', { email: inviteEmail, role: inviteRole, redirectTo: `${window.location.origin}/nova-senha` }),
    onSuccess: () => { toast({ title: 'Convite enviado', description: 'A pessoa recebe um e-mail para criar a senha.' }); setInviteEmail(''); qc.invalidateQueries({ queryKey: ['settings'] }); },
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: (userId: string) => consoleApi('user_remove', { userId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings'] }), onError: fail,
  });
  const owner = can(['owner']);

  return (
    <div>
      <PageHeader title="Configurações" description="Parâmetros da plataforma, equipe com acesso ao Console e histórico de alterações." />
      <Tabs defaultValue="params">
        <TabsList><TabsTrigger value="params">Parâmetros</TabsTrigger><TabsTrigger value="team">Equipe</TabsTrigger><TabsTrigger value="audit">Histórico</TabsTrigger></TabsList>

        <TabsContent value="params">
          <Card className="shadow-card"><CardContent className="grid gap-4 p-5 md:grid-cols-3">
            <div className="space-y-1.5"><Label>Créditos por US$ 1 de custo de IA</Label><Input disabled={!owner} inputMode="numeric" value={rate} onChange={(e) => setRate(e.target.value)} />
              <p className="text-xs text-muted-foreground">1.000 = 1 crédito cobre US$ 0,001 de custo real. A margem fica no preço do pacote.</p></div>
            <div className="space-y-1.5"><Label>Alerta de crédito baixo (% do último pacote)</Label><Input disabled={!owner} inputMode="numeric" value={lowPct} onChange={(e) => setLowPct(e.target.value)} /></div>
            <div className="space-y-1.5"><Label>E-mails que recebem alertas</Label><Input disabled={!owner} value={emails} onChange={(e) => setEmails(e.target.value)} placeholder="voce@kynovia.com.br, …" />
              <p className="text-xs text-muted-foreground">O envio por e-mail entra na próxima etapa; os alertas já aparecem aqui no Console.</p></div>
            {owner && <div className="md:col-span-3"><BrandButton onClick={() => save.mutate()} disabled={save.isPending}>Salvar parâmetros</BrandButton></div>}
          </CardContent></Card>
        </TabsContent>

        <TabsContent value="team">
          <Card className="shadow-card">
            <CardHeader className="pb-2"><CardTitle className="text-base">Quem acessa o Console</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <ul className="divide-y rounded-lg border">
                {(data?.users ?? []).map((u) => (
                  <li key={u.user_id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                    <div><p className="font-medium">{u.email}</p><p className="text-xs text-muted-foreground">{ROLE_LABEL[u.role] || u.role} · desde {dateTime(u.created_at)}</p></div>
                    {owner && u.user_id !== me?.id && <button className="rounded-btn p-2 text-muted-foreground hover:bg-muted hover:text-destructive" aria-label={`Remover ${u.email}`} onClick={() => { if (confirm(`Remover o acesso de ${u.email}?`)) remove.mutate(u.user_id); }}><Trash2 className="h-4 w-4" /></button>}
                  </li>
                ))}
              </ul>
              {owner && (
                <div className="flex flex-wrap items-end gap-2">
                  <div className="min-w-[220px] flex-1 space-y-1.5"><Label>E-mail</Label><Input type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} /></div>
                  <div className="space-y-1.5"><Label>Papel</Label>
                    <Select value={inviteRole} onValueChange={setInviteRole}><SelectTrigger className="w-[160px]"><SelectValue /></SelectTrigger>
                      <SelectContent><SelectItem value="owner">Dono (tudo)</SelectItem><SelectItem value="operator">Operador</SelectItem><SelectItem value="viewer">Só leitura</SelectItem></SelectContent></Select></div>
                  <BrandButton disabled={!inviteEmail || invite.isPending} onClick={() => invite.mutate()}><UserPlus className="h-4 w-4" /> Convidar</BrandButton>
                </div>
              )}
              <p className="text-xs text-muted-foreground">Dono: tudo, inclusive chaves e pacotes. Operador: créditos, verificações e alertas. Só leitura: vê tudo e não altera nada.</p>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="audit">
          <Card className="shadow-card"><CardContent className="p-0">
            <ul className="divide-y">
              {(audit.data?.entries ?? []).map((e) => (
                <li key={e.id} className="px-5 py-2.5 text-sm">
                  <p><b>{e.actor_email || 'Sistema'}</b> · {ACTION_LABEL[e.action] || e.action}{e.target_id && <span className="text-muted-foreground"> · {e.target_id}</span>}</p>
                  <p className="text-xs text-muted-foreground">{dateTime(e.created_at)}</p>
                </li>
              ))}
              {audit.data && audit.data.entries.length === 0 && <li className="p-5 text-sm text-muted-foreground">Nenhuma alteração registrada ainda.</li>}
            </ul>
          </CardContent></Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
