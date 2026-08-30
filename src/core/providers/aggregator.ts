import type {
  Competition,
  Event,
  Participant,
  SportKey,
} from "@/core/models/canonical";
import type { ProviderQuery, SportProvider } from "@/core/providers/types";
import { getProviders } from "@/core/providers/registry";

/**
 * Aggregator: fans a query out to every provider for a sport, then merges and
 * deduplicates the canonical results. Providers that fail health() or throw are
 * skipped for the cycle (existing data persists elsewhere) so the product never
 * depends on a single provider being up.
 *
 * NOTE: no network calls happen yet — providers currently return []. The merge
 * logic is real so ingestion can plug straight in.
 */

/** Normalize a name for cross-provider matching. */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, " ").trim();
}

async function collect<T>(
  sport: SportKey,
  query: ProviderQuery,
  pick: (p: SportProvider) => Promise<T[]>,
): Promise<T[]> {
  const providers = getProviders(sport);
  const settled = await Promise.allSettled(
    providers.map(async (p) => {
      const health = await p.health();
      if (!health.ok) return [] as T[];
      return pick(p);
    }),
  );
  return settled.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
}

/** Union provenance and fill missing (null/empty) fields from `incoming`. */
function mergeInto<T extends { sources: unknown[] }>(base: T, incoming: T): T {
  const merged = { ...base } as Record<string, unknown>;
  const inc = incoming as Record<string, unknown>;
  for (const [key, value] of Object.entries(inc)) {
    if (key === "sources") continue;
    const current = merged[key];
    const isEmpty =
      current === null ||
      current === undefined ||
      (Array.isArray(current) && current.length === 0);
    if (isEmpty && value !== null && value !== undefined) merged[key] = value;
  }
  merged.sources = [...(base.sources ?? []), ...(incoming.sources ?? [])];
  return merged as T;
}

function dedupe<T extends { sources: unknown[] }>(
  items: T[],
  keyOf: (item: T) => string,
): T[] {
  const byKey = new Map<string, T>();
  for (const item of items) {
    const key = keyOf(item);
    const existing = byKey.get(key);
    byKey.set(key, existing ? mergeInto(existing, item) : item);
  }
  return [...byKey.values()];
}

// --- Public aggregation API -------------------------------------------------

export async function getCompetitions(
  sport: SportKey,
  query: ProviderQuery = {},
): Promise<Competition[]> {
  const all = await collect(sport, query, (p) => p.getCompetitions(query));
  return dedupe(
    all,
    (c) => `${c.sport}:${normalizeName(c.name)}:${c.startDate?.getFullYear() ?? ""}`,
  );
}

export async function getEvents(
  sport: SportKey,
  query: ProviderQuery = {},
): Promise<Event[]> {
  const all = await collect(sport, query, (p) => p.getEvents(query));
  return dedupe(all, (e) => {
    const sides = e.participants
      .map((s) => normalizeName(s.participantName))
      .sort()
      .join("|");
    const day = e.startTime ? e.startTime.toISOString().slice(0, 10) : "";
    return `${e.sport}:${sides}:${day}`;
  });
}

export async function getParticipants(
  sport: SportKey,
  query: ProviderQuery = {},
): Promise<Participant[]> {
  const all = await collect(sport, query, (p) => p.getParticipants(query));
  return dedupe(all, (p) => `${p.sport}:${p.type}:${normalizeName(p.name)}`);
}
