import {
  Competition,
  type CompetitionParticipant,
  type CompetitionStatus,
  Event,
  type EventParticipant,
  type EventStatus,
  Participant,
  type SourceRef,
} from "@/core/models/canonical";
import {
  fedCode,
  parseTourDates,
  type LichessGame,
  type LichessPlayer,
  type LichessRound,
  type LichessTour,
} from "@/core/providers/chess/lichess-schemas";

/**
 * Pure raw-Lichess -> canonical mapping. No HTTP, no database, no clock of its
 * own (callers pass `now`), so every rule here is directly testable.
 *
 * Rules that matter:
 *  - India relevance requires CONFIRMED title "GM" AND FIDE federation "IND".
 *    A missing title or federation is UNKNOWN, never "not Indian".
 *  - Nothing is invented: absent dates, results and statuses stay null/absent.
 *    The only inference is the canonical status enum, which is derived from the
 *    flags and dates Lichess actually sends.
 */

export const LICHESS_PROVIDER_ID = "lichess";

/** FIDE federation codes we can safely resolve to ISO 3166-1 alpha-2. */
const FED_TO_ISO2: Record<string, string> = { IND: "IN" };

/** A finished event stays "recent" this long before it becomes "finished". */
const RECENT_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

// --- Small value helpers ----------------------------------------------------

/** Lichess timestamps are epoch milliseconds. Anything else becomes null. */
export function epochMsToDate(value: unknown): Date | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return new Date(value);
}

export function normalizeParticipantName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.replace(/\s+/g, " ").trim();
  return name.length > 0 ? name : null;
}

/** "gm" / " GM " -> "GM"; absent/blank -> null (unknown, not "untitled"). */
export function normalizeTitle(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const title = raw.replace(/\s+/g, "").toUpperCase();
  return title.length > 0 ? title : null;
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function source(providerRef: string, fetchedAt: Date, url?: unknown): SourceRef {
  const ref: SourceRef = {
    provider: LICHESS_PROVIDER_ID,
    providerRef,
    fetchedAt,
  };
  return isHttpUrl(url) ? { ...ref, url } : ref;
}

export function tourName(tour: LichessTour): string {
  return tour.name.replace(/\s+/g, " ").trim();
}

// --- Indian GM detection ----------------------------------------------------

/** Tri-state on purpose: absent data must never read as "not Indian". */
export type IndianGmVerdict = "yes" | "no" | "unknown";

export function classifyIndianGm(player: LichessPlayer): IndianGmVerdict {
  const title = normalizeTitle(player.title);
  const fed = fedCode(player.fed);
  if (title === null || fed === null) return "unknown";
  return title === "GM" && fed === "IND" ? "yes" : "no";
}

/** Only a confirmed GM + IND player can make something India-relevant. */
export function isConfirmedIndianGm(player: LichessPlayer): boolean {
  return classifyIndianGm(player) === "yes";
}

export function hasConfirmedIndianGm(games: LichessGame[]): boolean {
  return games.some((game) => (game.players ?? []).some(isConfirmedIndianGm));
}

/** Federation -> ISO2. Unmapped federations stay null rather than be guessed. */
export function playerCountryIso2(player: LichessPlayer): string | null {
  const fed = fedCode(player.fed);
  return fed === null ? null : (FED_TO_ISO2[fed] ?? null);
}

// --- Status / result derivation ---------------------------------------------

type PlayerResult = "win" | "loss" | "draw";

const RESULT_TABLE: Record<string, [PlayerResult, PlayerResult]> = {
  "1-0": ["win", "loss"],
  "0-1": ["loss", "win"],
  "1/2-1/2": ["draw", "draw"],
};

/**
 * Lichess broadcast games carry `status` as "*" while playing and a result
 * string once decided. Unrecognized values yield no result at all.
 */
export function parseGameResult(status: unknown): {
  summary: string | null;
  perPlayer: [PlayerResult, PlayerResult] | null;
} {
  if (typeof status !== "string") return { summary: null, perPlayer: null };
  const key = status.replace(/½/g, "1/2").replace(/\s+/g, "");
  const perPlayer = RESULT_TABLE[key];
  if (!perPlayer) return { summary: null, perPlayer: null };
  return { summary: key, perPlayer };
}

function finishedStatus(when: Date | null, now: Date): EventStatus {
  if (when === null) return "finished";
  return now.getTime() - when.getTime() <= RECENT_WINDOW_MS
    ? "recent"
    : "finished";
}

export function roundEventStatus(round: LichessRound, now: Date): EventStatus {
  if (round.ongoing === true) return "live";
  if (round.finished === true) {
    return finishedStatus(epochMsToDate(round.startsAt), now);
  }
  // Neither flag set: not started as far as Lichess is concerned.
  return "upcoming";
}

function earliestRoundStart(rounds: LichessRound[]): Date | null {
  const times = rounds
    .map((round) => epochMsToDate(round.startsAt))
    .filter((date): date is Date => date !== null)
    .map((date) => date.getTime());
  return times.length > 0 ? new Date(Math.min(...times)) : null;
}

/**
 * Competition status from the strongest signal available: round flags first,
 * then tournament dates, then the earliest round start. Never a guess beyond
 * the three values the canonical enum allows.
 */
export function deriveCompetitionStatus(
  rounds: LichessRound[],
  dates: { start: number | null; end: number | null },
  now: Date,
): CompetitionStatus {
  if (rounds.some((round) => round.ongoing === true)) return "ongoing";
  const finished = rounds.filter((round) => round.finished === true).length;
  if (rounds.length > 0) {
    if (finished === rounds.length) return "finished";
    if (finished > 0) return "ongoing";
  }
  const end = epochMsToDate(dates.end);
  if (end !== null && end.getTime() < now.getTime()) return "finished";
  const start = epochMsToDate(dates.start) ?? earliestRoundStart(rounds);
  if (start !== null) {
    return start.getTime() > now.getTime() ? "upcoming" : "ongoing";
  }
  return "upcoming";
}

// --- Player -> canonical participant ----------------------------------------

/** Prefer the richest sighting of a player across rounds. */
function playerInfoScore(player: LichessPlayer): number {
  return (
    (normalizeTitle(player.title) === null ? 0 : 1) +
    (fedCode(player.fed) === null ? 0 : 1) +
    (typeof player.fideId === "number" ? 1 : 0)
  );
}

export function mapPlayerToParticipant(
  player: LichessPlayer,
  fetchedAt: Date,
): Participant | null {
  const name = normalizeParticipantName(player.name);
  if (name === null) return null;
  const ref =
    typeof player.fideId === "number" ? `fide:${player.fideId}` : `player:${name}`;
  return Participant.parse({
    sport: "chess",
    type: "player",
    name,
    countryIso2: playerCountryIso2(player),
    title: normalizeTitle(player.title),
    sources: [source(ref, fetchedAt)],
  });
}

// --- Rounds and games -> canonical events -----------------------------------

/**
 * A round is a container event. Its participation lives on its game events and
 * on competition_participants, so it carries no participant rows of its own.
 */
export function mapRoundToEvent(
  tour: LichessTour,
  round: LichessRound,
  options: { fetchedAt: Date; now: Date; indiaRelevant: boolean },
): Event {
  return Event.parse({
    sport: "chess",
    kind: "round",
    status: roundEventStatus(round, options.now),
    competitionName: tourName(tour),
    startTime: epochMsToDate(round.startsAt),
    participants: [],
    result: null,
    venueCountryIso2: null,
    relevantCountryIso2: options.indiaRelevant ? ["IN"] : [],
    sources: [source(round.id, options.fetchedAt, round.url)],
  });
}

/**
 * One board. Roles come from board order (white first), and any player beyond
 * the second keeps a null role instead of being forced into a two-sided shape.
 */
export function mapGameToEvent(
  tour: LichessTour,
  round: LichessRound,
  game: LichessGame,
  options: { fetchedAt: Date; now: Date },
): Event {
  const players = game.players ?? [];
  const { summary, perPlayer } = parseGameResult(game.status);
  // Lichess gives no per-game clock time; the round's start is the only real
  // timestamp available, so it is inherited rather than invented.
  const startTime = epochMsToDate(round.startsAt);

  const participants: EventParticipant[] = [];
  players.forEach((player, index) => {
    const name = normalizeParticipantName(player.name);
    if (name === null) return;
    participants.push({
      participantName: name,
      countryIso2: playerCountryIso2(player),
      title: normalizeTitle(player.title),
      role: index === 0 ? "white" : index === 1 ? "black" : null,
      score: null,
      result: perPlayer !== null && index < 2 ? (perPlayer[index] ?? null) : null,
      position: null,
    });
  });

  return Event.parse({
    sport: "chess",
    kind: "game",
    status: summary === null ? roundEventStatus(round, options.now) : finishedStatus(startTime, options.now),
    competitionName: tourName(tour),
    startTime,
    participants,
    result: summary,
    venueCountryIso2: null,
    relevantCountryIso2: players.some(isConfirmedIndianGm) ? ["IN"] : [],
    sources: [
      source(`${round.id}/${game.id}`, options.fetchedAt, round.url),
    ],
  });
}

// --- Whole tournament -------------------------------------------------------

/** Everything we know about one broadcast after fetching. */
export interface LichessTournamentBundle {
  tour: LichessTour;
  /** Rounds as advertised by discovery (metadata only, no games needed). */
  rounds: LichessRound[];
  /** Games per round id — only for rounds whose detail we actually fetched. */
  gamesByRoundId: Record<string, LichessGame[]>;
  fetchedAt: Date;
}

export interface MappedTournament {
  competition: Competition;
  events: Event[];
  participants: Participant[];
}

export function mapTournament(
  bundle: LichessTournamentBundle,
  now: Date = new Date(),
): MappedTournament {
  const { tour, rounds, gamesByRoundId, fetchedAt } = bundle;
  const events: Event[] = [];
  const bestByKey = new Map<string, LichessPlayer>();
  let indiaRelevant = false;

  for (const round of rounds) {
    const games = gamesByRoundId[round.id] ?? [];
    const roundHasIndianGm = hasConfirmedIndianGm(games);
    if (roundHasIndianGm) indiaRelevant = true;

    events.push(
      mapRoundToEvent(tour, round, {
        fetchedAt,
        now,
        indiaRelevant: roundHasIndianGm,
      }),
    );

    for (const game of games) {
      for (const player of game.players ?? []) {
        const name = normalizeParticipantName(player.name);
        if (name === null) continue;
        const key = name.toLowerCase();
        const existing = bestByKey.get(key);
        if (
          existing === undefined ||
          playerInfoScore(player) > playerInfoScore(existing)
        ) {
          bestByKey.set(key, player);
        }
      }
      events.push(mapGameToEvent(tour, round, game, { fetchedAt, now }));
    }
  }

  const discovered = [...bestByKey.values()];
  const participants = discovered
    .map((player) => mapPlayerToParticipant(player, fetchedAt))
    .filter((p): p is Participant => p !== null);

  // Appearing on a board is entry, which is a fact; rank stays unknown.
  const competitionParticipants: CompetitionParticipant[] = participants.map(
    (participant) => ({
      participantName: participant.name,
      countryIso2: participant.countryIso2,
      title: participant.title,
      status: "entered",
      finalRank: null,
    }),
  );

  const dates = parseTourDates(tour.dates);
  const competition = Competition.parse({
    sport: "chess",
    name: tourName(tour),
    kind: "tournament",
    status: deriveCompetitionStatus(rounds, dates, now),
    // Fall back to a real round start, never to an invented date.
    startDate: epochMsToDate(dates.start) ?? earliestRoundStart(rounds),
    endDate: epochMsToDate(dates.end),
    hostCountryIso2: null,
    participants: competitionParticipants,
    relevantCountryIso2: indiaRelevant ? ["IN"] : [],
    sources: [source(tour.id, fetchedAt, tour.url)],
  });

  return { competition, events, participants };
}
