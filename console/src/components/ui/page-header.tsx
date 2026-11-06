import { ReactNode } from 'react';

interface PageHeaderProps {
  title: string;
  description?: string;
  children?: ReactNode;
}

/**
 * Stripe-style page header.
 * Heading family + negative letter-spacing baked in via global h1 styles.
 */
export function PageHeader({ title, description, children }: PageHeaderProps) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4 mb-8">
      <div className="min-w-0 flex-1 basis-72">
        <h1 className="font-heading text-3xl sm:text-[2rem] font-bold text-foreground">{title}</h1>
        {description && (
          <p className="text-[15px] text-[hsl(var(--text-secondary))] mt-1.5 leading-relaxed max-w-2xl">
            {description}
          </p>
        )}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}
