import {
  and,
  eq,
  exists,
  inArray,
  sql,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { Db } from "@/core/ingest/persist";
import type {
  CompetitionKind,
  CompetitionStatus,
  EventStatus,
} from "@/core/models/canonical";
import { schema } from "@/lib/db";
import type { SourceRefRow } from "@/lib/db/schema";

/**
 * SQL for the chess read model — the only place in the query layer that knows
 * about tables, joins or Drizzle. Read-only: no INSERT/UPDATE/DELETE lives here.
 *
 * Two rules shape every statement:
 *  - the *_relevant_countries join tables are the entry index, because
 *    "what is my country involved in?" is the product's primary question;
 *  - a relevance row alone is not trusted to mean "a GM from that country".
 *    Each query additionally requires a CONFIRMED participant — FIDE title GM
 *    whose canonical country is the requested one — so a future provider that
 *    flags an entity for some other reason (a venue, a broadcast language)
 *    cannot leak into a GM feed.
 *
 * Children (entrants, sides) are always fetched for a LIST of parent ids, so
 * there is no N+1 path: each public query is two round trips, whatever the
 * number of rows.
 */

const CHESS = "chess" as const;
const GAME_KIND = "game" as const;

/** The FIDE title that defines chess relevance for this product. */
const GM_TITLE = "GM";

/** One statement can reference `countries` up to three times, so alias each. */
const relevanceCountry = alias(schema.countries, "relevance_country");
const participantCountry = alias(schema.countries, "participant_country");
const gmCountry = alias(schema.countries, "gm_country");

export type SortOrder = "asc" | "desc";

export interface TournamentQuery {
  countryIso2: string;
  statuses: CompetitionStatus[];
  order: SortOrder;
  limit: number;
}

export interface GameQuery {
  countryIso2: string;
  statuses: EventStatus[];
  order: SortOrder;
  limit: number;
}

export interface TournamentRow {
  id: string;
  name: string;
  kind: CompetitionKind;
  status: CompetitionStatus;
  startDate: Date | null;
  endDate: Date | null;
  sources: SourceRefRow[];
}

export interface TournamentGmRow {
  competitionId: string;
  name: string;
  title: string | null;
  countryIso2: string | null;
  entryStatus: string | null;
  finalRank: number | null;
}

export interface GameRow {
  id: string;
  status: EventStatus;
  startTime: Date | null;
  result: string | null;
  competitionName: string | null;
  sources: SourceRefRow[];
}

export interface GameSideRow {
  eventId: string;
  name: string;
  title: string | null;
  countryIso2: string | null;
  role: string | null;
  score: string | null;
  result: string | null;
  position: number | null;
}

/**
 * The complete set of reads the chess query layer performs. Production uses
 * `drizzleChessReader`; tests substitute an in-memory implementation, which is
 * what keeps storage detail out of the query functions themselves.
 */
export interface ChessReader {
  tournaments(query: TournamentQuery): Promise<TournamentRow[]>;
  tournamentGms(query: {
    competitionIds: string[];
    countryIso2: string;
  }): Promise<TournamentGmRow[]>;
  games(query: GameQuery): Promise<GameRow[]>;
  gameSides(query: { eventIds: string[] }): Promise<GameSideRow[]>;
}

// --- Shared predicates ------------------------------------------------------

/** Rows with no date sort last in both directions, never above real dates. */
function startOrder(column: SQLWrapper, order: SortOrder): SQL {
  return order === "asc"
    ? sql`${column} asc nulls last`
    : sql`${column} desc nulls last`;
}

/** Case-insensitive so a provider that writes "gm" still matches. */
function hasGmTitle(): SQL {
  return sql`upper(${schema.participants.title}) = ${GM_TITLE}`;
}

/** Correlated: the competition has an entrant who is a GM from `iso2`. */
function competitionHasCountryGm(db: Db, iso2: string): SQL {
  return exists(
    db
      .select({ participantId: schema.participants.id })
      .from(schema.competitionParticipants)
      .innerJoin(
        schema.participants,
        eq(schema.participants.id, schema.competitionParticipants.participantId),
      )
      .innerJoin(gmCountry, eq(gmCountry.id, schema.participants.countryId))
      .where(
        and(
          eq(
            schema.competitionParticipants.competitionId,
            schema.competitions.id,
          ),
          eq(schema.participants.sport, CHESS),
          hasGmTitle(),
          eq(gmCountry.iso2, iso2),
        ),
      ),
  );
}

/** Correlated: a GM from `iso2` actually played in the event. */
function eventHasCountryGm(db: Db, iso2: string): SQL {
  return exists(
    db
      .select({ participantId: schema.participants.id })
      .from(schema.eventParticipants)
      .innerJoin(
        schema.participants,
        eq(schema.participants.id, schema.eventParticipants.participantId),
      )
      .innerJoin(gmCountry, eq(gmCountry.id, schema.participants.countryId))
      .where(
        and(
          eq(schema.eventParticipants.eventId, schema.events.id),
          eq(schema.participants.sport, CHESS),
          hasGmTitle(),
          eq(gmCountry.iso2, iso2),
        ),
      ),
  );
}

// --- Query builders (exported so their SQL can be asserted without a DB) ----

export function tournamentsQuery(db: Db, query: TournamentQuery) {
  return db
    .select({
      id: schema.competitions.id,
      name: schema.competitions.name,
      kind: schema.competitions.kind,
      status: schema.competitions.status,
      startDate: schema.competitions.startDate,
      endDate: schema.competitions.endDate,
      sources: schema.competitions.sources,
    })
    .from(schema.competitions)
    .innerJoin(
      schema.competitionRelevantCountries,
      eq(
        schema.competitionRelevantCountries.competitionId,
        schema.competitions.id,
      ),
    )
    .innerJoin(
      relevanceCountry,
      eq(relevanceCountry.id, schema.competitionRelevantCountries.countryId),
    )
    .where(
      and(
        eq(schema.competitions.sport, CHESS),
        eq(relevanceCountry.iso2, query.countryIso2),
        inArray(schema.competitions.status, query.statuses),
        competitionHasCountryGm(db, query.countryIso2),
      ),
    )
    .orderBy(startOrder(schema.competitions.startDate, query.order))
    .limit(query.limit);
}

/** Entrants for MANY competitions at once — the anti-N+1 shape. */
export function tournamentGmsQuery(
  db: Db,
  query: { competitionIds: string[]; countryIso2: string },
) {
  return db
    .select({
      competitionId: schema.competitionParticipants.competitionId,
      name: schema.participants.name,
      title: schema.participants.title,
      countryIso2: participantCountry.iso2,
      entryStatus: schema.competitionParticipants.status,
      finalRank: schema.competitionParticipants.finalRank,
    })
    .from(schema.competitionParticipants)
    .innerJoin(
      schema.participants,
      eq(schema.participants.id, schema.competitionParticipants.participantId),
    )
    .innerJoin(
      participantCountry,
      eq(participantCountry.id, schema.participants.countryId),
    )
    .where(
      and(
        inArray(
          schema.competitionParticipants.competitionId,
          query.competitionIds,
        ),
        eq(schema.participants.sport, CHESS),
        hasGmTitle(),
        eq(participantCountry.iso2, query.countryIso2),
      ),
    )
    .orderBy(schema.participants.name);
}

export function gamesQuery(db: Db, query: GameQuery) {
  return db
    .select({
      id: schema.events.id,
      status: schema.events.status,
      startTime: schema.events.startTime,
      result: schema.events.result,
      competitionName: schema.competitions.name,
      sources: schema.events.sources,
    })
    .from(schema.events)
    .innerJoin(
      schema.eventRelevantCountries,
      eq(schema.eventRelevantCountries.eventId, schema.events.id),
    )
    .innerJoin(
      relevanceCountry,
      eq(relevanceCountry.id, schema.eventRelevantCountries.countryId),
    )
    // Left: a game may exist before its competition row is linked.
    .leftJoin(
      schema.competitions,
      eq(schema.competitions.id, schema.events.competitionId),
    )
    .where(
      and(
        eq(schema.events.sport, CHESS),
        eq(schema.events.kind, GAME_KIND),
        eq(relevanceCountry.iso2, query.countryIso2),
        inArray(schema.events.status, query.statuses),
        eventHasCountryGm(db, query.countryIso2),
      ),
    )
    .orderBy(startOrder(schema.events.startTime, query.order))
    .limit(query.limit);
}

/**
 * Sides for MANY events at once. Every side is returned, not just the relevant
 * country's: a game is only meaningful with its opponent, and a side whose
 * federation is unknown must still appear (hence the left join on country).
 */
export function gameSidesQuery(db: Db, query: { eventIds: string[] }) {
  return db
    .select({
      eventId: schema.eventParticipants.eventId,
      name: schema.participants.name,
      title: schema.participants.title,
      countryIso2: participantCountry.iso2,
      role: schema.eventParticipants.role,
      score: schema.eventParticipants.score,
      result: schema.eventParticipants.result,
      position: schema.eventParticipants.position,
    })
    .from(schema.eventParticipants)
    .innerJoin(
      schema.participants,
      eq(schema.participants.id, schema.eventParticipants.participantId),
    )
    .leftJoin(
      participantCountry,
      eq(participantCountry.id, schema.participants.countryId),
    )
    .where(inArray(schema.eventParticipants.eventId, query.eventIds))
    // Deterministic; white/black ordering is applied by the pure layer.
    .orderBy(
      schema.eventParticipants.eventId,
      sql`${schema.eventParticipants.position} asc nulls last`,
      schema.participants.name,
    );
}

// --- Reader -----------------------------------------------------------------

/**
 * Production reader. Every method short-circuits on an empty input set so no
 * pointless statement is ever sent, and `inArray` is never handed [].
 */
export function drizzleChessReader(db: Db): ChessReader {
  return {
    async tournaments(query) {
      if (query.statuses.length === 0 || query.limit <= 0) return [];
      return tournamentsQuery(db, query);
    },
    async tournamentGms(query) {
      if (query.competitionIds.length === 0) return [];
      return tournamentGmsQuery(db, query);
    },
    async games(query) {
      if (query.statuses.length === 0 || query.limit <= 0) return [];
      return gamesQuery(db, query);
    },
    async gameSides(query) {
      if (query.eventIds.length === 0) return [];
      return gameSidesQuery(db, query);
    },
  };
}
