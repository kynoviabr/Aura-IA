import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * Stripe-inspired badge / chip.
 * - pill shape, soft bg + dark text, no colored borders
 * - 12px / weight 600
 */
const badgeVariants = cva(
  "inline-flex items-center rounded-pill px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:shadow-focus-ring",
  {
    variants: {
      variant: {
        default: "bg-primary-light text-primary-dark",
        secondary: "bg-bg-subtle text-foreground",
        destructive: "bg-[hsl(var(--danger-bg))] text-[hsl(var(--danger-text))]",
        outline: "border border-border text-foreground bg-transparent",
        success: "bg-[hsl(var(--success-bg))] text-[hsl(var(--success))]",
        warning: "bg-[hsl(var(--warning-bg))] text-[hsl(var(--warning))]",
        info: "bg-[hsl(var(--info-bg))] text-[hsl(var(--info))]",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
