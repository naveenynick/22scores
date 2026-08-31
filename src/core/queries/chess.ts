import type { Db } from "@/core/ingest/persist";
import type {
  CompetitionKind,
  CompetitionStatus,
  EventStatus,
} from "@/core/models/canonical";
import {
  drizzleChessReader,
  type ChessReader,
  type CompetitionRoundRow,
  type GameRow,
  type GameSideRow,
  type SortOrder,
  type TournamentGmRow,
  type TournamentRow,
} from "@/core/queries/chess-reader";
import {
  isConfirmedLive,
  liveClaimFor,
  type LiveClaim,
} from "@/core/queries/freshness";
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
 *  - a stored `status = "live"` is a snapshot, not a fact about now. Every read
 *    path runs it through `@/core/queries/freshness`, so a live claim whose
 *    provenance has gone stale is reported as unconfirmed instead of live. It is
 *    never relabelled finished and never given a result;
 *  - children are batched: parents first, then every child kind fetched once for
 *    the whole page of parents. Two sequential phases per query, never per row.
 *
 * Storage access is injected as a `ChessReader`, so these functions can be
 * tested without a database and a different store could back them later.
 */

// --- Public shapes (canonical application data) ------------------------------

/** Re-exported so a UI can describe a live claim without a second import. */
export type { LiveClaim, LiveConfidence } from "@/core/queries/freshness";

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

/**
 * How far a tournament has got, counted from its stored round events.
 *
 * Deliberately counts rather than numbers the rounds: the canonical schema has
 * no round ordinal, so "round 4 of 7" would be an inference. `null` in place of
 * this object means "no rounds recorded", which is not the same as zero rounds.
 */
export interface ChessRoundProgress {
  total: number;
  /** Rounds already played ("recent" or "finished"). */
  completed: number;
  /** Rounds in progress whose live claim is still fresh. */
  live: number;
  /**
   * Rounds stored as live whose provenance has gone stale — last seen in
   * progress. Counted separately from both `live` and `completed`, because
   * neither is known to be true. `total` is the sum of all four buckets.
   */
  liveUnconfirmed: number;
  upcoming: number;
  /** Start of a confirmed live round, else of the soonest upcoming one. */
  nextStartTime: Date | null;
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
  /** Round progress, or null when no rounds are recorded. */
  rounds: ChessRoundProgress | null;
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
  /** Stored canonical status, verbatim. For "live", read `liveClaim` too. */
  status: EventStatus;
  startTime: Date | null;
  /** Game-level summary, e.g. "1-0". Null while undecided. */
  result: string | null;
  competitionName: string | null;
  relevantCountryIso2: string;
  sides: ChessGameSide[];
  sources: CanonicalSource[];
  /**
   * Present only when `status` is "live": whether that claim is still backed by
   * a recent fetch. "unconfirmed" means last seen in progress — the game is NOT
   * known to have finished, and `result` stays null.
   */
  liveClaim: LiveClaim | null;
}

export interface ChessCountryOverview {
  countryIso2: string;
  ongoingTournaments: ChessTournament[];
  upcomingTournaments: ChessTournament[];
  recentGames: ChessGame[];
  /** Games confirmed in progress: stored live AND freshly fetched. */
  liveGames: ChessGame[];
  /**
   * Games stored as live whose provenance has gone stale. Kept out of
   * `liveGames` so nothing claims to be happening now, and out of `recentGames`
   * so no finished result is implied. Empty in the healthy case.
   */
  unconfirmedGames: ChessGame[];
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

/**
 * Newest provenance timestamp anywhere in an overview — when the data on screen
 * was last confirmed. Null when nothing carries provenance.
 */
export function latestFetchedAt(overview: ChessCountryOverview): string | null {
  let latest: string | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  const consider = (sources: CanonicalSource[]): void => {
    for (const source of sources) {
      const ms = Date.parse(source.fetchedAt);
      if (Number.isNaN(ms) || ms <= latestMs) continue;
      latestMs = ms;
      latest = source.fetchedAt;
    }
  };
  for (const tournament of [
    ...overview.ongoingTournaments,
    ...overview.upcomingTournaments,
  ]) {
    consider(tournament.sources);
  }
  for (const game of [
    ...overview.liveGames,
    ...overview.unconfirmedGames,
    ...overview.recentGames,
  ]) {
    consider(game.sources);
  }
  return latest;
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

/** Earliest of two possibly-missing times. */
function earlier(current: Date | null, candidate: Date | null): Date | null {
  if (candidate === null) return current;
  if (current === null) return candidate;
  return candidate < current ? candidate : current;
}

/**
 * Count round states for one competition. Returns null for an empty list so a
 * tournament with no stored rounds reads as "unknown" rather than "no rounds".
 *
 * A round stored as live gets the same freshness guard as a game: once its fetch
 * has aged out it is counted as `liveUnconfirmed`, so the tournament stops
 * advertising a round in progress without being credited with having played it.
 */
export function summarizeRounds(
  rows: CompetitionRoundRow[],
  now: Date,
): ChessRoundProgress | null {
  if (rows.length === 0) return null;
  let completed = 0;
  let live = 0;
  let liveUnconfirmed = 0;
  let upcoming = 0;
  let liveStart: Date | null = null;
  let nextUpcoming: Date | null = null;
  for (const row of rows) {
    if (row.status === "live") {
      if (isConfirmedLive({ status: row.status, sources: row.sources }, now)) {
        live += 1;
        liveStart = earlier(liveStart, row.startTime);
      } else {
        liveUnconfirmed += 1;
      }
    } else if (row.status === "upcoming") {
      upcoming += 1;
      nextUpcoming = earlier(nextUpcoming, row.startTime);
    } else {
      // "recent" and "finished" both mean the round has been played.
      completed += 1;
    }
  }
  return {
    total: rows.length,
    completed,
    live,
    liveUnconfirmed,
    upcoming,
    nextStartTime: liveStart ?? nextUpcoming,
  };
}

export function assembleTournaments(
  rows: TournamentRow[],
  gmRows: TournamentGmRow[],
  roundRows: CompetitionRoundRow[],
  countryIso2: string,
  now: Date,
): ChessTournament[] {
  const byCompetition = groupBy(gmRows, (row) => row.competitionId);
  const roundsByCompetition = groupBy(roundRows, (row) => row.competitionId);
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
    rounds: summarizeRounds(roundsByCompetition.get(row.id) ?? [], now),
    sources: toCanonicalSources(row.sources),
  }));
}

export function assembleGames(
  rows: GameRow[],
  sideRows: GameSideRow[],
  countryIso2: string,
  now: Date,
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
    liveClaim: liveClaimFor({ status: row.status, sources: row.sources }, now),
  }));
}

/** Games this layer will present as in progress right now. */
function confirmedLive(games: ChessGame[]): ChessGame[] {
  return games.filter((game) => game.liveClaim?.confidence === "confirmed");
}

/** Games stored as live whose live claim can no longer be believed. */
function unconfirmedLive(games: ChessGame[]): ChessGame[] {
  return games.filter((game) => game.liveClaim?.confidence === "unconfirmed");
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
  /**
   * Read clock, used only for the live-freshness decision. Defaults to the
   * current time; injected by tests so the guard is deterministic.
   */
  now?: Date;
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
  const now = options.now ?? new Date();
  const rows = await reader.tournaments({
    countryIso2,
    statuses: options.statuses,
    order: options.order ?? "desc",
    limit: options.limit ?? DEFAULT_LIMIT,
  });
  if (rows.length === 0) return [];
  const competitionIds = uniqueIds(rows);
  // Entrants and rounds are independent children: one statement each, in
  // parallel, for the whole page of tournaments.
  const [gmRows, roundRows] = await Promise.all([
    reader.tournamentGms({ competitionIds, countryIso2 }),
    reader.competitionRounds({ competitionIds }),
  ]);
  return assembleTournaments(rows, gmRows, roundRows, countryIso2, now);
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
  const now = options.now ?? new Date();
  const rows = await reader.games({
    countryIso2,
    statuses: options.statuses,
    order: options.order ?? "desc",
    limit: options.limit ?? DEFAULT_LIMIT,
  });
  if (rows.length === 0) return [];
  const sideRows = await reader.gameSides({ eventIds: uniqueIds(rows) });
  return assembleGames(rows, sideRows, countryIso2, now);
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

/**
 * 4. Games confirmed in progress. Result stays null until the provider reports
 * one.
 *
 * Both this and `getUnconfirmedChessGames` read the same stored-live rows and
 * split them by freshness, so `limit` bounds the rows read, not the rows
 * returned: a page of live rows that has gone stale yields fewer here and the
 * remainder there.
 */
export async function getLiveChessGames(
  source: ChessDataSource,
  options: CountryLimitOptions,
): Promise<ChessGame[]> {
  return confirmedLive(await getStoredLiveChessGames(source, options));
}

/**
 * Games last seen in progress but no longer confirmed. Deliberately a separate
 * feed rather than a flag on the live one: a caller that only asks for live
 * games must never be handed a stale row by accident.
 */
export async function getUnconfirmedChessGames(
  source: ChessDataSource,
  options: CountryLimitOptions,
): Promise<ChessGame[]> {
  return unconfirmedLive(await getStoredLiveChessGames(source, options));
}

/** Every row whose stored status is "live", both fresh and stale. */
function getStoredLiveChessGames(
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
 * All four sections in two sequential phases: the four parent lists
 * concurrently, then entrants, rounds and sides each fetched once for the union
 * of parent ids. Calling the four functions above separately would repeat the
 * child batches.
 */
export async function getChessCountryOverview(
  source: ChessDataSource,
  options: CountryLimitOptions,
): Promise<ChessCountryOverview> {
  const reader = readerFor(source);
  const countryIso2 = normalizeCountryIso2(options.countryIso2);
  const limit = options.limit ?? DEFAULT_LIMIT;
  // One clock for the whole overview, so every section answers "live?" against
  // the same instant.
  const now = options.now ?? new Date();

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

  const [gmRows, roundRows, sideRows] = await Promise.all([
    competitionIds.length === 0
      ? Promise.resolve<TournamentGmRow[]>([])
      : reader.tournamentGms({ competitionIds, countryIso2 }),
    competitionIds.length === 0
      ? Promise.resolve<CompetitionRoundRow[]>([])
      : reader.competitionRounds({ competitionIds }),
    eventIds.length === 0
      ? Promise.resolve<GameSideRow[]>([])
      : reader.gameSides({ eventIds }),
  ]);

  const storedLive = assembleGames(liveRows, sideRows, countryIso2, now);

  return {
    countryIso2,
    ongoingTournaments: assembleTournaments(
      ongoingRows,
      gmRows,
      roundRows,
      countryIso2,
      now,
    ),
    upcomingTournaments: assembleTournaments(
      upcomingRows,
      gmRows,
      roundRows,
      countryIso2,
      now,
    ),
    recentGames: assembleGames(recentRows, sideRows, countryIso2, now),
    // One read of the stored-live rows, split by the freshness rule. A stale row
    // appears in exactly one of these, never in `recentGames`.
    liveGames: confirmedLive(storedLive),
    unconfirmedGames: unconfirmedLive(storedLive),
  };
}

/** India-first convenience wrapper — the only place "IN" is assumed. */
export function getIndiaChessOverview(
  source: ChessDataSource,
  options: { limit?: number; now?: Date } = {},
): Promise<ChessCountryOverview> {
  return getChessCountryOverview(source, {
    countryIso2: INDIA_ISO2,
    limit: options.limit,
    now: options.now,
  });
}
