import { cn } from "@/lib/utils";
import {
  formatDayTime,
  formatRelativeTime,
  formatTime,
  toIsoAttribute,
} from "@/lib/format";

/**
 * When what you are looking at was last confirmed.
 *
 * Two distinct facts, because they answer different questions: `fetchedAt` is
 * the newest provenance timestamp on the data itself (how stale the scores are),
 * `generatedAt` is when this page was rendered. Neither is guessed — an absent
 * or unparseable provenance timestamp is stated as not recorded.
 */
export function DataFreshness({
  fetchedAt,
  generatedAt,
  className,
}: {
  fetchedAt: string | null;
  generatedAt: Date;
  className?: string;
}) {
  const updated = parseTimestamp(fetchedAt);

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground",
        className,
      )}
    >
      <p className="inline-flex items-center gap-1.5 rounded-full border bg-background px-2.5 py-1">
        <span
          aria-hidden="true"
          className="size-1.5 shrink-0 rounded-full bg-foreground/40"
        />
        {updated === null ? (
          "Last data update not recorded"
        ) : (
          <>
            <span>Updated</span>
            <time
              dateTime={toIsoAttribute(updated)}
              className="font-semibold text-foreground"
            >
              {formatRelativeTime(updated, generatedAt)}
            </time>
            {/* The exact time is a detail; on a phone the relative one is enough. */}
            <span className="hidden whitespace-nowrap sm:inline">
              · {formatDayTime(updated)}
            </span>
          </>
        )}
      </p>
      <p>
        <span className="sr-only">Page rendered </span>
        <span aria-hidden="true">Loaded </span>
        <time dateTime={toIsoAttribute(generatedAt)}>
          {formatTime(generatedAt)}
        </time>
      </p>
    </div>
  );
}

/** Null for both a missing value and one that cannot be read as a date. */
function parseTimestamp(value: string | null): Date | null {
  if (value === null) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms);
}
