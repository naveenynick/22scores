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
 * The aggregator calls getCompetitions/getEvents/getParticipants separately, so
 * one fetched snapshot is memoized briefly and shared between them.
 */

const DEFAULT_PAGES = 1;
const DEFAULT_MAX_TOURNAMENTS = 12;
const DEFAULT_ROUNDS_PER_TOURNAMENT = 1;
const DEFAULT_SNAPSHOT_TTL_MS = 5 * 60 * 1000;

export interface LichessProviderOptions {
  client?: LichessClient;
  /** Discovery pages to read from /api/broadcast (1 page ~= 20 tournaments). */
  pages?: number;
  maxTournaments?: number;
  /** Rounds per tournament to fetch games for. Kept tiny on purpose. */
  roundsPerTournament?: number;
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

/** Rounds most likely to actually contain games, best first. */
function pickRounds(rounds: LichessRound[], max: number): LichessRound[] {
  const byStartDesc = (a: LichessRound, b: LichessRound) =>
    (b.startsAt ?? 0) - (a.startsAt ?? 0);
  const byStartAsc = (a: LichessRound, b: LichessRound) =>
    (a.startsAt ?? Number.MAX_SAFE_INTEGER) -
    (b.startsAt ?? Number.MAX_SAFE_INTEGER);

  const ongoing = rounds.filter((r) => r.ongoing === true);
  const finished = rounds
    .filter((r) => r.ongoing !== true && r.finished === true)
    .sort(byStartDesc);
  const pending = rounds
    .filter((r) => r.ongoing !== true && r.finished !== true)
    .sort(byStartAsc);

  return [...ongoing, ...finished, ...pending].slice(0, Math.max(0, max));
}

function matchesCountry(relevant: string[], country?: string): boolean {
  if (country === undefined) return true;
  return relevant.includes(country.toUpperCase());
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
  private readonly roundsPerTournament: number;
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
    this.roundsPerTournament =
      options.roundsPerTournament ?? DEFAULT_ROUNDS_PER_TOURNAMENT;
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
    const key = [
      this.pages,
      maxTournaments,
      this.roundsPerTournament,
      this.useTop,
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

    const run = this.fetchSnapshot(key, maxTournaments);
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

  private async fetchSnapshot(
    key: string,
    maxTournaments: number,
  ): Promise<Snapshot> {
    const discovered = await this.discover();

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

    const tournaments: MappedTournament[] = [];
    for (const item of ordered.slice(0, Math.max(0, maxTournaments))) {
      let tour = item.tour;
      const gamesByRoundId: Record<string, LichessGame[]> = {};

      for (const round of pickRounds(
        [...item.rounds.values()],
        this.roundsPerTournament,
      )) {
        try {
          const detail = LichessRoundDetail.safeParse(
            await this.client.getJson(`/api/broadcast/-/-/${round.id}`),
          );
          if (!detail.success) continue;
          // Round detail carries the freshest flags and tournament metadata.
          gamesByRoundId[round.id] = detail.data.games ?? [];
          item.rounds.set(round.id, { ...round, ...detail.data.round });
          tour = { ...tour, ...detail.data.tour };
        } catch {
          // A single round failing must not lose the whole tournament.
        }
      }

      const fetchedAt = this.now();
      tournaments.push(
        mapTournament(
          {
            tour,
            rounds: [...item.rounds.values()],
            gamesByRoundId,
            fetchedAt,
          },
          fetchedAt,
        ),
      );
    }

    return { key, takenAt: Date.now(), tournaments };
  }
}
