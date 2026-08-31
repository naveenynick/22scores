import {
  getCompetitions,
  getEvents,
  getParticipants,
} from "@/core/providers/aggregator";
import {
  persistCanonical,
  type Db,
  type PersistSummary,
} from "@/core/ingest/persist";
import {
  countRefreshRefs,
  staleLiveRefreshRefs,
} from "@/core/ingest/stale-live";
import type { ProviderQuery } from "@/core/providers/types";

/**
 * Chess ingestion cycle.
 *
 * Reads through the AGGREGATOR, never a concrete provider, so adding Chess.com
 * later changes nothing here. No country filter is applied: every discovered
 * tournament is ingested and India relevance is attached where it is already
 * provable, leaving relevance to be backfilled once games appear.
 *
 * Before reading, stored rows that still claim to be live but can no longer be
 * confirmed are turned into refs for their own provider to re-fetch by id. That
 * is the only extra step: whatever comes back is mapped and written by exactly
 * the code every other record goes through, so a game that finished after the
 * last sync heals in place instead of waiting for discovery to rank its
 * tournament highly enough to be selected again.
 *
 * If the provider throws, the aggregator yields no records for that cycle and
 * we write nothing — existing rows stay exactly as they were.
 */

export interface ChessSyncResult {
  fetched: {
    competitions: number;
    events: number;
    participants: number;
    indiaRelevantCompetitions: number;
    indiaRelevantEvents: number;
    /** Stored refs handed back to their provider to re-read. */
    staleLiveRefs: number;
  };
  persisted: PersistSummary;
}

export async function syncChess(
  db: Db,
  query: ProviderQuery = {},
): Promise<ChessSyncResult> {
  // A caller may supply the set itself (tests, targeted repair); otherwise it
  // comes from provenance already stored. Read-only either way.
  const refreshRefs =
    query.refreshRefs ?? (await staleLiveRefreshRefs(db, { sport: "chess" }));
  const scoped: ProviderQuery = { ...query, refreshRefs };

  // Sequential on purpose: the provider memoizes one snapshot, so these three
  // reads share a single set of HTTP requests.
  const competitions = await getCompetitions("chess", scoped);
  const events = await getEvents("chess", scoped);
  const participants = await getParticipants("chess", scoped);

  const persisted = await persistCanonical(db, {
    participants,
    competitions,
    events,
  });

  return {
    fetched: {
      competitions: competitions.length,
      events: events.length,
      participants: participants.length,
      indiaRelevantCompetitions: competitions.filter((c) =>
        c.relevantCountryIso2.includes("IN"),
      ).length,
      indiaRelevantEvents: events.filter((e) =>
        e.relevantCountryIso2.includes("IN"),
      ).length,
      staleLiveRefs: countRefreshRefs(refreshRefs),
    },
    persisted,
  };
}
