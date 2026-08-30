import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Canonical, provider-agnostic schema for 22scores.
 *
 * Mirrors src/core/models/canonical.ts. Country-first discovery is served by
 * the *_relevant_countries join tables, which are the primary query index.
 * Provenance for every row lives in its `sources` JSONB column so a single
 * canonical record can be backed by multiple providers.
 */

// --- Enums ------------------------------------------------------------------

export const sportKey = pgEnum("sport_key", ["cricket", "chess"]);
export const participantType = pgEnum("participant_type", ["team", "player"]);
export const competitionKind = pgEnum("competition_kind", [
  "league",
  "series",
  "tournament",
]);
export const competitionStatus = pgEnum("competition_status", [
  "upcoming",
  "ongoing",
  "finished",
]);
export const eventKind = pgEnum("event_kind", ["match", "game", "round"]);
export const eventStatus = pgEnum("event_status", [
  "live",
  "upcoming",
  "recent",
  "finished",
]);

// A source reference stored inside JSONB `sources` arrays.
export type SourceRefRow = {
  provider: string;
  providerRef: string;
  fetchedAt: string;
  url?: string;
};

// --- Reference tables -------------------------------------------------------

export const countries = pgTable("countries", {
  id: uuid("id").primaryKey().defaultRandom(),
  iso2: text("iso2").notNull().unique(), // ISO 3166-1 alpha-2, uppercase
  name: text("name").notNull(),
});

export const sports = pgTable("sports", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: sportKey("key").notNull().unique(),
  name: text("name").notNull(),
});

// --- Participants (teams / players) ----------------------------------------

export const participants = pgTable(
  "participants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sport: sportKey("sport").notNull(),
    type: participantType("type").notNull(),
    name: text("name").notNull(),
    countryId: uuid("country_id").references(() => countries.id),
    title: text("title"), // e.g. "GM" for chess
    sources: jsonb("sources").$type<SourceRefRow[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("participants_sport_name_uq").on(t.sport, t.name),
    index("participants_country_idx").on(t.countryId),
  ],
);

// --- Competitions -----------------------------------------------------------

export const competitions = pgTable(
  "competitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sport: sportKey("sport").notNull(),
    name: text("name").notNull(),
    kind: competitionKind("kind").notNull(),
    status: competitionStatus("status").notNull(),
    startDate: timestamp("start_date", { withTimezone: true }),
    endDate: timestamp("end_date", { withTimezone: true }),
    hostCountryId: uuid("host_country_id").references(() => countries.id),
    sources: jsonb("sources").$type<SourceRefRow[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("competitions_sport_name_uq").on(t.sport, t.name),
    index("competitions_status_idx").on(t.status),
  ],
);

// --- Events (matches / games / rounds) -------------------------------------

export const events = pgTable(
  "events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sport: sportKey("sport").notNull(),
    kind: eventKind("kind").notNull(),
    status: eventStatus("status").notNull(),
    competitionId: uuid("competition_id").references(() => competitions.id),
    startTime: timestamp("start_time", { withTimezone: true }),
    // Individual sides live in `event_participants`. `result` remains here as a
    // match-level summary (e.g. "India won by 96 runs").
    result: text("result"),
    venueCountryId: uuid("venue_country_id").references(() => countries.id),
    sources: jsonb("sources").$type<SourceRefRow[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("events_sport_status_idx").on(t.sport, t.status),
    index("events_start_time_idx").on(t.startTime),
    index("events_competition_idx").on(t.competitionId),
  ],
);

// --- Event participants (N-ary: replaces home/away) ------------------------

export const eventParticipants = pgTable(
  "event_participants",
  {
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    participantId: uuid("participant_id")
      .notNull()
      .references(() => participants.id),
    // Sport-specific side/role, e.g. "home"|"away"|"white"|"black". Nullable
    // for sports with no meaningful side (e.g. a race field).
    role: text("role"),
    score: text("score"), // per-participant score
    result: text("result"), // per-participant: "win"|"loss"|"draw"|...
    position: integer("position"), // finishing place for >2-participant sports
  },
  (t) => [
    primaryKey({ columns: [t.eventId, t.participantId] }),
    index("event_participants_participant_idx").on(t.participantId),
  ],
);

// --- Competition participants (tournament entry, before games exist) -------

export const competitionParticipants = pgTable(
  "competition_participants",
  {
    competitionId: uuid("competition_id")
      .notNull()
      .references(() => competitions.id, { onDelete: "cascade" }),
    participantId: uuid("participant_id")
      .notNull()
      .references(() => participants.id),
    status: text("status"), // "entered"|"active"|"withdrawn"|...
    finalRank: integer("final_rank"), // nullable until known
  },
  (t) => [
    primaryKey({ columns: [t.competitionId, t.participantId] }),
    index("competition_participants_participant_idx").on(t.participantId),
  ],
);

// --- Country-first relevance (join tables) ---------------------------------

export const eventRelevantCountries = pgTable(
  "event_relevant_countries",
  {
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    countryId: uuid("country_id")
      .notNull()
      .references(() => countries.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.eventId, t.countryId] }),
    index("event_relevant_country_idx").on(t.countryId),
  ],
);

export const competitionRelevantCountries = pgTable(
  "competition_relevant_countries",
  {
    competitionId: uuid("competition_id")
      .notNull()
      .references(() => competitions.id, { onDelete: "cascade" }),
    countryId: uuid("country_id")
      .notNull()
      .references(() => countries.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.competitionId, t.countryId] }),
    index("competition_relevant_country_idx").on(t.countryId),
  ],
);
