import { and, eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import type {
  Competition,
  Event,
  Participant,
  SourceRef,
  SportKey,
} from "@/core/models/canonical";
import { schema } from "@/lib/db";
import type { SourceRefRow } from "@/lib/db/schema";

/**
 * Idempotent persistence of canonical records.
 *
 * Guarantees relied on elsewhere:
 *  - repeated syncs update in place instead of inserting duplicates,
 *  - nothing is ever deleted, so a provider outage cannot destroy data,
 *  - known values are never overwritten with nulls (gaps get filled, not made),
 *  - provenance accumulates, so several providers can back one row.
 *
 * `events` has no natural unique key, so identity is JSONB containment on
 * `sources` — the (provider, providerRef) pair the provider assigned.
 */

export type Db = PostgresJsDatabase<typeof schema>;

export interface PersistSummary {
  countriesInserted: number;
  participantsInserted: number;
  participantsUpdated: number;
  competitionsInserted: number;
  competitionsUpdated: number;
  competitionParticipantRows: number;
  eventsInserted: number;
  eventsUpdated: number;
  eventParticipantRows: number;
  relevanceRows: number;
}

function emptySummary(): PersistSummary {
  return {
    countriesInserted: 0,
    participantsInserted: 0,
    participantsUpdated: 0,
    competitionsInserted: 0,
    competitionsUpdated: 0,
    competitionParticipantRows: 0,
    eventsInserted: 0,
    eventsUpdated: 0,
    eventParticipantRows: 0,
    relevanceRows: 0,
  };
}

// --- Provenance -------------------------------------------------------------

export function toSourceRows(sources: SourceRef[]): SourceRefRow[] {
  return sources.map((s) => ({
    provider: s.provider,
    providerRef: s.providerRef,
    fetchedAt: s.fetchedAt.toISOString(),
    ...(s.url === undefined ? {} : { url: s.url }),
  }));
}

/** Union by (provider, providerRef); the newer sighting wins. */
export function mergeSources(
  existing: SourceRefRow[] | null,
  incoming: SourceRefRow[],
): SourceRefRow[] {
  const byRef = new Map<string, SourceRefRow>();
  for (const row of existing ?? []) {
    byRef.set(`${row.provider}/${row.providerRef}`, row);
  }
  for (const row of incoming) {
    byRef.set(`${row.provider}/${row.providerRef}`, row);
  }
  return [...byRef.values()];
}

// --- Countries --------------------------------------------------------------

/** ISO2 -> display name for the countries we actually reference today. */
const COUNTRY_NAMES: Record<string, string> = { IN: "India" };

class CountryCache {
  private readonly ids = new Map<string, string>();

  constructor(
    private readonly db: Db,
    private readonly summary: PersistSummary,
  ) {}

  async idFor(iso2: string | null): Promise<string | null> {
    if (iso2 === null) return null;
    const code = iso2.toUpperCase();
    const cached = this.ids.get(code);
    if (cached !== undefined) return cached;

    const inserted = await this.db
      .insert(schema.countries)
      .values({ iso2: code, name: COUNTRY_NAMES[code] ?? code })
      .onConflictDoNothing({ target: schema.countries.iso2 })
      .returning({ id: schema.countries.id });

    const first = inserted[0];
    if (first !== undefined) {
      this.summary.countriesInserted += 1;
      this.ids.set(code, first.id);
      return first.id;
    }

    const found = await this.db
      .select({ id: schema.countries.id })
      .from(schema.countries)
      .where(eq(schema.countries.iso2, code))
      .limit(1);
    const row = found[0];
    if (row === undefined) return null;
    this.ids.set(code, row.id);
    return row.id;
  }
}

// --- Persister --------------------------------------------------------------

/** Chess entrants are people; cricket entrants are teams. */
function defaultParticipantType(sport: SportKey): "player" | "team" {
  return sport === "chess" ? "player" : "team";
}

export interface CanonicalBatch {
  participants?: Participant[];
  competitions?: Competition[];
  events?: Event[];
}

interface ParticipantInput {
  sport: SportKey;
  name: string;
  countryIso2: string | null;
  title: string | null;
  sources: SourceRefRow[];
}

class Persister {
  private readonly countries: CountryCache;
  private readonly participantIds = new Map<string, string>();
  private readonly competitionIds = new Map<string, string | null>();

  constructor(
    private readonly db: Db,
    private readonly summary: PersistSummary,
  ) {
    this.countries = new CountryCache(db, summary);
  }

  async run(batch: CanonicalBatch): Promise<void> {
    for (const participant of batch.participants ?? []) {
      await this.participantId({
        sport: participant.sport,
        name: participant.name,
        countryIso2: participant.countryIso2,
        title: participant.title,
        sources: toSourceRows(participant.sources),
      });
    }
    for (const competition of batch.competitions ?? []) {
      await this.upsertCompetition(competition);
    }
    for (const event of batch.events ?? []) {
      await this.upsertEvent(event);
    }
  }

  /** Unique on (sport, name): fill gaps, accept corrections, keep provenance. */
  private async participantId(input: ParticipantInput): Promise<string> {
    const key = `${input.sport}:${input.name.toLowerCase()}`;
    const cached = this.participantIds.get(key);
    if (cached !== undefined) return cached;

    const countryId = await this.countries.idFor(input.countryIso2);
    const found = await this.db
      .select()
      .from(schema.participants)
      .where(
        and(
          eq(schema.participants.sport, input.sport),
          eq(schema.participants.name, input.name),
        ),
      )
      .limit(1);
    const existing = found[0];

    if (existing !== undefined) {
      await this.db
        .update(schema.participants)
        .set({
          title: input.title ?? existing.title,
          countryId: countryId ?? existing.countryId,
          sources: mergeSources(existing.sources, input.sources),
          updatedAt: new Date(),
        })
        .where(eq(schema.participants.id, existing.id));
      this.summary.participantsUpdated += 1;
      this.participantIds.set(key, existing.id);
      return existing.id;
    }

    const inserted = await this.db
      .insert(schema.participants)
      .values({
        sport: input.sport,
        type: defaultParticipantType(input.sport),
        name: input.name,
        countryId,
        title: input.title,
        sources: input.sources,
      })
      .onConflictDoUpdate({
        target: [schema.participants.sport, schema.participants.name],
        set: { updatedAt: new Date() },
      })
      .returning({ id: schema.participants.id });

    const row = inserted[0];
    if (row === undefined) {
      throw new Error(`Failed to upsert participant "${input.name}"`);
    }
    this.summary.participantsInserted += 1;
    this.participantIds.set(key, row.id);
    return row.id;
  }

  private async addCompetitionRelevance(
    competitionId: string,
    isoCodes: string[],
  ): Promise<void> {
    for (const iso2 of isoCodes) {
      const countryId = await this.countries.idFor(iso2);
      if (countryId === null) continue;
      await this.db
        .insert(schema.competitionRelevantCountries)
        .values({ competitionId, countryId })
        .onConflictDoNothing();
      this.summary.relevanceRows += 1;
    }
  }

  private async upsertCompetition(competition: Competition): Promise<string> {
    const incoming = toSourceRows(competition.sources);
    const hostCountryId = await this.countries.idFor(
      competition.hostCountryIso2,
    );
    const found = await this.db
      .select()
      .from(schema.competitions)
      .where(
        and(
          eq(schema.competitions.sport, competition.sport),
          eq(schema.competitions.name, competition.name),
        ),
      )
      .limit(1);
    const existing = found[0];

    let competitionId: string;
    if (existing !== undefined) {
      await this.db
        .update(schema.competitions)
        .set({
          kind: competition.kind,
          // Status legitimately changes over time, so it is authoritative.
          status: competition.status,
          startDate: competition.startDate ?? existing.startDate,
          endDate: competition.endDate ?? existing.endDate,
          hostCountryId: hostCountryId ?? existing.hostCountryId,
          sources: mergeSources(existing.sources, incoming),
          updatedAt: new Date(),
        })
        .where(eq(schema.competitions.id, existing.id));
      this.summary.competitionsUpdated += 1;
      competitionId = existing.id;
    } else {
      const inserted = await this.db
        .insert(schema.competitions)
        .values({
          sport: competition.sport,
          name: competition.name,
          kind: competition.kind,
          status: competition.status,
          startDate: competition.startDate,
          endDate: competition.endDate,
          hostCountryId,
          sources: incoming,
        })
        .onConflictDoUpdate({
          target: [schema.competitions.sport, schema.competitions.name],
          set: { updatedAt: new Date() },
        })
        .returning({ id: schema.competitions.id });
      const row = inserted[0];
      if (row === undefined) {
        throw new Error(`Failed to upsert competition "${competition.name}"`);
      }
      this.summary.competitionsInserted += 1;
      competitionId = row.id;
    }

    this.competitionIds.set(
      `${competition.sport}:${competition.name.toLowerCase()}`,
      competitionId,
    );

    for (const entrant of competition.participants) {
      const participantId = await this.participantId({
        sport: competition.sport,
        name: entrant.participantName,
        countryIso2: entrant.countryIso2,
        title: entrant.title,
        sources: incoming,
      });
      await this.db
        .insert(schema.competitionParticipants)
        .values({
          competitionId,
          participantId,
          status: entrant.status,
          finalRank: entrant.finalRank,
        })
        .onConflictDoUpdate({
          target: [
            schema.competitionParticipants.competitionId,
            schema.competitionParticipants.participantId,
          ],
          set: {
            status: sql`coalesce(excluded.status, ${schema.competitionParticipants.status})`,
            finalRank: sql`coalesce(excluded.final_rank, ${schema.competitionParticipants.finalRank})`,
          },
        });
      this.summary.competitionParticipantRows += 1;
    }

    await this.addCompetitionRelevance(
      competitionId,
      competition.relevantCountryIso2,
    );
    return competitionId;
  }

  private async competitionIdByName(
    sport: SportKey,
    name: string,
  ): Promise<string | null> {
    const key = `${sport}:${name.toLowerCase()}`;
    const cached = this.competitionIds.get(key);
    if (cached !== undefined) return cached;
    const found = await this.db
      .select({ id: schema.competitions.id })
      .from(schema.competitions)
      .where(
        and(
          eq(schema.competitions.sport, sport),
          eq(schema.competitions.name, name),
        ),
      )
      .limit(1);
    const id = found[0]?.id ?? null;
    this.competitionIds.set(key, id);
    return id;
  }

  /** `events` has no unique key: identity is a (provider, providerRef) source. */
  private async findEventBySources(sources: SourceRefRow[]): Promise<
    { id: string; sources: SourceRefRow[] } | null
  > {
    for (const source of sources) {
      const probe = JSON.stringify([
        { provider: source.provider, providerRef: source.providerRef },
      ]);
      const found = await this.db
        .select({ id: schema.events.id, sources: schema.events.sources })
        .from(schema.events)
        .where(sql`${schema.events.sources} @> ${probe}::jsonb`)
        .limit(1);
      const row = found[0];
      if (row !== undefined) return row;
    }
    return null;
  }

  private async upsertEvent(event: Event): Promise<void> {
    const incoming = toSourceRows(event.sources);
    const competitionId =
      event.competitionName === null
        ? null
        : await this.competitionIdByName(event.sport, event.competitionName);
    const venueCountryId = await this.countries.idFor(event.venueCountryIso2);
    const existing = await this.findEventBySources(incoming);

    let eventId: string;
    if (existing !== null) {
      await this.db
        .update(schema.events)
        .set({
          kind: event.kind,
          status: event.status,
          competitionId: competitionId ?? undefined,
          startTime: event.startTime ?? undefined,
          result: event.result ?? undefined,
          venueCountryId: venueCountryId ?? undefined,
          sources: mergeSources(existing.sources, incoming),
          updatedAt: new Date(),
        })
        .where(eq(schema.events.id, existing.id));
      this.summary.eventsUpdated += 1;
      eventId = existing.id;
    } else {
      const inserted = await this.db
        .insert(schema.events)
        .values({
          sport: event.sport,
          kind: event.kind,
          status: event.status,
          competitionId,
          startTime: event.startTime,
          result: event.result,
          venueCountryId,
          sources: incoming,
        })
        .returning({ id: schema.events.id });
      const row = inserted[0];
      if (row === undefined) throw new Error("Failed to insert event");
      this.summary.eventsInserted += 1;
      eventId = row.id;
    }

    for (const side of event.participants) {
      const participantId = await this.participantId({
        sport: event.sport,
        name: side.participantName,
        countryIso2: side.countryIso2,
        title: side.title,
        sources: incoming,
      });
      await this.db
        .insert(schema.eventParticipants)
        .values({
          eventId,
          participantId,
          role: side.role,
          score: side.score,
          result: side.result,
          position: side.position,
        })
        .onConflictDoUpdate({
          target: [
            schema.eventParticipants.eventId,
            schema.eventParticipants.participantId,
          ],
          set: {
            role: sql`coalesce(excluded.role, ${schema.eventParticipants.role})`,
            score: sql`coalesce(excluded.score, ${schema.eventParticipants.score})`,
            result: sql`coalesce(excluded.result, ${schema.eventParticipants.result})`,
            position: sql`coalesce(excluded.position, ${schema.eventParticipants.position})`,
          },
        });
      this.summary.eventParticipantRows += 1;
    }

    for (const iso2 of event.relevantCountryIso2) {
      const countryId = await this.countries.idFor(iso2);
      if (countryId === null) continue;
      await this.db
        .insert(schema.eventRelevantCountries)
        .values({ eventId, countryId })
        .onConflictDoNothing();
      this.summary.relevanceRows += 1;
    }
  }
}

/** Write a canonical batch. Never deletes; safe to run repeatedly. */
export async function persistCanonical(
  db: Db,
  batch: CanonicalBatch,
): Promise<PersistSummary> {
  const summary = emptySummary();
  await new Persister(db, summary).run(batch);
  return summary;
}
