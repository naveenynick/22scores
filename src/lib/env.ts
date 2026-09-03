import { z } from "zod";

/**
 * Server-side environment validation.
 *
 * Import this ONLY from server code (route handlers, server components, the
 * ingestion worker). Values are validated lazily on first access so that
 * `next build` — which never needs a live DB — does not fail when the
 * variables are absent in CI.
 */
const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  NEXT_PUBLIC_SITE_URL: z.string().url().default("http://localhost:3000"),

  // Provider credentials — optional; unused until ingestion is implemented.
  // Optional so `next build` and the chess paths (Lichess needs no key) keep
  // working on a machine that has no cricket credentials configured.
  THESPORTSDB_API_KEY: z.string().optional(),
  CRICKETDATA_API_KEY: z.string().optional(),
  PROVIDER_CONTACT_USER_AGENT: z
    .string()
    .default("22scores (contact: you@example.com)"),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function getEnv(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(
      `Invalid environment variables:\n${parsed.error.issues
        .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
        .join("\n")}`,
    );
  }
  cached = parsed.data;
  return cached;
}
