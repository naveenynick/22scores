import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * Small status pill. Tones are chosen so meaning survives without colour:
 * every badge also carries a word, and the live tone adds a dot.
 *
 * Only "live" is filled, so a scanning eye lands on what is happening now; every
 * other state is a quiet outline.
 */
const badgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded-full font-bold uppercase leading-none tracking-[0.06em] whitespace-nowrap",
  {
    variants: {
      tone: {
        live: "bg-rose-700 text-white",
        ongoing: "bg-emerald-50 text-emerald-800 ring-1 ring-emerald-700/25",
        upcoming: "bg-sky-50 text-sky-900 ring-1 ring-sky-700/25",
        final: "bg-slate-100 text-slate-700 ring-1 ring-slate-900/10",
        neutral: "bg-secondary text-secondary-foreground ring-1 ring-border",
        /** Highest-contrast marker, used where colour would compete with status. */
        solid: "bg-foreground text-background",
      },
      size: {
        sm: "px-1.5 py-1 text-[0.625rem]",
        default: "px-2.5 py-1 text-[0.6875rem]",
      },
    },
    defaultVariants: { tone: "neutral", size: "default" },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, tone, size, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ tone, size }), className)} {...props} />
  );
}

export { badgeVariants };
