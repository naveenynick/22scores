import { describe, expect, it } from "vitest";

import { LichessClient } from "@/core/providers/chess/lichess-client";
import {
  LichessChessProvider,
  pickRounds,
  planRoundRequests,
  recoveryRoundIds,
  type RoundBudget,
} from "@/core/providers/chess/lichess";
import type { LichessRound } from "@/core/providers/chess/lichess-schemas";

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

// --- Round selection --------------------------------------------------------

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW_MS = NOW.getTime();

const BUDGET: RoundBudget = { ongoing: 2, recentlyFinished: 2, upcoming: 1 };

function rnd(id: string, over: Partial<LichessRound> = {}): LichessRound {
  return { id, ...over };
}

/**
 * Which rounds a sync re-reads. This is what decides whether stored data can
 * heal: games exist only in a round-detail response, so a round that stops being
 * requested keeps whatever status it last had.
 */
describe("pickRounds", () => {
  it("re-reads the round under way and the ones that just finished", () => {
    const picked = pickRounds(
      [
        rnd("r1", { startsAt: NOW_MS - 3 * DAY + HOUR, finished: true }),
        rnd("r2", { startsAt: NOW_MS - 2 * HOUR, finished: true }),
        rnd("r3", { startsAt: NOW_MS - 30 * 60 * 1000, ongoing: true }),
        rnd("r4", { startsAt: NOW_MS + DAY }),
        rnd("r5", { startsAt: NOW_MS + 2 * DAY }),
      ],
      BUDGET,
      NOW_MS,
    );

    // Under way first, then newest-finished first, then the next one due only.
    expect(picked.map((r) => r.id)).toEqual(["r3", "r2", "r1", "r4"]);
  });

  it("does not crawl history: a finished round past the window is dropped", () => {
    const picked = pickRounds(
      [
        rnd("old", { startsAt: NOW_MS - 10 * DAY, finished: true }),
        rnd("older", { startsAt: NOW_MS - 40 * DAY, finished: true }),
        rnd("fresh", { startsAt: NOW_MS - 6 * HOUR, finished: true }),
      ],
      BUDGET,
      NOW_MS,
    );

    expect(picked.map((r) => r.id)).toEqual(["fresh"]);
  });

  it("keeps an undated finished round eligible rather than assuming it is old", () => {
    const picked = pickRounds([rnd("nodate", { finished: true })], BUDGET, NOW_MS);
    expect(picked.map((r) => r.id)).toEqual(["nodate"]);
  });

  it("follows more than one live round, since broadcasts overlap them", () => {
    const picked = pickRounds(
      [
        rnd("a", { startsAt: NOW_MS - HOUR, ongoing: true }),
        rnd("b", { startsAt: NOW_MS - 20 * 60 * 1000, ongoing: true }),
        rnd("c", { startsAt: NOW_MS - 10 * 60 * 1000, ongoing: true }),
      ],
      BUDGET,
      NOW_MS,
    );
    expect(picked).toHaveLength(2);
  });

  it("asks for nothing when the budget is zero", () => {
    expect(
      pickRounds(
        [rnd("a", { ongoing: true }), rnd("b", { finished: true }), rnd("c")],
        { ongoing: 0, recentlyFinished: 0, upcoming: 0 },
        NOW_MS,
      ),
    ).toEqual([]);
  });
});

describe("planRoundRequests", () => {
  const tournament = (...rounds: LichessRound[]) => ({
    rounds: new Map(rounds.map((r) => [r.id, r])),
  });

  it("interleaves by priority so no tournament is starved by the ceiling", () => {
    const plan = planRoundRequests(
      [
        tournament(
          rnd("a-live", { ongoing: true }),
          rnd("a-done", { startsAt: NOW_MS - HOUR, finished: true }),
        ),
        tournament(
          rnd("b-live", { ongoing: true }),
          rnd("b-done", { startsAt: NOW_MS - HOUR, finished: true }),
        ),
      ],
      BUDGET,
      10,
      NOW_MS,
    );

    expect(plan.map((r) => r.round.id)).toEqual([
      "a-live",
      "b-live",
      "a-done",
      "b-done",
    ]);
    expect(plan.map((r) => r.tournamentIndex)).toEqual([0, 1, 0, 1]);
  });

  it("stops at the global ceiling, keeping every tournament's best round", () => {
    const plan = planRoundRequests(
      [
        tournament(rnd("a-live", { ongoing: true }), rnd("a-next")),
        tournament(rnd("b-live", { ongoing: true }), rnd("b-next")),
        tournament(rnd("c-live", { ongoing: true }), rnd("c-next")),
      ],
      BUDGET,
      3,
      NOW_MS,
    );

    expect(plan.map((r) => r.round.id)).toEqual(["a-live", "b-live", "c-live"]);
  });

  it("plans nothing when no request is allowed", () => {
    expect(
      planRoundRequests(
        [tournament(rnd("a-live", { ongoing: true }))],
        BUDGET,
        0,
        NOW_MS,
      ),
    ).toEqual([]);
  });
});

// --- Recovering a game that was live on an earlier sync ---------------------

const PLAYERS = [
  { name: "Erigaisi Arjun", title: "GM", fed: "IND", fideId: 35009192 },
  { name: "Nakamura, Hikaru", title: "GM", fed: "USA" },
];

/**
 * One broadcast, seen twice. In phase 1 round 1 is under way; by phase 2 it has
 * finished with a result and round 2 has taken over.
 */
function healingLichess(phase: () => 1 | 2): {
  fetchImpl: typeof fetch;
  urls: string[];
} {
  const urls: string[] = [];
  const round1 = (): LichessRound =>
    phase() === 1
      ? { id: "tC-r1", name: "Round 1", startsAt: NOW_MS - 2 * HOUR, ongoing: true }
      : { id: "tC-r1", name: "Round 1", startsAt: NOW_MS - 2 * HOUR, finished: true };
  const round2 = (): LichessRound =>
    phase() === 1
      ? { id: "tC-r2", name: "Round 2", startsAt: NOW_MS + 2 * HOUR }
      : { id: "tC-r2", name: "Round 2", startsAt: NOW_MS - 20 * 60 * 1000, ongoing: true };
  const tour = { id: "tC", name: "Healing Cup", tier: 5 };

  const detail = (round: LichessRound, status: string) =>
    new Response(
      JSON.stringify({
        round,
        tour,
        games: [{ id: "gC", players: PLAYERS, status }],
      }),
    );

  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("/api/broadcast?page=")) {
      return new Response(
        JSON.stringify({ tour, rounds: [round1(), round2()] }),
      );
    }
    if (url.endsWith("/api/broadcast/top")) {
      return new Response(
        JSON.stringify({ active: [], upcoming: [], past: { currentPageResults: [] } }),
      );
    }
    if (url.includes("/api/broadcast/-/-/tC-r1")) {
      // The board that was in progress last time now has a result.
      return detail(round1(), phase() === 1 ? "*" : "1-0");
    }
    if (url.includes("/api/broadcast/-/-/tC-r2")) {
      return detail(round2(), "*");
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  return { fetchImpl, urls };
}

describe("repeated syncs", () => {
  it("replaces a previously live game with its result on the next sync", async () => {
    let phase: 1 | 2 = 1;
    const { fetchImpl, urls } = healingLichess(() => phase);
    const query = { limit: 1 };

    // Sync 1: round 1 is under way, so its board is live with no result.
    const first = await providerFor(fetchImpl).getEvents(query);
    const liveGame = first.find((e) => e.kind === "game");
    expect(liveGame?.status).toBe("live");
    expect(liveGame?.result).toBeNull();
    const ref = liveGame?.sources[0]?.providerRef;
    expect(ref).toBe("tC-r1/gC");

    // Sync 2: round 1 has finished and round 2 is under way. A fresh provider
    // stands in for a later process — nothing is carried over in memory.
    phase = 2;
    urls.length = 0;
    const second = await providerFor(fetchImpl).getEvents(query);

    // The finished round is still re-read, which is what lets the row heal.
    expect(urls).toContain("https://lichess.org/api/broadcast/-/-/tC-r1");
    expect(urls).toContain("https://lichess.org/api/broadcast/-/-/tC-r2");

    const games = second.filter((e) => e.kind === "game");
    const healed = games.find((e) => e.sources[0]?.providerRef === ref);
    // Same provenance ref, so this row replaces the live one on upsert.
    expect(healed?.status).toBe("recent");
    expect(healed?.result).toBe("1-0");
    expect(healed?.participants.map((p) => p.result)).toEqual(["win", "loss"]);

    // Round 2's board is the one live now.
    const nowLive = games.filter((e) => e.status === "live");
    expect(nowLive.map((e) => e.sources[0]?.providerRef)).toEqual(["tC-r2/gC"]);
  });

  it("keeps following the live round when nothing has finished yet", async () => {
    const { fetchImpl, urls } = healingLichess(() => 1);

    await providerFor(fetchImpl).getEvents({ limit: 1 });

    // Two round details for one tournament: the live round and the next one.
    expect(urls.filter((u) => u.includes("/-/-/"))).toHaveLength(2);
  });

  it("respects an explicit request ceiling", async () => {
    const { fetchImpl, urls } = healingLichess(() => 2);
    const provider = new LichessChessProvider({
      client: new LichessClient({
        fetchImpl,
        minIntervalMs: 0,
        maxRetries: 0,
        backoffMs: 0,
      }),
      now: () => NOW,
      maxRoundRequests: 1,
    });

    await provider.getEvents({ limit: 1 });

    expect(urls.filter((u) => u.includes("/-/-/"))).toHaveLength(1);
  });
});

// --- Recovering rounds discovery no longer selects ---------------------------

describe("recoveryRoundIds", () => {
  it("takes the round half of a stored game ref, and a round ref whole", () => {
    expect(recoveryRoundIds(["VhSJZLbt/EBQUS81R", "krWy7u6E"], 10)).toEqual([
      "VhSJZLbt",
      "krWy7u6E",
    ]);
  });

  it("asks for each round once, however many of its boards are stale", () => {
    expect(
      recoveryRoundIds(
        ["VhSJZLbt/g1", "VhSJZLbt/g2", "VhSJZLbt", "krWy7u6E/g1"],
        10,
      ),
    ).toEqual(["VhSJZLbt", "krWy7u6E"]);
  });

  it("refuses anything that is not an id we could have written", () => {
    expect(
      recoveryRoundIds(
        ["", "  ", "/g1", "../../admin", "a b/g1", "a?x=1", "a#f", "%2e%2e", "a".repeat(33)],
        10,
      ),
    ).toEqual([]);
  });

  it("never asks for more rounds than it is allowed", () => {
    const refs = ["r1/g", "r2/g", "r3/g"];
    expect(recoveryRoundIds(refs, 2)).toEqual(["r1", "r2"]);
    expect(recoveryRoundIds(refs, 0)).toEqual([]);
    expect(recoveryRoundIds(refs, -5)).toEqual([]);
    expect(recoveryRoundIds(undefined, 10)).toEqual([]);
  });
});

/**
 * The case this exists for, as it really happened: a board was stored while in
 * progress, its round then finished, and the broadcast dropped out of the active
 * bucket — so discovery stopped selecting it and the row kept claiming to be
 * live. Lichess still answers for the round by id, and that id is on the row.
 */
const STALE_TOUR_ID = "i5CBp85G";
const STALE_ROUND_ID = "VhSJZLbt";
const STALE_GAME_REF = `${STALE_ROUND_ID}/EBQUS81R`;

const DIAGNOSED_PLAYERS = [
  { name: "Castellanos Rodriguez, Renier", title: "GM", fed: "ESP" },
  { name: "Narayanan S L", title: "GM", fed: "IND" },
];

const STALE_TOUR = {
  id: STALE_TOUR_ID,
  name: "CECLUB City of Barbera Open 2026",
  url: `https://lichess.org/broadcast/ceclub/${STALE_TOUR_ID}`,
  tier: 4,
};

/** Finished 16 hours ago, which is why nothing ranks it any more. */
const STALE_ROUND: LichessRound = {
  id: STALE_ROUND_ID,
  name: "Round 4",
  startsAt: NOW_MS - 16 * HOUR,
  url: `https://lichess.org/broadcast/ceclub/round-4/${STALE_ROUND_ID}`,
  finished: true,
};

/** Still to come, so the tournament as a whole is not finished. */
const STALE_TOUR_NEXT_ROUND: LichessRound = {
  id: "nextRnd",
  name: "Round 5",
  startsAt: NOW_MS + 2 * HOUR,
};

/**
 * Lichess as it stands after the round finished: discovery returns only the
 * unrelated broadcast that now outranks it, while the stale round and its
 * tournament page both still answer.
 */
function staleCaseLichess(): { fetchImpl: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("/api/broadcast?page=")) return new Response(PAGE_1);
    if (url.endsWith("/api/broadcast/top")) return new Response(TOP);
    if (url.includes("/api/broadcast/-/-/tA-r1")) return new Response(ROUND_DETAIL);
    if (url.includes(`/api/broadcast/-/-/${STALE_ROUND_ID}`)) {
      return new Response(
        JSON.stringify({
          round: STALE_ROUND,
          tour: STALE_TOUR,
          games: [
            { id: "EBQUS81R", players: DIAGNOSED_PLAYERS, status: "½-½" },
          ],
        }),
      );
    }
    if (url.endsWith(`/api/broadcast/${STALE_TOUR_ID}`)) {
      return new Response(
        JSON.stringify({
          tour: STALE_TOUR,
          rounds: [STALE_ROUND, STALE_TOUR_NEXT_ROUND],
          defaultRoundId: STALE_ROUND_ID,
        }),
      );
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, urls };
}

describe("stale-live round recovery", () => {
  const refresh = {
    lichess: [STALE_GAME_REF, STALE_ROUND_ID],
    // Another provider's ids must never be fetched from Lichess.
    chesscom: ["someEvent/board-2"],
  };

  it("re-reads a stale round by id, before discovery and only its own", async () => {
    const { fetchImpl, urls } = staleCaseLichess();

    await providerFor(fetchImpl).getEvents({ limit: 1, refreshRefs: refresh });

    expect(urls[0]).toBe(
      `https://lichess.org/api/broadcast/-/-/${STALE_ROUND_ID}`,
    );
    // One request for the round, whichever of its rows went stale.
    expect(
      urls.filter((u) => u.endsWith(`/-/-/${STALE_ROUND_ID}`)),
    ).toHaveLength(1);
    expect(urls.some((u) => u.includes("someEvent"))).toBe(false);
    expect(urls.some((u) => u.includes("board-2"))).toBe(false);
  });

  it("replaces the live snapshot with the finished result", async () => {
    const { fetchImpl } = staleCaseLichess();

    const events = await providerFor(fetchImpl).getEvents({
      limit: 1,
      refreshRefs: refresh,
    });

    const healed = events.find(
      (e) => e.sources[0]?.providerRef === STALE_GAME_REF,
    );
    // Same provenance ref as the stored row, so this updates it in place.
    expect(healed?.kind).toBe("game");
    expect(healed?.status).toBe("recent");
    expect(healed?.result).toBe("1/2-1/2");
    expect(healed?.participants.map((p) => p.participantName)).toEqual([
      "Castellanos Rodriguez, Renier",
      "Narayanan S L",
    ]);
    expect(healed?.participants.map((p) => p.result)).toEqual(["draw", "draw"]);
    expect(healed?.relevantCountryIso2).toEqual(["IN"]);
    expect(events.some((e) => e.status === "live" && e.sources[0]?.providerRef?.startsWith(STALE_ROUND_ID))).toBe(false);
  });

  it("completes the tournament rather than call it finished on one round", async () => {
    const { fetchImpl, urls } = staleCaseLichess();

    const competitions = await providerFor(fetchImpl).getCompetitions({
      limit: 1,
      refreshRefs: refresh,
    });

    // Discovery no longer returns this tour, so its round list comes from its own
    // page — without that, one finished round would read as a finished event.
    expect(urls).toContain(
      `https://lichess.org/api/broadcast/${STALE_TOUR_ID}`,
    );
    const healedTour = competitions.find(
      (c) => c.name === "CECLUB City of Barbera Open 2026",
    );
    expect(healedTour?.status).toBe("ongoing");
    expect(healedTour?.relevantCountryIso2).toEqual(["IN"]);
  });

  it("still discovers what it would have discovered anyway", async () => {
    const { fetchImpl, urls } = staleCaseLichess();
    const provider = providerFor(fetchImpl);

    const events = await provider.getEvents({ limit: 1, refreshRefs: refresh });
    const competitions = await provider.getCompetitions({
      limit: 1,
      refreshRefs: refresh,
    });

    expect(urls).toContain("https://lichess.org/api/broadcast?page=1");
    expect(urls).toContain("https://lichess.org/api/broadcast/top");
    expect(urls).toContain("https://lichess.org/api/broadcast/-/-/tA-r1");
    // The discovered broadcast is mapped as usual, alongside the healed one.
    expect(competitions.map((c) => c.name)).toContain("Alpha Masters");
    const live = events.filter((e) => e.kind === "game" && e.status === "live");
    expect(live.map((e) => e.sources[0]?.providerRef)).toEqual(["tA-r1/gA"]);
    // Recovery did not cost the discovered tournament its own slot.
    expect(competitions).toHaveLength(2);
  });

  it("heals nothing extra when there is nothing stale", async () => {
    const { fetchImpl, urls } = staleCaseLichess();

    await providerFor(fetchImpl).getEvents({ limit: 1 });

    expect(urls.some((u) => u.includes(STALE_ROUND_ID))).toBe(false);
    expect(urls.some((u) => u.includes(STALE_TOUR_ID))).toBe(false);
    expect(urls).toHaveLength(3);
  });

  it("cannot spend unbounded requests on a stale backlog", async () => {
    const { fetchImpl, urls } = backlogLichess();

    await providerFor(fetchImpl).getEvents({
      limit: 1,
      refreshRefs: { lichess: BACKLOG_REFS },
    });

    const recovered = urls.filter((u) => /\/-\/-\/r\d+$/.test(u));
    const completions = urls.filter((u) => /\/api\/broadcast\/tour-r\d+$/.test(u));
    const roundDetails = urls.filter((u) => u.includes("/-/-/"));
    // 40 stale rounds, but recovery may spend only a quarter of the 24-request
    // ceiling on rounds, and at most one tournament page each: never more than
    // half the ceiling, however long the backlog is.
    expect(BACKLOG_REFS).toHaveLength(40);
    expect(recovered).toHaveLength(6);
    expect(completions).toHaveLength(6);
    expect(roundDetails.length + completions.length).toBeLessThanOrEqual(24);
    // And no history crawl: still one discovery page and one top.
    expect(urls.filter((u) => u.includes("?page="))).toHaveLength(1);
    expect(urls.filter((u) => u.endsWith("/api/broadcast/top"))).toHaveLength(1);
  });

  it("leaves the rest of that one ceiling to discovery", async () => {
    const { fetchImpl, urls } = backlogLichess();
    const provider = new LichessChessProvider({
      client: new LichessClient({
        fetchImpl,
        minIntervalMs: 0,
        maxRetries: 0,
        backoffMs: 0,
      }),
      now: () => NOW,
      maxRoundRequests: 4,
    });

    await provider.getEvents({ limit: 1, refreshRefs: { lichess: BACKLOG_REFS } });

    // A quarter of four is one round, plus one page to complete its tournament.
    expect(urls.filter((u) => /\/-\/-\/r\d+$/.test(u))).toHaveLength(1);
    expect(urls.filter((u) => /\/api\/broadcast\/tour-r\d+$/.test(u))).toHaveLength(1);
    // The two the ceiling still allows go to discovery, which needs one.
    expect(urls).toContain("https://lichess.org/api/broadcast/-/-/tA-r1");
    expect(urls.filter((u) => u.includes("/-/-/"))).toHaveLength(2);
  });
});

/** A long backlog: 40 stale rounds, each in a tournament discovery has dropped. */
const BACKLOG_REFS = Array.from({ length: 40 }, (_, i) => `r${i}/g1`);

function backlogLichess(): { fetchImpl: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const finishedRound = (id: string): LichessRound => ({
    id,
    startsAt: NOW_MS - 2 * HOUR,
    finished: true,
  });
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("/api/broadcast?page=")) return new Response(PAGE_1);
    if (url.endsWith("/api/broadcast/top")) return new Response(TOP);
    if (url.includes("/api/broadcast/-/-/tA-r1")) return new Response(ROUND_DETAIL);
    const roundId = /\/api\/broadcast\/-\/-\/(r\d+)$/.exec(url)?.[1];
    if (roundId !== undefined) {
      return new Response(
        JSON.stringify({
          round: finishedRound(roundId),
          tour: { id: `tour-${roundId}`, name: `Backlog ${roundId}` },
          games: [{ id: "g1", players: PLAYERS, status: "1-0" }],
        }),
      );
    }
    const tourId = /\/api\/broadcast\/(tour-r\d+)$/.exec(url)?.[1];
    if (tourId !== undefined) {
      const round = tourId.slice("tour-".length);
      return new Response(
        JSON.stringify({
          tour: { id: tourId, name: `Backlog ${round}` },
          rounds: [finishedRound(round)],
        }),
      );
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, urls };
}
