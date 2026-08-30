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
import type { ProviderQuery } from "@/core/providers/types";

/**
 * Chess ingestion cycle.
 *
 * Reads through the AGGREGATOR, never a concrete provider, so adding Chess.com
 * later changes nothing here. No country filter is applied: every discovered
 * tournament is ingested and India relevance is attached where it is already
 * provable, leaving relevance to be backfilled once games appear.
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
  };
  persisted: PersistSummary;
}

export async function syncChess(
  db: Db,
  query: ProviderQuery = {},
): Promise<ChessSyncResult> {
  // Sequential on purpose: the provider memoizes one snapshot, so these three
  // reads share a single set of HTTP requests.
  const competitions = await getCompetitions("chess", query);
  const events = await getEvents("chess", query);
  const participants = await getParticipants("chess", query);

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
    },
    persisted,
  };
}
