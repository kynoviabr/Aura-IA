import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Stripe-inspired input.
 * - height 42px, 1.5px border, 14px padding
 * - focus: purple border + 3px purple ring (no native outline)
 * - aria-invalid → red border + red ring
 */
const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "flex h-[42px] w-full rounded-btn border-[1.5px] border-input bg-card px-3.5 py-2.5 text-sm",
          "text-foreground placeholder:text-[hsl(var(--text-muted))]",
          "transition-all duration-200 ease-stripe",
          "file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground",
          "hover:border-border-hover",
          "focus-visible:outline-none focus-visible:border-primary focus-visible:shadow-focus-ring",
          "aria-[invalid=true]:border-destructive aria-[invalid=true]:shadow-[0_0_0_3px_hsl(var(--destructive)/0.12)]",
          "disabled:cursor-not-allowed disabled:opacity-50 disabled:bg-bg-subtle",
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";

export { Input };
