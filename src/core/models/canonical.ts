import { z } from "zod";

/**
 * Canonical, provider-agnostic domain model for 22scores.
 *
 * Every provider adapter normalizes its raw payloads into these shapes before
 * anything else in the system sees them. The web app and database read ONLY
 * these types — never a provider's native format. This is what lets us swap or
 * combine providers per sport without touching the UI.
 */

// --- Enums ------------------------------------------------------------------

export const SportKey = z.enum(["cricket", "chess"]);
export type SportKey = z.infer<typeof SportKey>;

export const ParticipantType = z.enum(["team", "player"]);
export type ParticipantType = z.infer<typeof ParticipantType>;

export const CompetitionKind = z.enum(["league", "series", "tournament"]);
export type CompetitionKind = z.infer<typeof CompetitionKind>;

export const CompetitionStatus = z.enum(["upcoming", "ongoing", "finished"]);
export type CompetitionStatus = z.infer<typeof CompetitionStatus>;

export const EventKind = z.enum(["match", "game", "round"]);
export type EventKind = z.infer<typeof EventKind>;

export const EventStatus = z.enum(["live", "upcoming", "recent", "finished"]);
export type EventStatus = z.infer<typeof EventStatus>;

// --- Provenance -------------------------------------------------------------

/** Where a canonical record came from. Multiple sources may back one record. */
export const SourceRef = z.object({
  provider: z.string(), // e.g. "thesportsdb", "lichess", "chesscom"
  providerRef: z.string(), // the provider's own id/slug for this entity
  fetchedAt: z.coerce.date(),
  url: z.string().url().optional(),
});
export type SourceRef = z.infer<typeof SourceRef>;

// --- Core entities ----------------------------------------------------------

export const Country = z.object({
  iso2: z.string().length(2), // ISO 3166-1 alpha-2, uppercase, e.g. "IN"
  name: z.string(),
});
export type Country = z.infer<typeof Country>;

export const Participant = z.object({
  sport: SportKey,
  type: ParticipantType,
  name: z.string(),
  /** Country a participant represents (ISO2). Best-effort; may be null. */
  countryIso2: z.string().length(2).nullable().default(null),
  /** e.g. "GM" for chess. */
  title: z.string().nullable().default(null),
  sources: z.array(SourceRef).default([]),
});
export type Participant = z.infer<typeof Participant>;

/** A participant entered in a competition (e.g. an Indian GM in a tournament). */
export const CompetitionParticipant = z.object({
  participantName: z.string(),
  countryIso2: z.string().length(2).nullable().default(null),
  title: z.string().nullable().default(null),
  status: z.string().nullable().default(null), // "entered"|"active"|"withdrawn"
  finalRank: z.number().int().nullable().default(null),
});
export type CompetitionParticipant = z.infer<typeof CompetitionParticipant>;

export const Competition = z.object({
  sport: SportKey,
  name: z.string(),
  kind: CompetitionKind,
  status: CompetitionStatus,
  startDate: z.coerce.date().nullable().default(null),
  endDate: z.coerce.date().nullable().default(null),
  hostCountryIso2: z.string().length(2).nullable().default(null),
  /** Entrants (e.g. Indian GMs) — known before any games exist. */
  participants: z.array(CompetitionParticipant).default([]),
  /** Countries this competition is relevant to (country-first index). */
  relevantCountryIso2: z.array(z.string().length(2)).default([]),
  sources: z.array(SourceRef).default([]),
});
export type Competition = z.infer<typeof Competition>;

/** One side of an event (a team or a player) with its score/result. */
export const EventParticipant = z.object({
  participantName: z.string(),
  countryIso2: z.string().length(2).nullable().default(null),
  /** Sport-specific role, e.g. "home"|"away"|"white"|"black". */
  role: z.string().nullable().default(null),
  score: z.string().nullable().default(null),
  result: z.string().nullable().default(null),
  /** Finishing place for sports with more than two participants. */
  position: z.number().int().nullable().default(null),
});
export type EventParticipant = z.infer<typeof EventParticipant>;

export const Event = z.object({
  sport: SportKey,
  kind: EventKind,
  status: EventStatus,
  competitionName: z.string().nullable().default(null),
  startTime: z.coerce.date().nullable().default(null),
  /** All sides. Two for cricket/chess; more for future N-participant sports. */
  participants: z.array(EventParticipant).default([]),
  /** Match-level summary, e.g. "India won by 96 runs". */
  result: z.string().nullable().default(null),
  venueCountryIso2: z.string().length(2).nullable().default(null),
  /** Countries this event is relevant to (country-first index). */
  relevantCountryIso2: z.array(z.string().length(2)).default([]),
  sources: z.array(SourceRef).default([]),
});
export type Event = z.infer<typeof Event>;
