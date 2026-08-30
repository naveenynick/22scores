import type { Db } from "@/core/ingest/persist";
import type {
  CompetitionKind,
  CompetitionStatus,
  EventStatus,
} from "@/core/models/canonical";
import {
  drizzleChessReader,
  type ChessReader,
  type GameRow,
  type GameSideRow,
  type SortOrder,
  type TournamentGmRow,
  type TournamentRow,
} from "@/core/queries/chess-reader";
import type { SourceRefRow } from "@/lib/db/schema";

/**
 * Read-only application data layer for chess.
 *
 * Answers the four product questions directly:
 *   1. ongoing tournaments relevant to a country,
 *   2. upcoming tournaments relevant to a country,
 *   3. recent games/results for that country's GMs,
 *   4. games in progress right now.
 *
 * Contract:
 *  - reads Supabase through the canonical schema only; no provider is ever
 *    called on this path, and nothing here knows a provider exists;
 *  - relevance means a CONFIRMED fact — FIDE title GM plus that country's
 *    federation, as already normalized into `participants` — never a guess;
 *  - nothing is invented: a missing date, result or federation stays null;
 *  - two database round trips per query (parents, then all children in one
 *    batch), six for the whole overview. There is no per-row query anywhere.
 *
 * Storage access is injected as a `ChessReader`, so these functions can be
 * tested without a database and a different store could back them later.
 */

// --- Public shapes (canonical application data) ------------------------------

/** Provenance for a canonical row, trimmed to what a client may need. */
export interface CanonicalSource {
  provider: string;
  providerRef: string;
  url: string | null;
  /** ISO timestamp of the last successful fetch that backed this row. */
  fetchedAt: string;
}

/** A GM from the requested country, entered in a tournament. */
export interface ChessTournamentGm {
  name: string;
  title: string | null;
  countryIso2: string | null;
  /** Entry state as reported: "entered" | "active" | "withdrawn" | null. */
  entryStatus: string | null;
  finalRank: number | null;
}

export interface ChessTournament {
  id: string;
  name: string;
  kind: CompetitionKind;
  status: CompetitionStatus;
  startDate: Date | null;
  endDate: Date | null;
  /** The country this row was selected for. */
  relevantCountryIso2: string;
  /** Confirmed GMs from that country. Empty means "not known yet", not "none". */
  gms: ChessTournamentGm[];
  sources: CanonicalSource[];
}

/** One side of a game. Never assumed to be one of exactly two. */
export interface ChessGameSide {
  name: string;
  title: string | null;
  countryIso2: string | null;
  /** "white" | "black" | null for a side with no meaningful role. */
  role: string | null;
  score: string | null;
  /** "win" | "loss" | "draw" | null while undecided. */
  result: string | null;
  position: number | null;
}

export interface ChessGame {
  id: string;
  status: EventStatus;
  startTime: Date | null;
  /** Game-level summary, e.g. "1-0". Null while undecided. */
  result: string | null;
  competitionName: string | null;
  relevantCountryIso2: string;
  sides: ChessGameSide[];
  sources: CanonicalSource[];
}

export interface ChessCountryOverview {
  countryIso2: string;
  ongoingTournaments: ChessTournament[];
  upcomingTournaments: ChessTournament[];
  recentGames: ChessGame[];
  liveGames: ChessGame[];
}

// --- Configuration ----------------------------------------------------------

/** India is the first country shipped; the layer itself is country-agnostic. */
export const INDIA_ISO2 = "IN";

const DEFAULT_LIMIT = 25;

const ONGOING_STATUSES: CompetitionStatus[] = ["ongoing"];
const UPCOMING_STATUSES: CompetitionStatus[] = ["upcoming"];
const LIVE_STATUSES: EventStatus[] = ["live"];
/**
 * "recent" is the canonical "finished lately"; "finished" is older. Both are
 * results, so the recent-results feed spans them and orders by time.
 */
const RECENT_STATUSES: EventStatus[] = ["recent", "finished"];

/** White first, black second, anything else after — never re-labelled. */
const ROLE_RANK: Record<string, number> = { white: 0, black: 1 };

// --- Pure helpers (exported for direct testing) ------------------------------

export function normalizeCountryIso2(raw: string): string {
  return raw.trim().toUpperCase();
}

export function toCanonicalSources(
  rows: SourceRefRow[] | null | undefined,
): CanonicalSource[] {
  return (rows ?? []).map((row) => ({
    provider: row.provider,
    providerRef: row.providerRef,
    url: row.url ?? null,
    fetchedAt: row.fetchedAt,
  }));
}

function groupBy<T>(rows: T[], keyOf: (row: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const bucket = grouped.get(key);
    if (bucket === undefined) grouped.set(key, [row]);
    else bucket.push(row);
  }
  return grouped;
}

function uniqueIds(rows: { id: string }[]): string[] {
  return [...new Set(rows.map((row) => row.id))];
}

/** Board order for display. Unknown roles keep their incoming order. */
export function orderSides(sides: ChessGameSide[]): ChessGameSide[] {
  return sides
    .map((side, index) => ({ side, index }))
    .sort((a, b) => {
      const rankA = ROLE_RANK[a.side.role ?? ""] ?? Number.MAX_SAFE_INTEGER;
      const rankB = ROLE_RANK[b.side.role ?? ""] ?? Number.MAX_SAFE_INTEGER;
      return rankA === rankB ? a.index - b.index : rankA - rankB;
    })
    .map(({ side }) => side);
}

export function assembleTournaments(
  rows: TournamentRow[],
  gmRows: TournamentGmRow[],
  countryIso2: string,
): ChessTournament[] {
  const byCompetition = groupBy(gmRows, (row) => row.competitionId);
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    kind: row.kind,
    status: row.status,
    startDate: row.startDate,
    endDate: row.endDate,
    relevantCountryIso2: countryIso2,
    gms: (byCompetition.get(row.id) ?? []).map((gm) => ({
      name: gm.name,
      title: gm.title,
      countryIso2: gm.countryIso2,
      entryStatus: gm.entryStatus,
      finalRank: gm.finalRank,
    })),
    sources: toCanonicalSources(row.sources),
  }));
}

export function assembleGames(
  rows: GameRow[],
  sideRows: GameSideRow[],
  countryIso2: string,
): ChessGame[] {
  const byEvent = groupBy(sideRows, (row) => row.eventId);
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    startTime: row.startTime,
    result: row.result,
    competitionName: row.competitionName,
    relevantCountryIso2: countryIso2,
    sides: orderSides(
      (byEvent.get(row.id) ?? []).map((side) => ({
        name: side.name,
        title: side.title,
        countryIso2: side.countryIso2,
        role: side.role,
        score: side.score,
        result: side.result,
        position: side.position,
      })),
    ),
    sources: toCanonicalSources(row.sources),
  }));
}

// --- Query functions --------------------------------------------------------

/** A live Drizzle handle, or any reader (tests, a future cache). */
export type ChessDataSource = Db | ChessReader;

function readerFor(source: ChessDataSource): ChessReader {
  return typeof (source as ChessReader).tournaments === "function"
    ? (source as ChessReader)
    : drizzleChessReader(source as Db);
}

export interface CountryLimitOptions {
  countryIso2: string;
  limit?: number;
}

export async function getRelevantChessTournaments(
  source: ChessDataSource,
  options: CountryLimitOptions & {
    statuses: CompetitionStatus[];
    order?: SortOrder;
  },
): Promise<ChessTournament[]> {
  const reader = readerFor(source);
  const countryIso2 = normalizeCountryIso2(options.countryIso2);
  const rows = await reader.tournaments({
    countryIso2,
    statuses: options.statuses,
    order: options.order ?? "desc",
    limit: options.limit ?? DEFAULT_LIMIT,
  });
  if (rows.length === 0) return [];
  const gmRows = await reader.tournamentGms({
    competitionIds: uniqueIds(rows),
    countryIso2,
  });
  return assembleTournaments(rows, gmRows, countryIso2);
}

export async function getRelevantChessGames(
  source: ChessDataSource,
  options: CountryLimitOptions & {
    statuses: EventStatus[];
    order?: SortOrder;
  },
): Promise<ChessGame[]> {
  const reader = readerFor(source);
  const countryIso2 = normalizeCountryIso2(options.countryIso2);
  const rows = await reader.games({
    countryIso2,
    statuses: options.statuses,
    order: options.order ?? "desc",
    limit: options.limit ?? DEFAULT_LIMIT,
  });
  if (rows.length === 0) return [];
  const sideRows = await reader.gameSides({ eventIds: uniqueIds(rows) });
  return assembleGames(rows, sideRows, countryIso2);
}

/** 1. Tournaments under way right now, most recently started first. */
export function getOngoingChessTournaments(
  source: ChessDataSource,
  options: CountryLimitOptions,
): Promise<ChessTournament[]> {
  return getRelevantChessTournaments(source, {
    ...options,
    statuses: ONGOING_STATUSES,
    order: "desc",
  });
}

/** 2. Tournaments still to come, soonest first. */
export function getUpcomingChessTournaments(
  source: ChessDataSource,
  options: CountryLimitOptions,
): Promise<ChessTournament[]> {
  return getRelevantChessTournaments(source, {
    ...options,
    statuses: UPCOMING_STATUSES,
    order: "asc",
  });
}

/** 3. Finished games and their results, newest first. */
export function getRecentChessGames(
  source: ChessDataSource,
  options: CountryLimitOptions,
): Promise<ChessGame[]> {
  return getRelevantChessGames(source, {
    ...options,
    statuses: RECENT_STATUSES,
    order: "desc",
  });
}

/** 4. Games in progress. Result stays null until the provider reports one. */
export function getLiveChessGames(
  source: ChessDataSource,
  options: CountryLimitOptions,
): Promise<ChessGame[]> {
  return getRelevantChessGames(source, {
    ...options,
    statuses: LIVE_STATUSES,
    order: "desc",
  });
}

/**
 * All four sections in six round trips: the four parent lists concurrently,
 * then entrants and sides each fetched once for the union of parent ids.
 * Calling the four functions above separately would cost eight.
 */
export async function getChessCountryOverview(
  source: ChessDataSource,
  options: CountryLimitOptions,
): Promise<ChessCountryOverview> {
  const reader = readerFor(source);
  const countryIso2 = normalizeCountryIso2(options.countryIso2);
  const limit = options.limit ?? DEFAULT_LIMIT;

  const [ongoingRows, upcomingRows, liveRows, recentRows] = await Promise.all([
    reader.tournaments({
      countryIso2,
      statuses: ONGOING_STATUSES,
      order: "desc",
      limit,
    }),
    reader.tournaments({
      countryIso2,
      statuses: UPCOMING_STATUSES,
      order: "asc",
      limit,
    }),
    reader.games({
      countryIso2,
      statuses: LIVE_STATUSES,
      order: "desc",
      limit,
    }),
    reader.games({
      countryIso2,
      statuses: RECENT_STATUSES,
      order: "desc",
      limit,
    }),
  ]);

  const competitionIds = uniqueIds([...ongoingRows, ...upcomingRows]);
  const eventIds = uniqueIds([...liveRows, ...recentRows]);

  const [gmRows, sideRows] = await Promise.all([
    competitionIds.length === 0
      ? Promise.resolve<TournamentGmRow[]>([])
      : reader.tournamentGms({ competitionIds, countryIso2 }),
    eventIds.length === 0
      ? Promise.resolve<GameSideRow[]>([])
      : reader.gameSides({ eventIds }),
  ]);

  return {
    countryIso2,
    ongoingTournaments: assembleTournaments(ongoingRows, gmRows, countryIso2),
    upcomingTournaments: assembleTournaments(upcomingRows, gmRows, countryIso2),
    recentGames: assembleGames(recentRows, sideRows, countryIso2),
    liveGames: assembleGames(liveRows, sideRows, countryIso2),
  };
}

/** India-first convenience wrapper — the only place "IN" is assumed. */
export function getIndiaChessOverview(
  source: ChessDataSource,
  options: { limit?: number } = {},
): Promise<ChessCountryOverview> {
  return getChessCountryOverview(source, {
    countryIso2: INDIA_ISO2,
    limit: options.limit,
  });
}
