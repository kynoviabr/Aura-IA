import * as React from 'react';
import { cn } from '@/lib/utils';

interface BrandButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'outline' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
}

/**
 * Stripe-style brand button. Mirrors the Button primitive but kept as a
 * dedicated component for places that already import BrandButton.
 * Hover lift via translateY only — never scale.
 */
const BrandButton = React.forwardRef<HTMLButtonElement, BrandButtonProps>(
  ({ className, variant = 'primary', size = 'md', children, ...props }, ref) => {
    return (
      <button
        ref={ref}
        className={cn(
          'inline-flex items-center justify-center gap-2 rounded-btn font-semibold transition-all duration-200 ease-stripe',
          'focus-visible:outline-none focus-visible:shadow-focus-ring',
          'disabled:cursor-not-allowed disabled:opacity-[0.42]',
          {
            'bg-primary text-primary-foreground shadow-stripe-sm hover:bg-primary-dark hover:-translate-y-px hover:shadow-stripe-md':
              variant === 'primary',
            'border border-border bg-card text-foreground hover:border-border-hover hover:-translate-y-px hover:shadow-stripe-md':
              variant === 'outline',
            'bg-transparent text-primary hover:bg-primary-light': variant === 'ghost',
          },
          {
            'h-9 px-3.5 text-xs': size === 'sm',
            'h-10 px-5 text-sm': size === 'md',
            'h-12 px-7 text-base': size === 'lg',
          },
          className
        )}
        {...props}
      >
        {children}
      </button>
    );
  }
);
BrandButton.displayName = 'BrandButton';

export { BrandButton };
