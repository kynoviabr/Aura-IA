import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * Stripe-inspired button system.
 * - height 40px (default), 6px radius, font-weight 600
 * - hover: translateY(-1px) only — never scale()
 * - focus: 3px purple ring
 */
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-btn text-sm font-semibold transition-all duration-200 ease-stripe focus-visible:outline-none focus-visible:shadow-focus-ring disabled:cursor-not-allowed disabled:opacity-[0.42] [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 active:translate-y-0",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground shadow-stripe-sm hover:bg-primary-dark hover:-translate-y-px hover:shadow-stripe-md",
        destructive:
          "bg-card text-destructive border border-[hsl(var(--destructive)/0.35)] hover:bg-[hsl(var(--destructive)/0.06)] hover:-translate-y-px hover:shadow-stripe-md",
        outline:
          "border border-border bg-card text-foreground hover:border-border-hover hover:-translate-y-px hover:shadow-stripe-md",
        secondary:
          "bg-secondary text-secondary-foreground border border-transparent hover:bg-bg-subtle hover:-translate-y-px",
        ghost:
          "bg-transparent text-primary hover:bg-primary-light",
        link:
          "text-primary underline-offset-4 hover:underline p-0 h-auto",
      },
      size: {
        default: "h-10 px-5 py-2.5",
        sm: "h-9 rounded-btn px-3.5 text-xs",
        lg: "h-12 rounded-btn px-7 text-base",
        icon: "h-10 w-10 p-0",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
