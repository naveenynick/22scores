"use client";

import { useEffect } from "react";

import { CHESS_SHELL } from "@/components/chess/layout";
import { RetryButton } from "@/components/chess/retry-button";
import { cn } from "@/lib/utils";

/**
 * Last-resort boundary for /india/chess. The page already handles a failed data
 * read itself, so this catches only unexpected render failures.
 *
 * The error text is never shown: a server error message can carry internals. The
 * digest is enough to correlate with the server log.
 */
export default function IndiaChessError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(
      "[/india/chess] render failed:",
      error.name,
      error.digest ?? "no-digest",
    );
  }, [error]);

  return (
    <main className="min-h-screen">
      <div className={cn(CHESS_SHELL, "py-12 sm:py-16")}>
        <div
          role="alert"
          className="rounded-xl border border-dashed bg-muted/30 px-6 py-10 text-center"
        >
          <span
            aria-hidden="true"
            className="mx-auto grid size-10 place-items-center rounded-full border bg-background text-lg text-muted-foreground"
          >
            &#9888;
          </span>
          <h1 className="mt-3 text-lg font-semibold">
            This page could not be displayed
          </h1>
          <p className="mx-auto mt-1 max-w-prose text-sm text-muted-foreground">
            Something went wrong while building the India chess board. Your data
            is unaffected — try again in a moment.
          </p>
          <div className="mt-5 flex justify-center">
            <RetryButton onRetry={reset} />
          </div>
        </div>
      </div>
    </main>
  );
}
