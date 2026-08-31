import { cn } from "@/lib/utils";

/**
 * One page section: a heading a screen reader can navigate to, a count, and an
 * honest empty message. `emptyMessage` says why a section is empty in terms of
 * the data, never "no results found".
 *
 * `tone="live"` only changes the accent on the heading rule — the words carry the
 * meaning, so nothing depends on the colour.
 */
export function Section({
  id,
  title,
  count,
  emptyTitle = "Nothing on record",
  emptyMessage,
  meta,
  tone = "default",
  className,
  children,
}: {
  id: string;
  title: string;
  count: number;
  /** Short headline for the empty block, above `emptyMessage`. */
  emptyTitle?: string;
  emptyMessage: string;
  /** Optional right-aligned note, e.g. a unit or a scope reminder. */
  meta?: string;
  tone?: "default" | "live";
  className?: string;
  children: React.ReactNode;
}) {
  const headingId = `${id}-heading`;
  return (
    <section
      id={id}
      aria-labelledby={headingId}
      className={cn("scroll-mt-20", className)}
    >
      <div className="mb-3 flex items-center gap-2.5">
        <span
          aria-hidden="true"
          className={cn(
            "h-4 w-1 shrink-0 rounded-full",
            tone === "live" ? "bg-rose-600" : "bg-foreground/70",
          )}
        />
        <h2
          id={headingId}
          className="text-[0.8125rem] font-bold uppercase tracking-[0.08em]"
        >
          {title}
        </h2>
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-semibold tabular-nums text-muted-foreground">
          {count}
        </span>
        {meta !== undefined && (
          <p className="ml-auto hidden text-xs text-muted-foreground sm:block">
            {meta}
          </p>
        )}
      </div>
      {count === 0 ? (
        <EmptyState title={emptyTitle} message={emptyMessage} />
      ) : (
        children
      )}
    </section>
  );
}

/** Deliberate, quiet, and specific about what is missing. */
function EmptyState({ title, message }: { title: string; message: string }) {
  return (
    <div className="rounded-xl border border-dashed bg-muted/30 px-6 py-8 text-center">
      <span
        aria-hidden="true"
        className="mx-auto grid size-9 place-items-center rounded-full border bg-background text-base text-muted-foreground"
      >
        &#9822;
      </span>
      <p className="mt-3 text-sm font-semibold">{title}</p>
      <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
        {message}
      </p>
    </div>
  );
}
