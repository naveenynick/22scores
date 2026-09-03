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

import { CricketDataClient } from "./cricketdata-client";
import {
  type CricketDataSnapshotInput,
  mapSnapshot,
  type MappedCricketData,
  seriesFromInfo,
} from "./cricketdata-mapper";
import {
  CricketDataMatch,
  CricketDataSeries,
  CricketDataSeriesInfo,
  parseOne,
  parseRows,
} from "./cricketdata-schemas";

/**
 * CricketData as a canonical cricket provider.
 *
 * Reads only: one bounded discovery cycle is fetched, mapped, memoized for a TTL,
 * and shared by `getCompetitions`, `getEvents` and `getParticipants`. Nothing here
 * touches the database, and nothing here decides what to persist.
 *
 * The budget matters more than it does for Lichess. The free plan allows 100
 * requests per DAY, not per minute, so a cycle is capped at `maxRequests` (8 in
 * the default plan: 2 recovery + 1 live page + 2 fixture pages + 1 series page +
 * 2 series lookups). That affords roughly a dozen cycles a day — whatever ends up
 * scheduling this must be sized against that, not against the 5-minute TTL.
 *
 * Failure handling follows the Lichess convention: the one call the cycle cannot
 * do without — the live feed — propagates its error, so the aggregator skips this
 * provider and nothing is written; every supplementary call is best-effort and a
 * failure just yields less data.
 */

const DEFAULT_CURRENT_PAGES = 1;
const DEFAULT_FIXTURE_PAGES = 2;
const DEFAULT_SERIES_PAGES = 1;
const DEFAULT_MAX_SERIES = 25;
const DEFAULT_MAX_MATCHES = 150;
const DEFAULT_MAX_REQUESTS = 8;
const DEFAULT_SNAPSHOT_TTL_MS = 5 * 60 * 1000;

/** v1 pages every list endpoint 25 rows at a time, addressed by row offset. */
const PAGE_SIZE = 25;

/** CricketData ids are UUIDs. Anything else was not written by this provider. */
const CRICKETDATA_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const EMPTY: MappedCricketData = {
  competitions: [],
  events: [],
  participants: [],
};

export interface CricketDataProviderOptions {
  client?: CricketDataClient;
  /** `/currentMatches` pages — the live and in-progress feed. */
  currentPages?: number;
  /** `/matches` pages — the fixture list. */
  fixturePages?: number;
  /** `/series` pages — competition discovery. */
  seriesPages?: number;
  maxSeries?: number;
  maxMatches?: number;
  /** Hard ceiling on requests per cycle, guarding the daily quota. */
  maxRequests?: number;
  snapshotTtlMs?: number;
  now?: () => Date;
}

function matchesCountry(relevant: string[], country?: string): boolean {
  if (country === undefined) return true;
  return relevant.includes(country.toUpperCase());
}

/**
 * `participantRefs` as a case-insensitive name set, or null when unconstrained.
 *
 * CricketData has no team-search endpoint, so this can only ever narrow what a
 * cycle already fetched — it never becomes a request. Team names are the provider's
 * only native team handle, so they are what a ref is matched against.
 */
function nameFilter(refs: readonly string[] | undefined): Set<string> | null {
  if (refs === undefined || refs.length === 0) return null;
  const names = new Set<string>();
  for (const ref of refs) {
    const name = ref.replace(/\s+/g, " ").trim().toUpperCase();
    if (name !== "") names.add(name);
  }
  return names.size === 0 ? null : names;
}

/** Series ids a match points at that the series index did not already cover. */
function referencedSeriesIds(
  matches: readonly CricketDataMatch[],
  known: ReadonlySet<string>,
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const match of matches) {
    const id = match.series_id?.trim() ?? "";
    if (id === "" || known.has(id) || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/** A quarter of the cycle's budget, the same share Lichess gives recovery. */
export function quarterAllowance(maxRequests: number): number {
  return Math.max(0, Math.floor(Math.max(0, maxRequests) / 4));
}

/**
 * The distinct match ids worth re-reading, bounded.
 *
 * Cricket ingestion writes a match's ref as the provider's own UUID, so a stored
 * ref is directly re-fetchable through `/match_info`. A ref this provider could
 * not have written is skipped rather than turned into a request.
 */
export function recoveryMatchIds(
  refs: readonly string[] | undefined,
  max: number,
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const ceiling = Math.max(0, max);
  for (const ref of refs ?? []) {
    if (ids.length >= ceiling) break;
    const id = ref.trim();
    if (!CRICKETDATA_ID.test(id)) continue;
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    ids.push(id);
  }
  return ids;
}

interface Snapshot {
  key: string;
  takenAt: number;
  data: MappedCricketData;
}

interface CycleLimits {
  maxSeries: number;
  maxMatches: number;
}

export class CricketDataProvider implements SportProvider {
  readonly id = "cricketdata";
  readonly sport: SportKey = "cricket";
  readonly capabilities: ProviderCapabilities = {
    liveEvents: true,
    upcomingEvents: true,
    recentEvents: true,
    tournamentDiscovery: true,
    participants: true,
  };

  private readonly client: CricketDataClient;
  private readonly currentPages: number;
  private readonly fixturePages: number;
  private readonly seriesPages: number;
  private readonly maxSeries: number;
  private readonly maxMatches: number;
  private readonly maxRequests: number;
  private readonly snapshotTtlMs: number;
  private readonly now: () => Date;

  private snapshot: Snapshot | null = null;
  private inflight: Promise<Snapshot> | null = null;
  private lastError: string | null = null;
  private lastErrorAt = 0;

  constructor(options: CricketDataProviderOptions = {}) {
    this.client = options.client ?? new CricketDataClient();
    this.currentPages = options.currentPages ?? DEFAULT_CURRENT_PAGES;
    this.fixturePages = options.fixturePages ?? DEFAULT_FIXTURE_PAGES;
    this.seriesPages = options.seriesPages ?? DEFAULT_SERIES_PAGES;
    this.maxSeries = options.maxSeries ?? DEFAULT_MAX_SERIES;
    this.maxMatches = options.maxMatches ?? DEFAULT_MAX_MATCHES;
    this.maxRequests = options.maxRequests ?? DEFAULT_MAX_REQUESTS;
    this.snapshotTtlMs = options.snapshotTtlMs ?? DEFAULT_SNAPSHOT_TTL_MS;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Reports the last real outcome; it never spends a request of its own.
   *
   * A missing key fails here, before any socket is opened, which is what lets the
   * aggregator skip this provider entirely. A transient failure only suppresses it
   * for one TTL, so a blip cannot take cricket offline for the life of the process.
   */
  async health(): Promise<ProviderHealth> {
    const checkedAt = this.now();
    if (!this.client.configured) {
      return {
        ok: false,
        checkedAt,
        detail: "CRICKETDATA_API_KEY is not configured",
      };
    }
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
    const { competitions } = await this.snapshotFor(query);
    return competitions.filter((competition) =>
      matchesCountry(competition.relevantCountryIso2, query.country),
    );
  }

  async getEvents(query: ProviderQuery = {}): Promise<Event[]> {
    const { events } = await this.snapshotFor(query);
    let filtered = events;
    if (query.country !== undefined) {
      filtered = filtered.filter((event) =>
        matchesCountry(event.relevantCountryIso2, query.country),
      );
    }
    const refs = nameFilter(query.participantRefs);
    if (refs !== null) {
      filtered = filtered.filter((event) =>
        event.participants.some((side) =>
          refs.has(side.participantName.toUpperCase()),
        ),
      );
    }
    const wanted = query.status;
    if (wanted !== undefined && wanted.length > 0) {
      filtered = filtered.filter((event) => wanted.includes(event.status));
    }
    const since = query.since;
    if (since !== undefined) {
      filtered = filtered.filter(
        (event) => event.startTime !== null && event.startTime >= since,
      );
    }
    const until = query.until;
    if (until !== undefined) {
      filtered = filtered.filter(
        (event) => event.startTime !== null && event.startTime <= until,
      );
    }
    return filtered;
  }

  async getParticipants(query: ProviderQuery = {}): Promise<Participant[]> {
    const { participants } = await this.snapshotFor(query);
    const country = query.country?.toUpperCase();
    const refs = nameFilter(query.participantRefs);
    const byName = new Map<string, Participant>();
    for (const participant of participants) {
      if (country !== undefined && participant.countryIso2 !== country) continue;
      if (refs !== null && !refs.has(participant.name.toUpperCase())) continue;
      const key = participant.name.toLowerCase();
      if (!byName.has(key)) byName.set(key, participant);
    }
    return [...byName.values()];
  }

  // --- Snapshot -------------------------------------------------------------

  /**
   * One bounded cycle, shared by all three read methods for the TTL window.
   *
   * With no key this resolves empty without opening a connection, so a direct
   * caller that skipped `health()` still cannot spend a request or write a row.
   */
  private async snapshotFor(query: ProviderQuery): Promise<MappedCricketData> {
    if (!this.client.configured) return EMPTY;

    const limits: CycleLimits = {
      maxSeries: query.limit ?? this.maxSeries,
      maxMatches: this.maxMatches,
    };
    // Only this provider's own refs, and only as many as recovery may spend, so
    // these ids are exactly the requests the pass will make.
    const recoveryIds = recoveryMatchIds(
      query.refreshRefs?.[this.id],
      quarterAllowance(this.maxRequests),
    );
    const key = [
      this.currentPages,
      this.fixturePages,
      this.seriesPages,
      limits.maxSeries,
      limits.maxMatches,
      this.maxRequests,
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
      return cached.data;
    }

    const pending = this.inflight;
    if (pending !== null) {
      const settled = await pending;
      if (settled.key === key) return settled.data;
    }

    const run = this.fetchSnapshot(key, limits, recoveryIds);
    this.inflight = run;
    try {
      const result = await run;
      this.snapshot = result;
      this.lastError = null;
      return result.data;
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

  /**
   * The cycle itself, in priority order.
   *
   * Matches are de-duplicated by provider id and the FIRST sighting wins, which is
   * why the order below is not arbitrary: `/match_info` and `/currentMatches`
   * carry `score`, while `/matches` and `/series_info` do not. Reading the fixture
   * list first would overwrite live scores with score-less copies.
   */
  private async fetchSnapshot(
    key: string,
    limits: CycleLimits,
    recoveryIds: readonly string[],
  ): Promise<Snapshot> {
    // Stamped before the first request so every record in this cycle shares one
    // fetch time, whatever order the calls complete in.
    const fetchedAt = this.now();
    if (this.client.hitsRemaining === 0) {
      throw new Error("CricketData daily request quota is exhausted");
    }

    const matches: CricketDataMatch[] = [];
    const seenMatches = new Set<string>();
    const series: CricketDataSeries[] = [];
    const seenSeries = new Set<string>();
    const seriesIdByMatchId: Record<string, string> = {};

    let spent = 0;
    /** Budget gate: the per-cycle ceiling, and the provider's own daily count. */
    const canSpend = (): boolean =>
      spent < this.maxRequests && this.client.hitsRemaining !== 0;

    const addMatch = (match: CricketDataMatch): void => {
      if (seenMatches.has(match.id)) return;
      if (matches.length >= limits.maxMatches) return;
      seenMatches.add(match.id);
      matches.push(match);
    };
    const addSeries = (entry: CricketDataSeries): void => {
      if (seenSeries.has(entry.id)) return;
      if (series.length >= limits.maxSeries) return;
      seenSeries.add(entry.id);
      series.push(entry);
    };

    // 1. Heal rows we already stored: a ref re-read directly is the freshest and
    //    richest view of a match, so it goes in before any listing.
    for (const id of recoveryIds) {
      if (!canSpend()) break;
      spent += 1;
      try {
        const { data } = await this.client.matchInfo(id);
        const match = parseOne(CricketDataMatch, data);
        if (match !== null) addMatch(match);
      } catch {
        // A ref we can no longer read must not cost the rest of the cycle.
      }
    }

    // 2. The live feed. The one call the cycle cannot do without, so its failure
    //    propagates and the whole provider is skipped rather than half-reported.
    for (let page = 0; page < this.currentPages; page += 1) {
      if (page > 0 && !canSpend()) break;
      spent += 1;
      const { data } = await this.client.currentMatches(page * PAGE_SIZE);
      const rows = parseRows(CricketDataMatch, data);
      for (const match of rows) addMatch(match);
      if (rows.length < PAGE_SIZE) break;
    }

    // 3. Fixtures and recent results. Best-effort from here down.
    for (let page = 0; page < this.fixturePages; page += 1) {
      if (!canSpend()) break;
      spent += 1;
      try {
        const { data } = await this.client.matches(page * PAGE_SIZE);
        const rows = parseRows(CricketDataMatch, data);
        for (const match of rows) addMatch(match);
        if (rows.length < PAGE_SIZE) break;
      } catch {
        // The live feed already succeeded; proceed with what we have.
        break;
      }
    }

    // 4. Competition discovery, which is also what names a match's series.
    for (let page = 0; page < this.seriesPages; page += 1) {
      if (!canSpend()) break;
      spent += 1;
      try {
        const { data } = await this.client.series(page * PAGE_SIZE);
        const rows = parseRows(CricketDataSeries, data);
        for (const entry of rows) addSeries(entry);
        if (rows.length < PAGE_SIZE) break;
      } catch {
        // Events keep their own data; only `competitionName` goes unresolved.
        break;
      }
    }

    // 5. Series referenced by a match but absent from the index above. Bounded to
    //    a quarter of the cycle, so a busy day cannot turn this into 40 requests.
    let lookups = quarterAllowance(this.maxRequests);
    for (const id of referencedSeriesIds(matches, seenSeries)) {
      if (lookups <= 0 || !canSpend()) break;
      lookups -= 1;
      spent += 1;
      try {
        const { data } = await this.client.seriesInfo(id);
        const info = parseOne(CricketDataSeriesInfo, data);
        if (info === null) continue;
        addSeries(seriesFromInfo(info.info));
        for (const match of info.matchList ?? []) {
          // These entries carry no `series_id`, so record where they came from.
          seriesIdByMatchId[match.id] = info.info.id;
          addMatch(match);
        }
      } catch {
        // One unresolvable series must not cost the others, or the snapshot.
      }
    }

    const input: CricketDataSnapshotInput = {
      series,
      matches,
      seriesIdByMatchId,
      fetchedAt,
    };
    return {
      key,
      takenAt: Date.now(),
      data: mapSnapshot(input, fetchedAt),
    };
  }
}
