-- Lock the Data API out of the canonical tables, and turn RLS on as a backstop.
--
-- Why: every table in `public` is owned by `postgres`, which is the role the
-- application connects as. Supabase's default privileges had additionally
-- granted anon and authenticated full DML on all nine tables while RLS was off
-- and no policies existed, so anything holding the anon key could read, write,
-- or TRUNCATE canonical sports data through the Data API. Note that RLS alone
-- would not have closed that: row security is not applied to TRUNCATE. The
-- revokes below are what removes the reachable privilege; ENABLE ROW LEVEL
-- SECURITY is defence in depth for the DML paths.
--
-- Why this is safe for the server: `postgres` owns these tables and carries
-- BYPASSRLS, and FORCE ROW LEVEL SECURITY is deliberately NOT set, so the
-- Drizzle reads and the Lichess ingestion writes are unaffected. No policy is
-- created, so with RLS enabled anon and authenticated are denied by default —
-- there is no path to re-open access by accident.
--
-- Assumes the Supabase-managed roles anon and authenticated exist, and that the
-- role running this migration is the grantor of those privileges (`postgres`).

-- 1. Existing tables: take the Data API roles off every one of the nine.
REVOKE ALL PRIVILEGES ON TABLE "public"."countries" FROM "anon", "authenticated";--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "public"."sports" FROM "anon", "authenticated";--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "public"."participants" FROM "anon", "authenticated";--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "public"."competitions" FROM "anon", "authenticated";--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "public"."events" FROM "anon", "authenticated";--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "public"."event_participants" FROM "anon", "authenticated";--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "public"."competition_participants" FROM "anon", "authenticated";--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "public"."event_relevant_countries" FROM "anon", "authenticated";--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "public"."competition_relevant_countries" FROM "anon", "authenticated";--> statement-breakpoint

-- 2. Future tables: stop the same grants being handed out again on create.
ALTER DEFAULT PRIVILEGES IN SCHEMA "public" REVOKE ALL PRIVILEGES ON TABLES FROM "anon", "authenticated";--> statement-breakpoint

-- 3. Deny-by-default row security on all nine. No policies, no FORCE.
ALTER TABLE "public"."countries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."sports" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."participants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."competitions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."event_participants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."competition_participants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."event_relevant_countries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."competition_relevant_countries" ENABLE ROW LEVEL SECURITY;
