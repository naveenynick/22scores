import { and, desc, eq, inArray } from "drizzle-orm";

import type { SportKey } from "@/core/models/canonical";
import { schema } from "@/lib/db";
import type { Db } from "@/core/ingest/persist";

/**
 * Country-first reads over the canonical model.
 *
 * These go through the *_relevant_countries join tables, which is the index the
 * product is built around ("what is my country involved in right now?"). Read
 * only — no provider calls ever happen on this path.
 */

export interface RelevantCompetition {
  id: string;
  name: string;
  status: "upcoming" | "ongoing" | "finished";
  startDate: Date | null;
  endDate: Date | null;
  entrants: { name: string; title: string | null; countryIso2: string | null }[];
}

export async function getRelevantCompetitions(
  db: Db,
  sport: SportKey,
  iso2: string,
): Promise<RelevantCompetition[]> {
  const rows = await db
    .select({
      id: schema.competitions.id,
      name: schema.competitions.name,
      status: schema.competitions.status,
      startDate: schema.competitions.startDate,
      endDate: schema.competitions.endDate,
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
      schema.countries,
      eq(schema.countries.id, schema.competitionRelevantCountries.countryId),
    )
    .where(
      and(
        eq(schema.competitions.sport, sport),
        eq(schema.countries.iso2, iso2.toUpperCase()),
      ),
    )
    .orderBy(desc(schema.competitions.startDate));

  if (rows.length === 0) return [];

  // Entrants from that country only — this is what "Indian GMs in it" means.
  const entrants = await db
    .select({
      competitionId: schema.competitionParticipants.competitionId,
      name: schema.participants.name,
      title: schema.participants.title,
      iso2: schema.countries.iso2,
    })
    .from(schema.competitionParticipants)
    .innerJoin(
      schema.participants,
      eq(schema.participants.id, schema.competitionParticipants.participantId),
    )
    .innerJoin(
      schema.countries,
      eq(schema.countries.id, schema.participants.countryId),
    )
    .where(
      and(
        inArray(
          schema.competitionParticipants.competitionId,
          rows.map((r) => r.id),
        ),
        eq(schema.countries.iso2, iso2.toUpperCase()),
      ),
    );

  return rows.map((row) => ({
    ...row,
    entrants: entrants
      .filter((e) => e.competitionId === row.id)
      .map((e) => ({ name: e.name, title: e.title, countryIso2: e.iso2 })),
  }));
}

export interface RelevantEvent {
  id: string;
  kind: "match" | "game" | "round";
  status: "live" | "upcoming" | "recent" | "finished";
  startTime: Date | null;
  result: string | null;
  competitionName: string | null;
  sides: {
    name: string;
    title: string | null;
    role: string | null;
    result: string | null;
  }[];
}

export async function getRelevantEvents(
  db: Db,
  sport: SportKey,
  iso2: string,
  limit = 25,
): Promise<RelevantEvent[]> {
  const rows = await db
    .select({
      id: schema.events.id,
      kind: schema.events.kind,
      status: schema.events.status,
      startTime: schema.events.startTime,
      result: schema.events.result,
      competitionName: schema.competitions.name,
    })
    .from(schema.events)
    .innerJoin(
      schema.eventRelevantCountries,
      eq(schema.eventRelevantCountries.eventId, schema.events.id),
    )
    .innerJoin(
      schema.countries,
      eq(schema.countries.id, schema.eventRelevantCountries.countryId),
    )
    .leftJoin(
      schema.competitions,
      eq(schema.competitions.id, schema.events.competitionId),
    )
    .where(
      and(
        eq(schema.events.sport, sport),
        eq(schema.countries.iso2, iso2.toUpperCase()),
      ),
    )
    .orderBy(desc(schema.events.startTime))
    .limit(limit);

  if (rows.length === 0) return [];

  const sides = await db
    .select({
      eventId: schema.eventParticipants.eventId,
      name: schema.participants.name,
      title: schema.participants.title,
      role: schema.eventParticipants.role,
      result: schema.eventParticipants.result,
    })
    .from(schema.eventParticipants)
    .innerJoin(
      schema.participants,
      eq(schema.participants.id, schema.eventParticipants.participantId),
    )
    .where(
      inArray(
        schema.eventParticipants.eventId,
        rows.map((r) => r.id),
      ),
    );

  return rows.map((row) => ({
    ...row,
    sides: sides
      .filter((s) => s.eventId === row.id)
      .map(({ name, title, role, result }) => ({ name, title, role, result })),
  }));
}
