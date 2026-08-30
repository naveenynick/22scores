import { describe, expect, it } from "vitest";

import { LichessClient } from "@/core/providers/chess/lichess-client";
import { LichessChessProvider } from "@/core/providers/chess/lichess";

const NOW = new Date("2026-08-31T12:00:00.000Z");
const R1 = Date.UTC(2026, 7, 31, 10, 0, 0);
const R2 = Date.UTC(2026, 8, 4, 10, 0, 0);

const PAGE_1 = [
  JSON.stringify({
    tour: {
      id: "tA",
      name: "Alpha Masters",
      url: "https://lichess.org/broadcast/alpha/tA",
      tier: 5,
      dates: { start: R1 },
    },
    rounds: [
      {
        id: "tA-r1",
        name: "Round 1",
        startsAt: R1,
        ongoing: true,
        url: "https://lichess.org/broadcast/alpha/round-1/tA-r1",
      },
    ],
  }),
  "", // blank lines must not break NDJSON parsing
  "{ not json",
  JSON.stringify({
    tour: { id: "tB", name: "Beta Open" },
    rounds: [{ id: "tB-r1", startsAt: R2 }],
  }),
].join("\n");

const TOP = JSON.stringify({
  active: [
    {
      tour: { id: "tA", name: "Alpha Masters" },
      round: { id: "tA-r1", ongoing: true },
    },
  ],
  upcoming: [],
  past: { currentPageResults: [] },
});

const ROUND_DETAIL = JSON.stringify({
  round: { id: "tA-r1", name: "Round 1", startsAt: R1, ongoing: true },
  tour: { id: "tA", name: "Alpha Masters" },
  games: [
    {
      id: "gA",
      players: [
        { name: "Erigaisi Arjun", title: "GM", fed: "IND", fideId: 35009192 },
        { name: "Nakamura, Hikaru", title: "GM", fed: "USA" },
      ],
      status: "*",
    },
  ],
});

function fakeLichess(): { fetchImpl: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("/api/broadcast?page=")) return new Response(PAGE_1);
    if (url.endsWith("/api/broadcast/top")) return new Response(TOP);
    if (url.includes("/api/broadcast/-/-/tA-r1")) {
      return new Response(ROUND_DETAIL);
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, urls };
}

function providerFor(fetchImpl: typeof fetch): LichessChessProvider {
  return new LichessChessProvider({
    client: new LichessClient({
      fetchImpl,
      minIntervalMs: 0,
      maxRetries: 0,
      backoffMs: 0,
    }),
    now: () => NOW,
  });
}

describe("LichessChessProvider", () => {
  it("discovers tournaments, rounds and games within a bounded request budget", async () => {
    const { fetchImpl, urls } = fakeLichess();
    const provider = providerFor(fetchImpl);
    const query = { limit: 1 };

    const competitions = await provider.getCompetitions(query);
    const events = await provider.getEvents(query);
    const participants = await provider.getParticipants(query);

    // 1 discovery page + 1 top + 1 round detail for the single selected tour.
    expect(urls).toHaveLength(3);
    expect(urls[0]).toBe("https://lichess.org/api/broadcast?page=1");
    expect(urls[1]).toBe("https://lichess.org/api/broadcast/top");
    expect(urls[2]).toBe("https://lichess.org/api/broadcast/-/-/tA-r1");

    expect(competitions).toHaveLength(1);
    expect(competitions[0]?.name).toBe("Alpha Masters");
    expect(competitions[0]?.status).toBe("ongoing");
    expect(competitions[0]?.relevantCountryIso2).toEqual(["IN"]);
    expect(competitions[0]?.participants.map((p) => p.participantName)).toEqual([
      "Erigaisi Arjun",
      "Nakamura, Hikaru",
    ]);

    expect(events.map((e) => `${e.kind}:${e.status}`)).toEqual([
      "round:live",
      "game:live",
    ]);
    const game = events.find((e) => e.kind === "game");
    expect(game?.participants.map((p) => p.role)).toEqual(["white", "black"]);
    expect(game?.relevantCountryIso2).toEqual(["IN"]);

    expect(participants.map((p) => p.name)).toEqual([
      "Erigaisi Arjun",
      "Nakamura, Hikaru",
    ]);
    expect(await provider.getParticipants({ ...query, country: "IN" })).toEqual([
      expect.objectContaining({ name: "Erigaisi Arjun", title: "GM" }),
    ]);
    expect(urls).toHaveLength(3); // still cached
  });

  it("filters by country and status without extra requests", async () => {
    const { fetchImpl, urls } = fakeLichess();
    const provider = providerFor(fetchImpl);
    const query = { limit: 2 };

    expect(await provider.getCompetitions({ ...query, country: "IN" })).toEqual([
      expect.objectContaining({ name: "Alpha Masters" }),
    ]);
    expect(
      await provider.getEvents({ ...query, status: ["upcoming"] }),
    ).toEqual([expect.objectContaining({ sport: "chess", status: "upcoming" })]);
    // Two tournaments selected -> at most one round detail each.
    expect(urls.filter((u) => u.includes("/-/-/"))).toHaveLength(2);
  });

  it("surfaces an outage instead of returning empty data", async () => {
    const failing = (async () =>
      new Response("boom", { status: 500 })) as typeof fetch;
    const provider = providerFor(failing);

    await expect(provider.getCompetitions({ limit: 1 })).rejects.toThrow(
      /Lichess HTTP 500/,
    );
    const health = await provider.health();
    expect(health.ok).toBe(false);
  });
});
