import { config } from "dotenv";

// Local secrets live in .env.local (git-ignored); .env is the fallback.
config({ path: ".env.local" });
config({ path: ".env" });

const { closeDb, getDb } = await import("@/lib/db");
const { syncChess } = await import("@/core/ingest/sync-chess");
const { getRelevantCompetitions, getRelevantEvents } = await import(
  "@/core/queries/relevance"
);

/**
 * Controlled local Lichess sync.
 *
 *   npm run sync:lichess -- --limit 3
 *
 * Fetches a small, bounded sample through the real pipeline
 * (aggregator -> Lichess provider -> canonical model -> Postgres) and then
 * proves the result is readable back through the country-first queries.
 */

function intArg(flag: string, fallback: number): number {
  const index = process.argv.indexOf(flag);
  if (index === -1) return fallback;
  const parsed = Number.parseInt(process.argv[index + 1] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function main(): Promise<void> {
  const limit = intArg("--limit", 3);
  const db = getDb();

  console.log(`Syncing chess via the provider registry (limit=${limit})...`);
  const result = await syncChess(db, { limit });

  console.log("\nFetched from providers:");
  console.table(result.fetched);
  console.log("Persisted:");
  console.table(result.persisted);

  const competitions = await getRelevantCompetitions(db, "chess", "IN");
  const events = await getRelevantEvents(db, "chess", "IN", 5);

  console.log(`\nIndia-relevant chess competitions in DB: ${competitions.length}`);
  for (const competition of competitions.slice(0, 5)) {
    const entrants = competition.entrants
      .map((e) => `${e.title ?? "?"} ${e.name}`)
      .join(", ");
    console.log(
      `  - [${competition.status}] ${competition.name}` +
        (entrants === "" ? "" : `\n      Indian entrants: ${entrants}`),
    );
  }

  console.log(`\nIndia-relevant chess events in DB (newest 5 of many):`);
  for (const event of events) {
    const sides = event.sides
      .map((s) => `${s.role ?? "-"}:${s.name}${s.result ? ` (${s.result})` : ""}`)
      .join(" vs ");
    console.log(
      `  - [${event.status}] ${event.kind} ${event.competitionName ?? "?"}` +
        `${sides === "" ? "" : ` — ${sides}`}${event.result ? ` = ${event.result}` : ""}`,
    );
  }
}

try {
  await main();
} catch (error) {
  console.error("\nSync failed (no data was deleted):", error);
  process.exitCode = 1;
} finally {
  await closeDb();
}
