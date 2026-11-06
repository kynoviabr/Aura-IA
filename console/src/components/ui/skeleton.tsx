import { cn } from "@/lib/utils";

/**
 * Stripe-style skeleton with shimmer.
 */
function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-md skeleton-shimmer", className)} {...props} />;
}

export { Skeleton };
