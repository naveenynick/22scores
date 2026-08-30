import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { getEnv } from "@/lib/env";
import * as schema from "./schema";

/**
 * Lazily-initialized Drizzle client (postgres.js driver).
 *
 * The connection is created on first use so that importing this module during
 * `next build` does not require DATABASE_URL. Import only from server code.
 */
let db: PostgresJsDatabase<typeof schema> | null = null;
let client: ReturnType<typeof postgres> | null = null;

export function getDb(): PostgresJsDatabase<typeof schema> {
  if (db) return db;
  const { DATABASE_URL } = getEnv();
  // `prepare: false` is recommended when running behind Supabase's
  // transaction-mode pooler (Supavisor).
  client = postgres(DATABASE_URL, { prepare: false });
  db = drizzle(client, { schema });
  return db;
}

export { schema };

/** Close the pool. Only for one-shot scripts; the web app never calls this. */
export async function closeDb(): Promise<void> {
  if (client === null) return;
  await client.end({ timeout: 5 });
  client = null;
  db = null;
}
