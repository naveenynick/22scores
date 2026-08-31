import type {
  Competition,
  Event,
  Participant,
  SportKey,
} from "@/core/models/canonical";
import type {
  ProviderCapabilities,
  ProviderHealth,
  ProviderQuery,
  SportProvider,
} from "@/core/providers/types";
import { LichessClient } from "@/core/providers/chess/lichess-client";
import {
  extractPastEntries,
  LichessBroadcastListEntry,
  LichessRoundDetail,
  LichessTopResponse,
  type LichessGame,
  type LichessRound,
  type LichessTour,
} from "@/core/providers/chess/lichess-schemas";
import {
  mapTournament,
  type MappedTournament,
} from "@/core/providers/chess/lichess-mapper";

/**
 * Production Lichess provider: broadcast (tournament) discovery for chess.
 *
 * Discovery backbone is the paginated `/api/broadcast` NDJSON feed, which our
 * spike showed covers upcoming events that `/api/broadcast/top` omits. `top` is
 * still consulted for currently-active broadcasts. Rounds come free with the
 * discovery payload; only games need a per-round request, so the request budget
 * stays small and bounded.
 *
 * Round selection is the part that decides whether stored data can heal. Games
 * only exist in a round-detail response, so a round the sync stops asking for is
 * a round whose games freeze at whatever they last said — including "live". The
 * budget below therefore always revisits the rounds that can still change (the
 * one under way and the ones that just finished) rather than a single fixed
 * round per tournament, while a global ceiling keeps the request count bounded.
 *
 * Discovery alone is still not enough for that, because ranking works against
 * it: a broadcast falls out of the "active" bucket the moment its last round
 * finishes, which is precisely when its games most need re-reading. So a snapshot
 * starts with a recovery pass over round ids ingestion already stored for rows it
 * can no longer confirm as live (`query.refreshRefs`), fetching those rounds by
 * id. Recovered rounds join the same mapping path as discovered ones — there is
 * no second way into the database — and every request they make is spent from the
 * same ceiling.
 *
 * The aggregator calls getCompetitions/getEvents/getParticipants separately, so
 * one fetched snapshot is memoized briefly and shared between them.
 */

const DEFAULT_PAGES = 1;
const DEFAULT_MAX_TOURNAMENTS = 12;
const DEFAULT_SNAPSHOT_TTL_MS = 5 * 60 * 1000;

/**
 * Rounds to re-read per tournament, by what each can still tell us:
 *  - `ongoing`: games are changing right now. Two, because a broadcast can carry
 *    overlapping rounds (a delayed round beside the current one);
 *  - `recentlyFinished`: the rounds that make stale data heal. The round that was
 *    live during the previous sync lands here, and re-reading it is what turns
 *    its games from "live" into a real result. Two covers a sync that was skipped;
 *  - `upcoming`: one, only so the next round's pairings appear before it starts.
 */
const DEFAULT_ROUND_BUDGET: RoundBudget = {
  ongoing: 2,
  recentlyFinished: 2,
  upcoming: 1,
};

/**
 * Hard ceiling on round-detail requests per snapshot, across all tournaments.
 * At the client's 1.2 s serialized spacing this bounds one snapshot to roughly
 * half a minute of requests and keeps it far under Lichess's rate limit, however
 * many tournaments discovery returns.
 */
const DEFAULT_MAX_ROUND_REQUESTS = 24;

/**
 * How far back a finished round is still worth re-reading. Older than this it
 * cannot have changed, and asking again would be crawling history. Wide enough
 * that a sync which has not run for a couple of days still heals what it left
 * behind.
 */
const RECENT_ROUND_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

/** A Lichess id as we store it: a short url-safe token, nothing else. */
const LICHESS_ROUND_ID = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * Round-detail reads the recovery pass may spend, out of the shared ceiling.
 *
 * A quarter of it. Recovering one round can cost a second request when discovery
 * no longer returns its tournament at all (see `completeRecoveredTour`), so this
 * keeps recovery inside half the ceiling however long the stale backlog is, and
 * leaves the other half to normal discovery. Whatever recovery does not spend is
 * left to discovery too.
 */
function recoveryRoundAllowance(maxRoundRequests: number): number {
  return Math.max(0, Math.floor(maxRoundRequests / 4));
}

/** Per-tournament round-detail allowance, by round state. */
export interface RoundBudget {
  ongoing: number;
  recentlyFinished: number;
  upcoming: number;
}

export interface LichessProviderOptions {
  client?: LichessClient;
  /** Discovery pages to read from /api/broadcast (1 page ~= 20 tournaments). */
  pages?: number;
  maxTournaments?: number;
  /** Per-tournament round allowance. See `DEFAULT_ROUND_BUDGET`. */
  roundBudget?: Partial<RoundBudget>;
  /** Global ceiling on round-detail requests for one snapshot. */
  maxRoundRequests?: number;
  useTop?: boolean;
  snapshotTtlMs?: number;
  now?: () => Date;
}

/** A tournament plus whatever rounds discovery advertised for it. */
interface DiscoveredTournament {
  tour: LichessTour;
  rounds: Map<string, LichessRound>;
}

interface Snapshot {
  key: string;
  takenAt: number;
  tournaments: MappedTournament[];
}

function statusBucket(rounds: LichessRound[]): number {
  if (rounds.some((r) => r.ongoing === true)) return 0; // active now
  if (rounds.some((r) => r.finished !== true)) return 1; // something to come
  return 2; // fully finished
}

function earliestStart(rounds: LichessRound[]): number {
  const times = rounds
    .map((r) => (typeof r.startsAt === "number" ? r.startsAt : null))
    .filter((v): v is number => v !== null);
  return times.length > 0 ? Math.min(...times) : Number.MAX_SAFE_INTEGER;
}

/**
 * Rounds worth re-reading, best first, within the per-tournament budget.
 *
 * Priority is by what can still change: a round under way, then the rounds that
 * finished most recently, then the next one due. The middle group is the reason
 * a game that was live during an earlier sync can become a result — it is not
 * enough to follow whatever round is live now.
 */
export function pickRounds(
  rounds: LichessRound[],
  budget: RoundBudget,
  nowMs: number,
): LichessRound[] {
  const byStartDesc = (a: LichessRound, b: LichessRound) =>
    (b.startsAt ?? 0) - (a.startsAt ?? 0);
  const byStartAsc = (a: LichessRound, b: LichessRound) =>
    (a.startsAt ?? Number.MAX_SAFE_INTEGER) -
    (b.startsAt ?? Number.MAX_SAFE_INTEGER);

  const ongoing = rounds.filter((r) => r.ongoing === true);
  const finished = rounds
    .filter(
      (r) =>
        r.ongoing !== true &&
        r.finished === true &&
        // An undated round cannot be ruled out, so it stays eligible; it sorts
        // last within the group either way.
        (r.startsAt === undefined || nowMs - r.startsAt <= RECENT_ROUND_WINDOW_MS),
    )
    .sort(byStartDesc);
  const pending = rounds
    .filter((r) => r.ongoing !== true && r.finished !== true)
    .sort(byStartAsc);

  return [
    ...ongoing.slice(0, Math.max(0, budget.ongoing)),
    ...finished.slice(0, Math.max(0, budget.recentlyFinished)),
    ...pending.slice(0, Math.max(0, budget.upcoming)),
  ];
}

/** One round-detail request: which tournament it belongs to, and which round. */
interface RoundRequest {
  tournamentIndex: number;
  round: LichessRound;
}

/**
 * The round-detail requests to make, in the order to make them.
 *
 * Interleaved by priority rather than run tournament by tournament: every
 * tournament's first-choice round is requested before any tournament's second,
 * so the global ceiling trims the least valuable requests instead of starving
 * whatever discovery happened to return last.
 */
export function planRoundRequests(
  tournaments: readonly { rounds: Map<string, LichessRound> }[],
  budget: RoundBudget,
  maxRequests: number,
  nowMs: number,
): RoundRequest[] {
  const picked = tournaments.map((item) =>
    pickRounds([...item.rounds.values()], budget, nowMs),
  );
  const deepest = picked.reduce((max, list) => Math.max(max, list.length), 0);
  const plan: RoundRequest[] = [];
  for (let rank = 0; rank < deepest; rank += 1) {
    for (const [tournamentIndex, list] of picked.entries()) {
      const round = list[rank];
      if (round === undefined) continue;
      if (plan.length >= Math.max(0, maxRequests)) return plan;
      plan.push({ tournamentIndex, round });
    }
  }
  return plan;
}

function matchesCountry(relevant: string[], country?: string): boolean {
  if (country === undefined) return true;
  return relevant.includes(country.toUpperCase());
}

// --- Recovering rounds we already stored -------------------------------------

/**
 * The distinct round ids hidden in stored refs, best-effort and bounded.
 *
 * Chess ingestion writes a game's ref as `${round.id}/${game.id}` and a round's
 * as its own id, so the segment before the first slash is the round to re-read in
 * both cases — one request covers a round's whole board list. Nothing is guessed:
 * a ref that is not a Lichess id we could have written is skipped rather than
 * turned into a URL.
 */
export function recoveryRoundIds(
  refs: readonly string[] | undefined,
  max: number,
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const ceiling = Math.max(0, max);
  for (const ref of refs ?? []) {
    if (ids.length >= ceiling) break;
    const roundId = ref.trim().split("/")[0]?.trim() ?? "";
    if (!LICHESS_ROUND_ID.test(roundId)) continue;
    if (seen.has(roundId)) continue;
    seen.add(roundId);
    ids.push(roundId);
  }
  return ids;
}

/** What a recovery pass learned, before discovery is merged into it. */
interface Recovery {
  /** Tour id -> that tournament, as the re-read rounds describe it. */
  tournaments: Map<string, DiscoveredTournament>;
  /** Tour id -> round id -> the boards that round returned. */
  gamesByTour: Map<string, Record<string, LichessGame[]>>;
  /** Rounds already re-read, so the discovery plan does not ask again. */
  roundIds: Set<string>;
  requests: number;
}

/**
 * A round re-read directly is the freshest thing we have about it, so it wins
 * over a listing sighting — the opposite of `absorb`, which fills gaps in data
 * already held.
 */
function mergeRecovered(
  target: DiscoveredTournament,
  recovered: DiscoveredTournament,
): void {
  target.tour = { ...target.tour, ...recovered.tour };
  for (const [id, round] of recovered.rounds) {
    const prev = target.rounds.get(id);
    target.rounds.set(id, prev === undefined ? round : { ...prev, ...round });
  }
}

/** The same tournament with the given rounds hidden from round planning. */
function withoutRounds(
  item: DiscoveredTournament,
  skip: ReadonlySet<string>,
): { rounds: Map<string, LichessRound> } {
  if (skip.size === 0) return item;
  const rounds = new Map<string, LichessRound>();
  for (const [id, round] of item.rounds) {
    if (!skip.has(id)) rounds.set(id, round);
  }
  return { rounds };
}

export class LichessChessProvider implements SportProvider {
  readonly id = "lichess";
  readonly sport: SportKey = "chess";
  readonly capabilities: ProviderCapabilities = {
    liveEvents: true,
    upcomingEvents: true,
    recentEvents: true,
    tournamentDiscovery: true,
    participants: true,
  };

  private readonly client: LichessClient;
  private readonly pages: number;
  private readonly maxTournaments: number;
  private readonly roundBudget: RoundBudget;
  private readonly maxRoundRequests: number;
  private readonly useTop: boolean;
  private readonly snapshotTtlMs: number;
  private readonly now: () => Date;

  private snapshot: Snapshot | null = null;
  private inflight: Promise<Snapshot> | null = null;
  private lastError: string | null = null;
  private lastErrorAt = 0;

  constructor(options: LichessProviderOptions = {}) {
    this.client = options.client ?? new LichessClient();
    this.pages = options.pages ?? DEFAULT_PAGES;
    this.maxTournaments = options.maxTournaments ?? DEFAULT_MAX_TOURNAMENTS;
    this.roundBudget = { ...DEFAULT_ROUND_BUDGET, ...options.roundBudget };
    this.maxRoundRequests =
      options.maxRoundRequests ?? DEFAULT_MAX_ROUND_REQUESTS;
    this.useTop = options.useTop ?? true;
    this.snapshotTtlMs = options.snapshotTtlMs ?? DEFAULT_SNAPSHOT_TTL_MS;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Reports the outcome of the last real fetch instead of spending a request.
   * A failure only suppresses the provider for a short cooldown, so a blip
   * cannot take chess offline for the life of the process.
   */
  async health(): Promise<ProviderHealth> {
    const checkedAt = this.now();
    if (
      this.lastError !== null &&
      Date.now() - this.lastErrorAt < this.snapshotTtlMs
    ) {
      return { ok: false, checkedAt, detail: this.lastError };
    }
    return {
      ok: true,
      checkedAt,
      detail: this.snapshot === null ? "not yet fetched" : "snapshot cached",
    };
  }

  async getCompetitions(query: ProviderQuery = {}): Promise<Competition[]> {
    const tournaments = await this.snapshotFor(query);
    return tournaments
      .map((t) => t.competition)
      .filter((c) => matchesCountry(c.relevantCountryIso2, query.country));
  }

  async getEvents(query: ProviderQuery = {}): Promise<Event[]> {
    const tournaments = await this.snapshotFor(query);
    let events = tournaments.flatMap((t) => t.events);
    if (query.country !== undefined) {
      events = events.filter((e) =>
        matchesCountry(e.relevantCountryIso2, query.country),
      );
    }
    const wanted = query.status;
    if (wanted !== undefined && wanted.length > 0) {
      events = events.filter((e) => wanted.includes(e.status));
    }
    const since = query.since;
    if (since !== undefined) {
      events = events.filter(
        (e) => e.startTime !== null && e.startTime >= since,
      );
    }
    const until = query.until;
    if (until !== undefined) {
      events = events.filter(
        (e) => e.startTime !== null && e.startTime <= until,
      );
    }
    return events;
  }

  async getParticipants(query: ProviderQuery = {}): Promise<Participant[]> {
    const tournaments = await this.snapshotFor(query);
    const country = query.country?.toUpperCase();
    const byName = new Map<string, Participant>();
    for (const tournament of tournaments) {
      for (const participant of tournament.participants) {
        if (country !== undefined && participant.countryIso2 !== country) {
          continue;
        }
        const key = participant.name.toLowerCase();
        if (!byName.has(key)) byName.set(key, participant);
      }
    }
    return [...byName.values()];
  }

  // --- Snapshot -------------------------------------------------------------

  /** One fetch shared by all three read methods for the TTL window. */
  private async snapshotFor(query: ProviderQuery): Promise<MappedTournament[]> {
    const maxTournaments = query.limit ?? this.maxTournaments;
    // Only this provider's own refs, and only as many rounds as recovery may
    // spend, so the ids below are exactly the requests the pass will make.
    const recoveryIds = recoveryRoundIds(
      query.refreshRefs?.[this.id],
      Math.min(
        Math.max(0, this.maxRoundRequests),
        recoveryRoundAllowance(this.maxRoundRequests),
      ),
    );
    const key = [
      this.pages,
      maxTournaments,
      this.roundBudget.ongoing,
      this.roundBudget.recentlyFinished,
      this.roundBudget.upcoming,
      this.maxRoundRequests,
      this.useTop,
      // A different recovery set is a different snapshot: reusing a cached one
      // would silently skip the heal it was asked for.
      recoveryIds.join(","),
    ].join("|");

    const cached = this.snapshot;
    if (
      cached !== null &&
      cached.key === key &&
      Date.now() - cached.takenAt < this.snapshotTtlMs
    ) {
      return cached.tournaments;
    }

    const pending = this.inflight;
    if (pending !== null) {
      const settled = await pending;
      if (settled.key === key) return settled.tournaments;
    }

    const run = this.fetchSnapshot(key, maxTournaments, recoveryIds);
    this.inflight = run;
    try {
      const result = await run;
      this.snapshot = result;
      this.lastError = null;
      return result.tournaments;
    } catch (error) {
      // Surface upward: the aggregator skips this provider for the cycle and
      // nothing is written, so existing rows are untouched.
      this.lastError = error instanceof Error ? error.message : String(error);
      this.lastErrorAt = Date.now();
      throw error;
    } finally {
      if (this.inflight === run) this.inflight = null;
    }
  }

  /** Merge a discovery sighting, filling gaps without discarding known data. */
  private absorb(
    into: Map<string, DiscoveredTournament>,
    tour: LichessTour,
    rounds: LichessRound[],
  ): void {
    const existing = into.get(tour.id);
    if (existing === undefined) {
      into.set(tour.id, {
        tour,
        rounds: new Map(rounds.map((r) => [r.id, r])),
      });
      return;
    }
    existing.tour = { ...tour, ...existing.tour };
    for (const round of rounds) {
      const prev = existing.rounds.get(round.id);
      existing.rounds.set(round.id, prev ? { ...round, ...prev } : round);
    }
  }

  private async discover(): Promise<Map<string, DiscoveredTournament>> {
    const discovered = new Map<string, DiscoveredTournament>();

    // Primary source: paginated NDJSON, rounds included inline.
    for (let page = 1; page <= this.pages; page += 1) {
      const lines = await this.client.getNdjson(`/api/broadcast?page=${page}`);
      for (const line of lines) {
        const parsed = LichessBroadcastListEntry.safeParse(line);
        if (!parsed.success) continue; // one bad record, not a failed sync
        this.absorb(discovered, parsed.data.tour, parsed.data.rounds ?? []);
      }
    }

    // Supplementary: currently-active/notable broadcasts. Never fatal.
    if (this.useTop) {
      try {
        const parsed = LichessTopResponse.safeParse(
          await this.client.getJson("/api/broadcast/top"),
        );
        if (parsed.success) {
          const entries = [
            ...(parsed.data.active ?? []),
            ...(parsed.data.upcoming ?? []),
            ...extractPastEntries(parsed.data.past),
          ];
          for (const entry of entries) {
            this.absorb(
              discovered,
              entry.tour,
              entry.round === undefined ? [] : [entry.round],
            );
          }
        }
      } catch {
        // Discovery already succeeded; proceed with what we have.
      }
    }

    return discovered;
  }

  /**
   * Re-read rounds by id, for rows ingestion could no longer confirm as live.
   *
   * One request per round, capped before this is called. A round that fails is
   * skipped: recovery is best-effort repair, and nothing here is allowed to turn
   * into an outage that would stop the rest of the snapshot being written.
   */
  private async recoverStaleRounds(roundIds: readonly string[]): Promise<Recovery> {
    const recovery: Recovery = {
      tournaments: new Map(),
      gamesByTour: new Map(),
      roundIds: new Set(),
      requests: 0,
    };

    for (const roundId of roundIds) {
      try {
        recovery.requests += 1;
        const detail = LichessRoundDetail.safeParse(
          await this.client.getJson(`/api/broadcast/-/-/${roundId}`),
        );
        if (!detail.success) continue;
        const { tour, round, games } = detail.data;

        const existing = recovery.tournaments.get(tour.id);
        if (existing === undefined) {
          recovery.tournaments.set(tour.id, {
            tour,
            rounds: new Map([[round.id, round]]),
          });
        } else {
          mergeRecovered(existing, { tour, rounds: new Map([[round.id, round]]) });
        }

        const byRound = recovery.gamesByTour.get(tour.id) ?? {};
        byRound[round.id] = games ?? [];
        recovery.gamesByTour.set(tour.id, byRound);

        recovery.roundIds.add(roundId);
        recovery.roundIds.add(round.id);
      } catch {
        // One round failing must not cost the others, or the snapshot.
      }
    }

    return recovery;
  }

  /**
   * Fill in a recovered tournament's remaining rounds from its own page.
   *
   * A recovery read describes one round, and a competition status derived from
   * one round out of seven would be a fabrication — "all known rounds finished"
   * is not "the tournament finished". One request buys the real round list. The
   * round we re-read still wins for itself, being the fresher read.
   */
  private async completeRecoveredTour(item: DiscoveredTournament): Promise<boolean> {
    try {
      const parsed = LichessBroadcastListEntry.safeParse(
        await this.client.getJson(`/api/broadcast/${item.tour.id}`),
      );
      if (!parsed.success) return false;
      item.tour = { ...item.tour, ...parsed.data.tour };
      for (const round of parsed.data.rounds ?? []) {
        const prev = item.rounds.get(round.id);
        item.rounds.set(round.id, prev === undefined ? round : { ...round, ...prev });
      }
      return true;
    } catch {
      return false;
    }
  }

  private async fetchSnapshot(
    key: string,
    maxTournaments: number,
    recoveryIds: readonly string[],
  ): Promise<Snapshot> {
    // One provenance timestamp for the whole snapshot, taken before the first
    // request: a snapshot takes tens of seconds to gather, and stamping it at the
    // start means provenance never claims data is fresher than it is. The
    // read-time freshness guard depends on that being honest.
    const fetchedAt = this.now();
    const ceiling = Math.max(0, this.maxRoundRequests);

    // Heal first. These rounds are known to hold rows still claiming to be live,
    // so they are worth more than anything ranking could offer.
    const recovery = await this.recoverStaleRounds(recoveryIds);
    let requestsUsed = recovery.requests;

    const discovered = await this.discover();

    // Tournaments discovery did not return are known only through the round just
    // re-read, so they need completing before they can be mapped.
    const needCompleting = [...recovery.tournaments.keys()].filter(
      (tourId) => !discovered.has(tourId),
    );
    const recovered = new Set(recovery.tournaments.keys());
    for (const [tourId, item] of recovery.tournaments) {
      const existing = discovered.get(tourId);
      if (existing === undefined) discovered.set(tourId, item);
      else mergeRecovered(existing, item);
    }
    for (const tourId of needCompleting) {
      const item = discovered.get(tourId);
      if (item === undefined) continue;
      let completed = false;
      if (requestsUsed < ceiling) {
        requestsUsed += 1;
        completed = await this.completeRecoveredTour(item);
      }
      if (completed) continue;
      // Rather than derive a status from a partial round list, drop the
      // tournament and let the next sync heal it.
      discovered.delete(tourId);
      recovered.delete(tourId);
    }

    // Active first, then anything still to come, then finished; importance and
    // start time break ties. Bounded so we never crawl Lichess history.
    const ordered = [...discovered.values()].sort((a, b) => {
      const roundsA = [...a.rounds.values()];
      const roundsB = [...b.rounds.values()];
      const bucket = statusBucket(roundsA) - statusBucket(roundsB);
      if (bucket !== 0) return bucket;
      const tier = (b.tour.tier ?? 0) - (a.tour.tier ?? 0);
      if (tier !== 0) return tier;
      return earliestStart(roundsA) - earliestStart(roundsB);
    });

    // Recovery targets are kept regardless of where they rank — being unrankable
    // is why they went stale — and they do not consume discovery's slots.
    const selected = [
      ...ordered.filter((item) => recovered.has(item.tour.id)),
      ...ordered
        .filter((item) => !recovered.has(item.tour.id))
        .slice(0, Math.max(0, maxTournaments)),
    ];
    const plan = planRoundRequests(
      selected.map((item) => withoutRounds(item, recovery.roundIds)),
      this.roundBudget,
      Math.max(0, ceiling - requestsUsed),
      fetchedAt.getTime(),
    );

    // Games only exist in a round-detail response, so they are collected per
    // tournament as the plan runs; the round map and tour metadata are patched
    // in place with the freshest flags each response carries. Boards already
    // recovered are seeded here, which is what puts them through the one mapper.
    const gamesByTournament = new Map<number, Record<string, LichessGame[]>>();
    const tours = new Map<number, LichessTour>();
    selected.forEach((item, index) => {
      const games = recovery.gamesByTour.get(item.tour.id);
      if (games !== undefined) gamesByTournament.set(index, { ...games });
    });

    for (const { tournamentIndex, round } of plan) {
      const item = selected[tournamentIndex];
      if (item === undefined) continue;
      try {
        const detail = LichessRoundDetail.safeParse(
          await this.client.getJson(`/api/broadcast/-/-/${round.id}`),
        );
        if (!detail.success) continue;
        const games = gamesByTournament.get(tournamentIndex) ?? {};
        games[round.id] = detail.data.games ?? [];
        gamesByTournament.set(tournamentIndex, games);
        item.rounds.set(round.id, { ...round, ...detail.data.round });
        tours.set(tournamentIndex, {
          ...(tours.get(tournamentIndex) ?? item.tour),
          ...detail.data.tour,
        });
      } catch {
        // A single round failing must not lose the whole tournament.
      }
    }

    const tournaments = selected.map((item, index) =>
      mapTournament(
        {
          tour: tours.get(index) ?? item.tour,
          rounds: [...item.rounds.values()],
          gamesByRoundId: gamesByTournament.get(index) ?? {},
          fetchedAt,
        },
        fetchedAt,
      ),
    );

    return { key, takenAt: Date.now(), tournaments };
  }
}
