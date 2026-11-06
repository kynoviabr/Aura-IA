import { cn } from '@/lib/utils';
import type { Tone } from '@/lib/format';

const TONES: Record<Tone, string> = {
  ok: 'bg-[hsl(var(--success-bg))] text-[hsl(var(--success))]',
  warn: 'bg-[hsl(var(--warning-bg))] text-[hsl(var(--warning))]',
  bad: 'bg-[hsl(var(--danger-bg))] text-[hsl(var(--danger-text))]',
  off: 'bg-bg-subtle text-[hsl(var(--text-secondary))]',
};

/** Etiqueta de situação no padrão dos produtos (fundo suave + ponto). */
export function StatusPill({ tone, children, className }: { tone: Tone; children: React.ReactNode; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-pill px-2.5 py-0.5 text-xs font-semibold leading-5 whitespace-nowrap', TONES[tone], className)}>
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
      {children}
    </span>
  );
}
