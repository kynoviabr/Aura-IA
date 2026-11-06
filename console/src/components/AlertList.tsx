import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';
import { Link } from 'react-router-dom';
import { ago, SEVERITY_LABEL, usd } from '@/lib/format';
import { cn } from '@/lib/utils';

export type Alert = {
  id: string; severity: string; kind: string; title: string; status: string; target_type: string; target_id: string;
  workspace_id: string | null; workspace?: { id: string; name: string } | null; detail: Record<string, unknown>;
  occurrences: number; created_at: string; last_seen_at: string; resolved_at: string | null;
};

const ICON = { critical: XCircle, warning: AlertTriangle, info: Info } as const;
const COLOR: Record<string, string> = {
  critical: 'text-[hsl(var(--danger-text))] bg-[hsl(var(--danger-bg))]',
  warning: 'text-[hsl(var(--warning))] bg-[hsl(var(--warning-bg))]',
  info: 'text-[hsl(var(--info))] bg-[hsl(var(--info-bg))]',
};

/** Explica o detalhe do alerta em uma linha. */
export function alertDetail(a: Alert): string {
  const d = a.detail || {};
  return String(d.reason || d.error || d.detail || (d.balance !== undefined ? `Saldo: ${Number(d.balance).toLocaleString('pt-BR')}` : '') || (d.balance_usd !== undefined ? `Saldo estimado: ${usd(Number(d.balance_usd))}` : '') || '');
}

export function AlertList({ alerts, onResolve, empty = 'Nenhum alerta aberto. Tudo funcionando.' }: { alerts: Alert[]; onResolve?: (a: Alert) => void; empty?: string }) {
  if (!alerts.length) {
    return <p className="flex items-center gap-2 p-5 text-sm text-muted-foreground"><CheckCircle2 className="h-4 w-4 text-[hsl(var(--success))]" /> {empty}</p>;
  }
  return (
    <ul className="divide-y">
      {alerts.map((a) => {
        const Icon = ICON[a.severity as keyof typeof ICON] ?? Info;
        return (
          <li key={a.id} className="flex items-start gap-3 px-5 py-3">
            <span className={cn('mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-btn', COLOR[a.severity] ?? COLOR.info)}><Icon className="h-4 w-4" /></span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">
                {a.title}
                {a.workspace && <> · <Link className="text-primary hover:underline" to={`/empresas/${a.workspace.id}`}>{a.workspace.name}</Link></>}
              </p>
              <p className="text-xs text-muted-foreground">
                {SEVERITY_LABEL[a.severity] || a.severity} · {a.status === 'open' ? `aberto ${ago(a.created_at)}` : `resolvido ${ago(a.resolved_at)}`}
                {a.occurrences > 1 && ` · ${a.occurrences} ocorrências`}
                {alertDetail(a) && ` · ${alertDetail(a)}`}
              </p>
            </div>
            {onResolve && a.status === 'open' && (
              <button className="shrink-0 text-xs font-medium text-primary hover:underline" onClick={() => onResolve(a)}>Marcar resolvido</button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
