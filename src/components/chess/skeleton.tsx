import { CHESS_SHELL } from "@/components/chess/layout";
import { cn } from "@/lib/utils";

/**
 * Loading placeholder. Shaped like the real page — masthead, jump links, a live
 * row and the two content columns — so nothing jumps when the data arrives, and
 * announced once as a status rather than as a wall of empty text.
 */
export function ChessPageSkeleton() {
  return (
    <div role="status" aria-live="polite">
      <span className="sr-only">Loading India chess data</span>

      <div aria-hidden="true">
        <div className="border-b bg-card">
          <div className={cn(CHESS_SHELL, "py-7 sm:py-10")}>
            <Bar className="h-5 w-32" />
            <Bar className="mt-4 h-8 w-full max-w-xl sm:h-10" />
            <Bar className="mt-3 h-4 w-full max-w-md" />
            <Bar className="mt-5 h-7 w-52 rounded-full" />
          </div>
        </div>

        <div className="border-b">
          <div className={cn(CHESS_SHELL, "flex gap-2 py-3")}>
            {/* Literal classes: Tailwind only sees what is written out in full. */}
            {["w-20", "w-24", "w-24", "w-20"].map((width, index) => (
              <Bar key={index} className={cn("h-7 rounded-full", width)} />
            ))}
          </div>
        </div>

        <div className={cn(CHESS_SHELL, "py-6 sm:py-8")}>
          <SectionSkeleton headingWidth="w-28">
            <div className="grid gap-3 md:grid-cols-2">
              <GameSkeleton />
              <GameSkeleton />
            </div>
          </SectionSkeleton>

          <div className="mt-8 grid gap-8 lg:mt-10 lg:grid-cols-3">
            <div className="space-y-8 lg:col-span-2">
              <SectionSkeleton headingWidth="w-44">
                <TournamentSkeleton />
              </SectionSkeleton>
              <SectionSkeleton headingWidth="w-48">
                <TournamentSkeleton />
              </SectionSkeleton>
            </div>
            <div>
              <SectionSkeleton headingWidth="w-32">
                <GameSkeleton />
              </SectionSkeleton>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Heading rule, heading bar and count pill, matching `Section`. */
function SectionSkeleton({
  headingWidth,
  children,
}: {
  headingWidth: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-3 flex items-center gap-2.5">
        <Bar className="h-4 w-1 rounded-full" />
        <Bar className={cn("h-4", headingWidth)} />
        <Bar className="h-5 w-8 rounded-full" />
      </div>
      {children}
    </div>
  );
}

/** Two player rows between a header and a footer strip. */
function GameSkeleton() {
  return (
    <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
      <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-2 sm:px-4">
        <Bar className="h-5 w-14 rounded-full" />
        <Bar className="h-3 w-2/5" />
      </div>
      <div className="divide-y">
        {["w-2/3", "w-1/2"].map((width) => (
          <div key={width} className="flex items-center gap-2.5 px-3 py-2.5 sm:px-4">
            <Bar className="size-6 shrink-0 rounded-md" />
            <Bar className={cn("h-4", width)} />
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between border-t bg-muted/20 px-3 py-2 sm:px-4">
        <Bar className="h-3 w-16" />
        <Bar className="h-3 w-24" />
      </div>
    </div>
  );
}

/** Title, dates, round markers, then the entrant strip. */
function TournamentSkeleton() {
  return (
    <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
      <div className="p-4 sm:p-5">
        <div className="flex items-start justify-between gap-3">
          <Bar className="h-5 w-3/5" />
          <Bar className="h-5 w-20 rounded-full" />
        </div>
        <Bar className="mt-3 h-3 w-2/5" />
        <Bar className="mt-4 h-1.5 w-full rounded-full" />
        <Bar className="mt-2 h-3 w-1/2" />
      </div>
      <div className="border-t bg-muted/30 px-4 py-3 sm:px-5">
        <Bar className="h-3 w-32" />
        <div className="mt-2 flex gap-1.5">
          <Bar className="h-7 w-36 rounded-full" />
          <Bar className="h-7 w-40 rounded-full" />
        </div>
      </div>
    </div>
  );
}

function Bar({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded bg-muted", className)} />;
}
