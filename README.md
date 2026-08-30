# 22scores

Discover the sports your country is involved in — matches, tournaments, and
results across sports, in one place. **Country-first** (India is the first
country, but the architecture is country-agnostic) and **multi-provider** (no
part of the app depends on a single external data source).

> Status: **foundation only.** This repo currently contains the architecture,
> canonical data model, provider abstraction, and database schema. There is no
> live data ingestion, no provider API calls, no auth, and no product UI yet.

## Tech stack

- **Next.js (App Router) + TypeScript** — SSR/SSG for SEO and speed
- **Supabase Postgres** + **Drizzle ORM** — typed schema, migrations, queries
- **Zod** — validates external data at the boundary and validates env
- **Tailwind CSS v4 + shadcn/ui** — mobile-first, accessible UI foundation

## Architecture

Ingestion is decoupled from serving. External sports APIs are **never** called
on a user request. A scheduled worker (added later) pulls from providers,
normalizes to the canonical model, and writes to Supabase; the web app reads
only from Supabase.

```
External APIs ──▶ Provider adapters ──▶ Aggregator (merge/dedupe)
                                             │
                                             ▼
                                    Supabase (canonical model)
                                             │
                                             ▼
                                    Next.js (server-rendered)
```

### Canonical model (`src/core/models/canonical.ts`)

Provider-agnostic types every adapter must produce: `Country`, `Sport`,
`Participant` (team/player), `Competition` (league/series/tournament), and
`Event` (match/game/round). Each record carries `sources[]` provenance so one
canonical record can be backed by multiple providers. `relevantCountryIso2[]`
is the country-first index.

### Provider abstraction (`src/core/providers/`)

- `types.ts` — the `SportProvider` interface + `BaseSportProvider` (declares
  zero capabilities, returns empty results; adapters override what they
  support). Capabilities are **declared, never assumed**.
- `registry.ts` — maps each sport to an **ordered** list of providers
  (precedence: primary first, fallbacks after). The app depends on this, never
  on a concrete provider.
- `aggregator.ts` — fans a query out to all providers for a sport, skips
  unhealthy ones, and merges/deduplicates results (union provenance, fill
  missing fields, dedupe by normalized keys).

Current registration:

| Sport   | Providers (in order)                                             |
| ------- | ---------------------------------------------------------------- |
| cricket | TheSportsDB (initial) → _future fallback_                        |
| chess   | Lichess (tournament **discovery**) → Chess.com (supplementary)   |

Chess.com has **no** global event-discovery feed, so its
`tournamentDiscovery` capability is `false`; discovery must come from Lichess.

### Indian GM allow-list (`src/config/indian-gms.ts`)

The MVP tracks **Indian GMs**, not every Indian player. This curated list is the
source of truth for "represents India" in chess (public APIs don't expose FIDE
federation reliably). Add/remove entries here — no code changes needed.

### Database (`src/lib/db/`)

- `schema.ts` — Drizzle tables mirroring the canonical model, with
  `*_relevant_countries` join tables as the country-first query index.
- `index.ts` — lazily-initialized Drizzle client (postgres.js). Server-only.

## Getting started

```bash
npm install
cp .env.example .env.local   # set DATABASE_URL (Supabase); also .env for drizzle-kit
npm run typecheck
npm run build
```

Database migrations (requires a reachable `DATABASE_URL` in `.env`):

```bash
npm run db:generate   # generate SQL migration from schema (offline)
npm run db:migrate    # apply migrations to the database
```

## Scripts

| Script                | Purpose                                  |
| --------------------- | ---------------------------------------- |
| `npm run dev`         | Start Next.js dev server                 |
| `npm run build`       | Production build                         |
| `npm run typecheck`   | `tsc --noEmit`                           |
| `npm run db:generate` | Generate Drizzle migration from schema   |
| `npm run db:migrate`  | Apply migrations                         |
| `npm run db:studio`   | Open Drizzle Studio                      |

## Environment

See [.env.example](.env.example). Only `DATABASE_URL` is required for the
foundation. Provider keys are placeholders — no keys are used yet.

## Roadmap (not yet implemented)

1. Lichess spike + real chess/cricket adapters.
2. Ingestion worker (Render Cron) writing canonical data to Supabase.
3. Country-first UI (India cricket + chess), SEO metadata.
4. Additional providers and countries.
