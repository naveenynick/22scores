import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { schema } from "@/lib/db";

/**
 * What the RLS migration is allowed to say.
 *
 * The application connects as the owning `postgres` role, so nothing here can be
 * proved by querying a live database — a passing query would only show that the
 * owner still bypasses row security, which it always will. What is worth pinning
 * is the text of the migration itself: that every mapped table has row security
 * turned on and the Data API roles revoked, that no policy re-opens a door, and
 * that FORCE ROW LEVEL SECURITY — the one setting that would break the server's
 * own reads and writes — never appears.
 *
 * Table names come from the schema rather than a hand-kept list, so a tenth
 * table cannot be added without this failing.
 */
const DIR = fileURLToPath(new URL("../../../drizzle/", import.meta.url));
const RLS_MIGRATION = "0001_rls_lockdown_public_tables.sql";
const API_ROLES = '"anon", "authenticated"';

const read = (name: string): string => readFileSync(`${DIR}${name}`, "utf8");
/** Migration text as the database will see it: comment lines dropped. */
const executable = (sql: string): string =>
  sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
const sqlFiles = readdirSync(DIR)
  .filter((name) => name.endsWith(".sql"))
  .sort();
const everyMigration = sqlFiles.map(read).map(executable).join("\n");
const rlsSql = read(RLS_MIGRATION);
const journal = JSON.parse(read("meta/_journal.json")) as {
  entries: { tag: string }[];
};

// Widened to `unknown` first: each export has its own literal table type, so the
// narrowing has to start from a type drizzle's own guard can refine.
const tables = (Object.values(schema) as unknown[])
  .filter((value): value is PgTable => is(value, PgTable))
  .map((table) => getTableConfig(table).name)
  .sort();

/** Statements as the migrator will run them, comments stripped. */
const statements = executable(rlsSql)
  .split("--> statement-breakpoint")
  .map((chunk) => chunk.replace(/\s+/g, " ").trim())
  .filter((statement) => statement !== "");

describe("RLS lockdown migration", () => {
  it("covers the nine canonical tables and is registered in the journal", () => {
    expect(tables).toEqual([
      "competition_participants",
      "competition_relevant_countries",
      "competitions",
      "countries",
      "event_participants",
      "event_relevant_countries",
      "events",
      "participants",
      "sports",
    ]);
    expect(journal.entries.map((entry) => entry.tag)).toContain(
      RLS_MIGRATION.replace(/\.sql$/, ""),
    );
  });

  it("enables row level security on every mapped table", () => {
    for (const table of tables) {
      expect(rlsSql).toContain(
        `ALTER TABLE "public"."${table}" ENABLE ROW LEVEL SECURITY;`,
      );
    }
  });

  it("revokes anon and authenticated privileges on every mapped table", () => {
    for (const table of tables) {
      expect(rlsSql).toContain(
        `REVOKE ALL PRIVILEGES ON TABLE "public"."${table}" FROM ${API_ROLES};`,
      );
    }
  });

  it("stops future tables inheriting those privileges", () => {
    expect(rlsSql).toContain(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA "public" REVOKE ALL PRIVILEGES ON TABLES FROM ${API_ROLES};`,
    );
  });

  it("says nothing else: no policy, no FORCE, no grant, no data loss", () => {
    // Asserted against executable SQL, so a comment explaining why FORCE is
    // absent cannot be mistaken for FORCE being present.
    expect(/force\s+row\s+level\s+security/i.test(everyMigration)).toBe(false);
    expect(/(create|alter)\s+policy/i.test(everyMigration)).toBe(false);
    expect(/disable\s+row\s+level\s+security/i.test(everyMigration)).toBe(false);
    const rls = executable(rlsSql);
    expect(/\b(drop|truncate)\b|\bdelete\s+from\b/i.test(rls)).toBe(false);
    // No migration hands the Data API roles anything back.
    const grants = everyMigration
      .split("\n")
      .filter((line) => /^\s*grant\b/i.test(line));
    expect(grants).toEqual([]);
  });

  it("runs one statement per breakpoint, and only the three intended kinds", () => {
    const allowed = [
      /^REVOKE ALL PRIVILEGES ON TABLE "public"\."\w+" FROM "anon", "authenticated";$/,
      /^ALTER DEFAULT PRIVILEGES IN SCHEMA "public" REVOKE ALL PRIVILEGES ON TABLES FROM "anon", "authenticated";$/,
      /^ALTER TABLE "public"\."\w+" ENABLE ROW LEVEL SECURITY;$/,
    ];
    expect(statements).toHaveLength(tables.length * 2 + 1);
    for (const statement of statements) {
      expect(statement.match(/;/g)).toHaveLength(1);
      expect(allowed.some((shape) => shape.test(statement))).toBe(true);
    }
  });
});
