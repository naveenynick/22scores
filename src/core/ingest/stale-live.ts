import { and, eq } from "drizzle-orm";

import type { EventStatus, SportKey } from "@/core/models/canonical";
import type { Db } from "@/core/ingest/persist";
import { liveClaimFor } from "@/core/queries/freshness";
import { schema } from "@/lib/db";
import type { SourceRefRow } from "@/lib/db/schema";

/**
 * Which stored rows a sync should re-read because they still claim to be live.
 *
 * `events.status` is a snapshot: a game read while in progress stays "live" until
 * a later sync overwrites it. Discovery cannot be relied on to come back — a
 * broadcast drops down the ranking the moment its round finishes, so the rows
 * that most need re-reading are exactly the ones discovery is least likely to
 * select. What is always available is the provider's own id for the row, already
 * stored in `sources[].providerRef`.
 *
 * This module turns those rows into refs a provider can re-fetch by id. It makes
 * no freshness decision of its own: `liveClaimFor` is the single place that rule
 * lives, and an unconfirmed claim here is the same unconfirmed claim the read
 * path shows as "last seen in progress".
 *
 * Read-only, and sport-agnostic: cricket can use it unchanged once its ingestion
 * stores live snapshots.
 */

/**
 * How many stored live rows one sync inspects. A ceiling, not a target: live
 * rows are few (a handful of boards per broadcast round), and the refs this
 * produces are trimmed again by whatever request budget the provider allows.
 */
export const DEFAULT_STALE_LIVE_SCAN_LIMIT = 200;

/** The stored fields the rule needs. A row from `events` satisfies this. */
export interface StaleLiveRow {
  status: EventStatus;
  sources: SourceRefRow[] | null;
}

/** Provider id -> that provider's own refs, deduplicated, order preserved. */
export type RefreshRefs = Record<string, string[]>;

/**
 * Stored rows that currently claim to be live, for one sport. Exported as a
 * builder so its shape can be asserted with `.toSQL()` without a database.
 */
export function staleLiveEventsQuery(
  db: Db,
  options: { sport: SportKey; limit?: number },
) {
  return db
    .select({
      status: schema.events.status,
      sources: schema.events.sources,
    })
    .from(schema.events)
    .where(
      and(
        eq(schema.events.sport, options.sport),
        eq(schema.events.status, "live"),
      ),
    )
    .limit(options.limit ?? DEFAULT_STALE_LIVE_SCAN_LIMIT);
}

/**
 * Refs to re-read, grouped by the provider that issued them.
 *
 * Only rows whose live claim can no longer be confirmed are included: a row read
 * minutes ago needs no request, and one that is not live at all is not this
 * module's business. Grouping by provider is what stops one provider being handed
 * another's ids.
 */
export function groupStaleLiveRefs(
  rows: readonly StaleLiveRow[],
  now: Date,
  windowMs?: number,
): RefreshRefs {
  const byProvider = new Map<string, Set<string>>();
  for (const row of rows) {
    const sources = row.sources ?? [];
    const claim = liveClaimFor({ status: row.status, sources }, now, windowMs);
    // Not a live claim, or one still inside the window: nothing to recover.
    if (claim === null || claim.confidence === "confirmed") continue;
    for (const source of sources) {
      const provider = source.provider.trim().toLowerCase();
      const ref = source.providerRef.trim();
      if (provider === "" || ref === "") continue;
      const refs = byProvider.get(provider) ?? new Set<string>();
      refs.add(ref);
      byProvider.set(provider, refs);
    }
  }
  const grouped: RefreshRefs = {};
  for (const [provider, refs] of byProvider) grouped[provider] = [...refs];
  return grouped;
}

/** Total refs across providers, for reporting what a sync tried to heal. */
export function countRefreshRefs(
  refs: Readonly<Record<string, readonly string[]>>,
): number {
  return Object.values(refs).reduce((total, list) => total + list.length, 0);
}

/** Read the stale live rows and group their refs. Never writes. */
export async function staleLiveRefreshRefs(
  db: Db,
  options: { sport: SportKey; now?: Date; limit?: number; windowMs?: number },
): Promise<RefreshRefs> {
  const rows = await staleLiveEventsQuery(db, {
    sport: options.sport,
    limit: options.limit,
  });
  return groupStaleLiveRefs(rows, options.now ?? new Date(), options.windowMs);
}
