import type {
  Competition,
  Event,
  Participant,
  SportKey,
} from "@/core/models/canonical";

/**
 * The provider abstraction. Every external data source implements
 * `SportProvider` for exactly one sport. Adapters own all provider-specific
 * concerns (HTTP, auth, rate limiting, caching, field mapping) and return ONLY
 * canonical model objects. The rest of the app depends on this interface —
 * never on a concrete provider.
 */

/** What a provider can actually do. Declared, never assumed. */
export interface ProviderCapabilities {
  liveEvents: boolean;
  upcomingEvents: boolean;
  recentEvents: boolean;
  /** Can list tournaments/competitions without knowing an id in advance. */
  tournamentDiscovery: boolean;
  participants: boolean;
}

export interface ProviderHealth {
  ok: boolean;
  checkedAt: Date;
  detail?: string;
}

/** Query passed to providers. All fields optional; providers ignore unknowns. */
export interface ProviderQuery {
  /** ISO 3166-1 alpha-2, e.g. "IN". */
  country?: string;
  status?: Event["status"][];
  since?: Date;
  until?: Date;
  /** Provider-native handles/ids to scope to (e.g. curated GM usernames). */
  participantRefs?: string[];
}

export interface SportProvider {
  readonly id: string; // e.g. "thesportsdb", "lichess", "chesscom"
  readonly sport: SportKey;
  readonly capabilities: ProviderCapabilities;

  /** Ongoing + upcoming + recent competitions/tournaments. */
  getCompetitions(query: ProviderQuery): Promise<Competition[]>;

  /** Live / upcoming / recent events (matches, games, rounds). */
  getEvents(query: ProviderQuery): Promise<Event[]>;

  /** Teams / players (e.g. national teams, GMs). */
  getParticipants(query: ProviderQuery): Promise<Participant[]>;

  /** Liveness/credential check used by the aggregator to skip dead providers. */
  health(): Promise<ProviderHealth>;
}

/**
 * Convenience base for adapters: declares zero capabilities and returns empty
 * results, so a stub only needs to override what it actually supports. No
 * network calls happen here.
 */
export abstract class BaseSportProvider implements SportProvider {
  abstract readonly id: string;
  abstract readonly sport: SportKey;
  readonly capabilities: ProviderCapabilities = {
    liveEvents: false,
    upcomingEvents: false,
    recentEvents: false,
    tournamentDiscovery: false,
    participants: false,
  };

  async getCompetitions(_query: ProviderQuery): Promise<Competition[]> {
    return [];
  }

  async getEvents(_query: ProviderQuery): Promise<Event[]> {
    return [];
  }

  async getParticipants(_query: ProviderQuery): Promise<Participant[]> {
    return [];
  }

  async health(): Promise<ProviderHealth> {
    return { ok: true, checkedAt: new Date(), detail: "stub" };
  }
}
