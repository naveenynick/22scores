import type { EventStatus } from "@/core/models/canonical";

/**
 * Whether a stored "live" claim may still be presented as live.
 *
 * `events.status` is a snapshot written at ingest time: the provider said the
 * game was in progress when it was last read. Nothing rewrites that column
 * afterwards, so a sync that stops running — or a round the sync no longer
 * revisits — leaves rows claiming to be live indefinitely. Reading the column on
 * its own is therefore not enough to tell a reader "LIVE".
 *
 * The rule here closes that gap at read time using provenance that is already
 * stored: a live claim is believed only while the fetch behind it is recent.
 * Past that, the row is reported as *unconfirmed* — last seen in progress. It is
 * never relabelled finished and never given a result, because neither is known;
 * only the confidence in "live" changes.
 *
 * Sport- and storage-agnostic on purpose: it needs a status plus the
 * `sources[].fetchedAt` timestamps every canonical row already carries, so
 * cricket inherits it unchanged.
 *
 * This module is the ONLY place the decision is made. Callers must not compare
 * fetch timestamps themselves.
 */

/**
 * How long a live claim is believed after the fetch that produced it.
 *
 * 25 minutes, chosen for broadcast chess:
 *  - one move at a classical time control can take well over 20 minutes, so a
 *    shorter window would flag genuinely live games as unconfirmed whenever a
 *    sync is a little late;
 *  - a game that has ended is reflected by the next sync, so a window this size
 *    bounds how long a finished game can keep claiming to be live;
 *  - it sits far inside the 14-day "recent" horizon ingestion uses, so a stale
 *    row is caught in minutes rather than days.
 *
 * Change it here and every read path follows.
 */
export const LIVE_FRESHNESS_WINDOW_MS = 25 * 60 * 1000;

/** The one canonical status that asserts something about *now*. */
const LIVE_STATUS: EventStatus = "live";

/** The provenance field the rule needs. `CanonicalSource` satisfies this. */
export interface DatedSource {
  /** ISO timestamp of the fetch that backed the row. */
  fetchedAt: string;
}

/** A stored row that may claim to be live. */
export interface LiveClaimant {
  status: EventStatus;
  sources: readonly DatedSource[];
}

export type LiveConfidence = "confirmed" | "unconfirmed";

export interface LiveClaim {
  /**
   * "confirmed": seen in progress within the window — safe to show as LIVE.
   * "unconfirmed": last seen in progress, too long ago to assert. Also the
   * verdict when a row carries no usable timestamp: an unverifiable live claim
   * is not a confirmed one.
   */
  confidence: LiveConfidence;
  /** Newest fetch behind the claim, or null when none is recorded. */
  lastSeenAt: Date | null;
  /** How long ago that was, never negative. Null when unknown. */
  ageMs: number | null;
  /** The window applied, so a caller can explain the verdict. */
  windowMs: number;
}

/**
 * Newest usable `fetchedAt` in a provenance array. Newest wins: a row merged
 * from several providers is as fresh as its freshest source. Values that do not
 * parse are ignored rather than counted as either fresh or stale.
 */
export function newestFetchedAt(sources: readonly DatedSource[]): Date | null {
  let newestMs = Number.NEGATIVE_INFINITY;
  for (const source of sources) {
    const ms = Date.parse(source.fetchedAt);
    if (Number.isNaN(ms) || ms <= newestMs) continue;
    newestMs = ms;
  }
  return newestMs === Number.NEGATIVE_INFINITY ? null : new Date(newestMs);
}

/**
 * Confidence in a live claim, from provenance age alone.
 *
 * A timestamp in the future is treated as fresh, not stale: that is clock skew
 * between this process and ingestion, not evidence the row is old.
 */
export function classifyLiveClaim(
  sources: readonly DatedSource[],
  now: Date,
  windowMs: number = LIVE_FRESHNESS_WINDOW_MS,
): LiveClaim {
  const lastSeenAt = newestFetchedAt(sources);
  if (lastSeenAt === null) {
    return {
      confidence: "unconfirmed",
      lastSeenAt: null,
      ageMs: null,
      windowMs,
    };
  }
  const ageMs = Math.max(0, now.getTime() - lastSeenAt.getTime());
  return {
    // Exactly at the boundary still counts as fresh.
    confidence: ageMs <= windowMs ? "confirmed" : "unconfirmed",
    lastSeenAt,
    ageMs,
    windowMs,
  };
}

/**
 * The live claim to attach to a stored row, or null when the row makes no live
 * claim at all. Every read path goes through this, so "is this LIVE?" has
 * exactly one answer.
 */
export function liveClaimFor(
  row: LiveClaimant,
  now: Date,
  windowMs: number = LIVE_FRESHNESS_WINDOW_MS,
): LiveClaim | null {
  if (row.status !== LIVE_STATUS) return null;
  return classifyLiveClaim(row.sources, now, windowMs);
}

/** True only for a row that may be shown to a reader as live right now. */
export function isConfirmedLive(
  row: LiveClaimant,
  now: Date,
  windowMs: number = LIVE_FRESHNESS_WINDOW_MS,
): boolean {
  return liveClaimFor(row, now, windowMs)?.confidence === "confirmed";
}
