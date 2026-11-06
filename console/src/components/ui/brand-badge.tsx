import * as React from 'react';
import { cn } from '@/lib/utils';

type BadgeStatus =
  | 'active' | 'paid' | 'pending' | 'overdue' | 'cancelled' | 'completed'
  | 'draft' | 'sent' | 'scheduled' | 'confirmed' | 'no_show' | 'in_progress'
  | 'approved' | 'rejected' | 'expired' | 'signed' | 'default';

interface BrandBadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  status?: BadgeStatus;
  withDot?: boolean;
}

/**
 * Stripe-style status badge.
 * Soft bg + dark text + optional status dot. No colored borders.
 */
const statusStyles: Record<BadgeStatus, string> = {
  active: 'bg-[hsl(var(--success-bg))] text-[hsl(var(--success))]',
  paid: 'bg-[hsl(var(--success-bg))] text-[hsl(var(--success))]',
  completed: 'bg-[hsl(var(--success-bg))] text-[hsl(var(--success))]',
  confirmed: 'bg-[hsl(var(--success-bg))] text-[hsl(var(--success))]',
  approved: 'bg-[hsl(var(--success-bg))] text-[hsl(var(--success))]',
  signed: 'bg-[hsl(var(--success-bg))] text-[hsl(var(--success))]',
  pending: 'bg-[hsl(var(--warning-bg))] text-[hsl(var(--warning))]',
  scheduled: 'bg-[hsl(var(--info-bg))] text-[hsl(var(--info))]',
  in_progress: 'bg-[hsl(var(--info-bg))] text-[hsl(var(--info))]',
  sent: 'bg-[hsl(var(--info-bg))] text-[hsl(var(--info))]',
  draft: 'bg-bg-subtle text-[hsl(var(--text-secondary))]',
  overdue: 'bg-[hsl(var(--danger-bg))] text-[hsl(var(--danger-text))]',
  cancelled: 'bg-[hsl(var(--danger-bg))] text-[hsl(var(--danger-text))]',
  no_show: 'bg-[hsl(var(--danger-bg))] text-[hsl(var(--danger-text))]',
  rejected: 'bg-[hsl(var(--danger-bg))] text-[hsl(var(--danger-text))]',
  expired: 'bg-[hsl(var(--warning-bg))] text-[hsl(var(--warning))]',
  default: 'bg-primary-light text-primary-dark',
};

const statusLabels: Record<BadgeStatus, string> = {
  active: 'Ativo', paid: 'Pago', completed: 'Concluído', confirmed: 'Confirmado',
  approved: 'Aprovada', signed: 'Assinado', pending: 'Pendente', scheduled: 'Agendado',
  in_progress: 'Em andamento', sent: 'Enviada', draft: 'Rascunho', overdue: 'Vencido',
  cancelled: 'Cancelado', no_show: 'Não compareceu', rejected: 'Reprovada', expired: 'Expirada',
  default: '',
};

const BrandBadge = React.forwardRef<HTMLSpanElement, BrandBadgeProps>(
  ({ className, status = 'default', withDot = true, children, ...props }, ref) => {
    return (
      <span
        ref={ref}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-pill px-2.5 py-0.5 text-xs font-semibold leading-5',
          statusStyles[status] || statusStyles.default,
          className
        )}
        {...props}
      >
        {withDot && (
          <span
            aria-hidden="true"
            className="inline-block h-1.5 w-1.5 rounded-full bg-current"
          />
        )}
        {children || statusLabels[status] || status}
      </span>
    );
  }
);
BrandBadge.displayName = 'BrandBadge';

export { BrandBadge };
export type { BadgeStatus };
