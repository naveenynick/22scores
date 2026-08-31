"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { Button } from "@/components/ui/button";

/**
 * Re-runs the server render of the current route. The only interactive piece on
 * the page, so it is the only client component: everything else stays server
 * rendered and indexable.
 *
 * `onRetry` is for the error boundary, which must also clear its own state.
 */
export function RetryButton({
  onRetry,
  label = "Try again",
}: {
  onRetry?: () => void;
  label?: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={isPending}
      aria-busy={isPending}
      onClick={() => {
        startTransition(() => {
          router.refresh();
          onRetry?.();
        });
      }}
    >
      {isPending ? "Retrying…" : label}
    </Button>
  );
}
