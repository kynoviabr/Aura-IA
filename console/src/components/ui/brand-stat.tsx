import { cn } from '@/lib/utils';
import { LucideIcon } from 'lucide-react';

interface BrandStatProps {
  label: string;
  value: string | number;
  icon?: LucideIcon;
  trend?: { value: number; label: string };
  className?: string;
}

/**
 * Stripe-style metric card. Uppercase 11px label, 28-32px value.
 */
export function BrandStat({ label, value, icon: Icon, trend, className }: BrandStatProps) {
  return (
    <div
      title={label}
      className={cn(
        'rounded-card border border-border bg-card p-5 shadow-stripe-sm transition-all duration-200 ease-stripe',
        'hover:-translate-y-0.5 hover:shadow-stripe-md',
        'animate-fade-in',
        className
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1.5 min-w-0">
          <p className="label-stripe truncate">{label}</p>
          <p className="font-heading text-3xl font-bold tracking-tight text-foreground">{value}</p>
        </div>
        {Icon && (
          <div className="w-9 h-9 shrink-0 rounded-btn bg-primary-light flex items-center justify-center">
            <Icon className="w-4.5 h-4.5 text-primary-dark" />
          </div>
        )}
      </div>
      {trend && (
        <div className="mt-3 flex items-center gap-1.5 text-xs">
          <span
            className={cn(
              'font-semibold inline-flex items-center px-1.5 py-0.5 rounded-chip',
              trend.value >= 0
                ? 'bg-[hsl(var(--success-bg))] text-[hsl(var(--success))]'
                : 'bg-[hsl(var(--danger-bg))] text-[hsl(var(--danger-text))]'
            )}
          >
            {trend.value >= 0 ? '↑' : '↓'} {Math.abs(trend.value)}%
          </span>
          <span className="text-muted-foreground">{trend.label}</span>
        </div>
      )}
    </div>
  );
}
