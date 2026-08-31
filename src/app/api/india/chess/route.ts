import { NextResponse } from "next/server";

import { getIndiaChessOverview, INDIA_ISO2 } from "@/core/queries/chess";
import { getDb } from "@/lib/db";

/**
 * GET /api/india/chess — read-only India chess board.
 *
 * Returns five clearly separated sections (ongoingTournaments,
 * upcomingTournaments, recentGames, liveGames, unconfirmedGames) built from data
 * already in Supabase. No provider is contacted here: ingestion is a separate
 * path, so a Lichess outage cannot affect this endpoint or change what it
 * returns.
 *
 * `liveGames` and `unconfirmedGames` come from the same read-time freshness rule
 * the page uses — one call to `getIndiaChessOverview`, so the two surfaces can
 * never disagree about what is live. A game stored as live whose provenance has
 * gone stale appears in `unconfirmedGames` with a `liveClaim` explaining when it
 * was last seen; it is never moved into `recentGames` and never given a result.
 *
 * Public and unauthenticated by design — everything it exposes is public sports
 * data. Add auth before returning anything user-specific through it.
 */

/** Never prerender or cache: the answer is "right now". */
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

/** Clamp untrusted input rather than passing it to the database. */
function parseLimit(raw: string | null): number {
  if (raw === null) return DEFAULT_LIMIT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

export async function GET(request: Request): Promise<NextResponse> {
  const limit = parseLimit(new URL(request.url).searchParams.get("limit"));
  // One clock for the freshness decision and for what the response says it is.
  const generatedAt = new Date();

  try {
    const overview = await getIndiaChessOverview(getDb(), {
      limit,
      now: generatedAt,
    });
    return NextResponse.json(
      {
        country: INDIA_ISO2,
        sport: "chess",
        generatedAt: generatedAt.toISOString(),
        limit,
        counts: {
          ongoingTournaments: overview.ongoingTournaments.length,
          upcomingTournaments: overview.upcomingTournaments.length,
          recentGames: overview.recentGames.length,
          liveGames: overview.liveGames.length,
          unconfirmedGames: overview.unconfirmedGames.length,
        },
        ongoingTournaments: overview.ongoingTournaments,
        upcomingTournaments: overview.upcomingTournaments,
        recentGames: overview.recentGames,
        liveGames: overview.liveGames,
        unconfirmedGames: overview.unconfirmedGames,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    // Log the class of failure only. A driver error can carry the connection
    // target, so neither the message nor the error object is ever returned.
    console.error(
      "[GET /api/india/chess] database read failed:",
      error instanceof Error ? error.name : "UnknownError",
    );
    return NextResponse.json(
      { error: "chess_data_unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
