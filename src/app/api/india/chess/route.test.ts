import { describe, expect, it, vi } from "vitest";

import type {
  ChessReader,
  GameRow,
  TournamentRow,
} from "@/core/queries/chess-reader";

/**
 * The endpoint's own contract, with the database replaced but the query layer
 * real: the freshness rule that runs here is the same code /india/chess uses.
 *
 * Fixtures are dated relative to the real clock on purpose. The route takes its
 * own `new Date()` and hands it to the query layer, so a test that froze time
 * would stop proving that the wiring exists.
 */

const injected = vi.hoisted(() => ({ reader: null as ChessReader | null }));

// Only the connection is replaced. `schema` stays real because the query layer
// builds table aliases from it at import time; a stub there would break the
// module before a single test ran. Nothing connects: `getDb` never runs.
vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  getDb: () => injected.reader,
}));

const { GET } = await import("@/app/api/india/chess/route");

const MINUTE = 60 * 1000;

function gameRow(
  id: string,
  status: GameRow["status"],
  agoMs: number,
  result: string | null = null,
): GameRow {
  return {
    id,
    status,
    startTime: new Date(Date.now() - agoMs),
    result,
    competitionName: "Broadcast 2026",
    sources: [
      {
        provider: "lichess",
        providerRef: `rnd/${id}`,
        fetchedAt: new Date(Date.now() - agoMs).toISOString(),
        url: `https://lichess.org/broadcast/${id}`,
      },
    ],
  };
}

/** A reader with no tournaments; only the game feeds matter here. */
function readerWithGames(games: GameRow[]): ChessReader {
  return {
    async tournaments() {
      return [] as TournamentRow[];
    },
    async tournamentGms() {
      return [];
    },
    async competitionRounds() {
      return [];
    },
    async games(query) {
      return games.filter((row) => query.statuses.includes(row.status));
    },
    async gameSides() {
      return [];
    },
  };
}

async function get(url = "http://localhost/api/india/chess"): Promise<{
  status: number;
  body: Record<string, unknown>;
}> {
  const response = await GET(new Request(url));
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

interface Body {
  counts: Record<string, number>;
  liveGames: { id: string; liveClaim: { confidence: string } | null }[];
  unconfirmedGames: {
    id: string;
    status: string;
    result: string | null;
    liveClaim: { confidence: string; lastSeenAt: string | null } | null;
  }[];
  recentGames: { id: string }[];
}

describe("GET /api/india/chess", () => {
  it("returns a freshly fetched live game as live", async () => {
    injected.reader = readerWithGames([gameRow("fresh", "live", 2 * MINUTE)]);

    const { status, body } = await get();
    const parsed = body as unknown as Body;

    expect(status).toBe(200);
    expect(parsed.liveGames.map((g) => g.id)).toEqual(["fresh"]);
    expect(parsed.liveGames[0]?.liveClaim?.confidence).toBe("confirmed");
    expect(parsed.counts["liveGames"]).toBe(1);
    expect(parsed.counts["unconfirmedGames"]).toBe(0);
  });

  it("does not report a stale live game as live", async () => {
    injected.reader = readerWithGames([
      gameRow("fresh", "live", 2 * MINUTE),
      gameRow("stale", "live", 3 * 60 * MINUTE),
    ]);

    const { body } = await get();
    const parsed = body as unknown as Body;

    expect(parsed.liveGames.map((g) => g.id)).toEqual(["fresh"]);
    expect(parsed.counts["liveGames"]).toBe(1);
  });

  it("exposes the stale game separately, unfinished and without a result", async () => {
    injected.reader = readerWithGames([gameRow("stale", "live", 3 * 60 * MINUTE)]);

    const { body } = await get();
    const parsed = body as unknown as Body;

    expect(parsed.unconfirmedGames.map((g) => g.id)).toEqual(["stale"]);
    expect(parsed.counts["unconfirmedGames"]).toBe(1);
    const stale = parsed.unconfirmedGames[0];
    expect(stale?.liveClaim?.confidence).toBe("unconfirmed");
    // Serialized so a client can say when it was last seen.
    expect(typeof stale?.liveClaim?.lastSeenAt).toBe("string");
    // Never rewritten into a finished game, and no result invented.
    expect(stale?.status).toBe("live");
    expect(stale?.result).toBeNull();
    expect(parsed.recentGames).toEqual([]);
    expect(parsed.counts["recentGames"]).toBe(0);
  });

  it("leaves real results alone", async () => {
    injected.reader = readerWithGames([
      gameRow("done", "recent", 5 * 60 * MINUTE, "1-0"),
    ]);

    const { body } = await get();
    const parsed = body as unknown as Body;

    expect(parsed.recentGames.map((g) => g.id)).toEqual(["done"]);
    expect(parsed.unconfirmedGames).toEqual([]);
  });

  it("fails closed with no detail when the read throws", async () => {
    injected.reader = {
      ...readerWithGames([]),
      async games() {
        throw new Error("connect ECONNREFUSED 10.0.0.1:5432");
      },
    };

    const { status, body } = await get();

    expect(status).toBe(503);
    expect(body).toEqual({ error: "chess_data_unavailable" });
  });
});
