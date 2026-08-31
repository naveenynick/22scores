import { describe, expect, it } from "vitest";

import {
  classifyIndianGm,
  mapTournament,
  parseGameResult,
  playerCountryIso2,
  type LichessTournamentBundle,
} from "@/core/providers/chess/lichess-mapper";
import { mergeSources, toSourceRows } from "@/core/ingest/persist";
import {
  CHESS_GAME_LINK_LABELS,
  resolveExternalEventLink,
} from "@/lib/external-links";
import type {
  LichessGame,
  LichessRound,
  LichessTour,
} from "@/core/providers/chess/lichess-schemas";

const NOW = new Date("2026-08-31T12:00:00.000Z");
const FETCHED = new Date("2026-08-31T12:00:05.000Z");
const R1_START = Date.UTC(2026, 7, 30, 9, 0, 0); // 30 Aug 2026, played
const R2_START = Date.UTC(2026, 8, 2, 9, 0, 0); // 2 Sep 2026, to come

const GUKESH = { name: "Gukesh D", title: "GM", fed: "IND", fideId: 46616543 };
const CARLSEN = { name: "Carlsen, Magnus", title: "GM", fed: "NOR" };
const INDIAN_IM = { name: "Beginner, Ind", title: "IM", fed: "IND" };
const NO_TITLE = { name: "Untitled, Someone", fed: "IND" };
const NO_FED = { name: "Nofed, Grandmaster", title: "GM" };
const NOTHING_KNOWN = { name: "Mystery Player" };

const TOUR: LichessTour = {
  id: "tourABC",
  name: "  Sample  Masters 2026 ",
  slug: "sample-masters",
  url: "https://lichess.org/broadcast/sample-masters/tourABC",
  tier: 4,
  dates: { start: R1_START, end: Date.UTC(2026, 8, 5, 18, 0, 0) },
};

const ROUND_1: LichessRound = {
  id: "rnd1",
  name: "Round 1",
  startsAt: R1_START,
  url: "https://lichess.org/broadcast/sample-masters/round-1/rnd1",
  finished: true,
};

const ROUND_2: LichessRound = {
  id: "rnd2",
  name: "Round 2",
  startsAt: R2_START,
  url: "https://lichess.org/broadcast/sample-masters/round-2/rnd2",
};

function bundle(
  gamesByRoundId: Record<string, LichessGame[]>,
  rounds: LichessRound[] = [ROUND_1, ROUND_2],
): LichessTournamentBundle {
  return { tour: TOUR, rounds, gamesByRoundId, fetchedAt: FETCHED };
}

describe("Indian GM detection", () => {
  it("accepts a confirmed GM with federation IND", () => {
    expect(classifyIndianGm(GUKESH)).toBe("yes");
    expect(playerCountryIso2(GUKESH)).toBe("IN");
  });

  it("accepts a nested federation object", () => {
    expect(classifyIndianGm({ ...GUKESH, fed: { id: "ind" } })).toBe("yes");
  });

  it("rejects an Indian player who is not a GM", () => {
    expect(classifyIndianGm(INDIAN_IM)).toBe("no");
  });

  it("rejects a GM from another federation", () => {
    expect(classifyIndianGm(CARLSEN)).toBe("no");
    expect(playerCountryIso2(CARLSEN)).toBeNull();
  });

  it("treats a missing title or federation as unknown, never as not-Indian", () => {
    expect(classifyIndianGm(NO_TITLE)).toBe("unknown");
    expect(classifyIndianGm(NO_FED)).toBe("unknown");
    expect(classifyIndianGm(NOTHING_KNOWN)).toBe("unknown");
  });
});

describe("game results", () => {
  it("maps decided results and leaves anything else undecided", () => {
    expect(parseGameResult("1-0")).toEqual({
      summary: "1-0",
      perPlayer: ["win", "loss"],
    });
    expect(parseGameResult("½-½")).toEqual({
      summary: "1/2-1/2",
      perPlayer: ["draw", "draw"],
    });
    expect(parseGameResult("*").summary).toBeNull();
    expect(parseGameResult(undefined).summary).toBeNull();
  });
});

describe("mapping a broadcast tournament", () => {
  const mapped = mapTournament(
    bundle({
      rnd1: [
        { id: "g1", players: [GUKESH, CARLSEN], status: "1-0" },
        { id: "g2", players: [INDIAN_IM, NOTHING_KNOWN], status: "½-½" },
      ],
    }),
    NOW,
  );

  it("normalizes tournament metadata without inventing anything", () => {
    const { competition } = mapped;
    expect(competition.sport).toBe("chess");
    expect(competition.kind).toBe("tournament");
    expect(competition.name).toBe("Sample Masters 2026");
    expect(competition.startDate?.getTime()).toBe(R1_START);
    expect(competition.hostCountryIso2).toBeNull();
    expect(competition.sources).toEqual([
      {
        provider: "lichess",
        providerRef: "tourABC",
        fetchedAt: FETCHED,
        url: TOUR.url,
      },
    ]);
  });

  it("derives status from round flags (round 2 has not been played)", () => {
    expect(mapped.competition.status).toBe("ongoing");
  });

  it("creates one round event per advertised round plus one per game", () => {
    const rounds = mapped.events.filter((e) => e.kind === "round");
    const games = mapped.events.filter((e) => e.kind === "game");
    expect(rounds).toHaveLength(2);
    expect(games).toHaveLength(2);
    expect(rounds.map((r) => r.sources[0]?.providerRef)).toEqual([
      "rnd1",
      "rnd2",
    ]);
    expect(games.map((g) => g.sources[0]?.providerRef)).toEqual([
      "rnd1/g1",
      "rnd1/g2",
    ]);
    // The unplayed round is upcoming; the played one is recent, not live.
    expect(rounds[0]?.status).toBe("recent");
    expect(rounds[1]?.status).toBe("upcoming");
  });

  it("preserves white/black roles and per-player results", () => {
    const game = mapped.events.find(
      (e) => e.sources[0]?.providerRef === "rnd1/g1",
    );
    expect(game?.result).toBe("1-0");
    expect(game?.startTime?.getTime()).toBe(R1_START);
    expect(game?.participants).toEqual([
      {
        participantName: "Gukesh D",
        countryIso2: "IN",
        title: "GM",
        role: "white",
        score: null,
        result: "win",
        position: null,
      },
      {
        participantName: "Carlsen, Magnus",
        countryIso2: null,
        title: "GM",
        role: "black",
        score: null,
        result: "loss",
        position: null,
      },
    ]);
  });

  it("records every discovered player as a tournament entrant", () => {
    expect(mapped.competition.participants).toHaveLength(4);
    const gukesh = mapped.competition.participants.find(
      (p) => p.participantName === "Gukesh D",
    );
    expect(gukesh).toEqual({
      participantName: "Gukesh D",
      countryIso2: "IN",
      title: "GM",
      status: "entered",
      finalRank: null,
    });
    // Unknown title/federation stays unknown rather than being filled in.
    expect(
      mapped.competition.participants.find(
        (p) => p.participantName === "Mystery Player",
      ),
    ).toEqual({
      participantName: "Mystery Player",
      countryIso2: null,
      title: null,
      status: "entered",
      finalRank: null,
    });
  });

  it("marks India relevance only where a GM + IND player actually plays", () => {
    expect(mapped.competition.relevantCountryIso2).toEqual(["IN"]);
    const byRef = new Map(
      mapped.events.map((e) => [e.sources[0]?.providerRef, e]),
    );
    expect(byRef.get("rnd1/g1")?.relevantCountryIso2).toEqual(["IN"]);
    expect(byRef.get("rnd1/g2")?.relevantCountryIso2).toEqual([]);
    expect(byRef.get("rnd1")?.relevantCountryIso2).toEqual(["IN"]);
    expect(byRef.get("rnd2")?.relevantCountryIso2).toEqual([]);
  });

  it("keeps a live round's games live", () => {
    const live = mapTournament(
      bundle({ rnd9: [{ id: "g9", players: [GUKESH, CARLSEN], status: "*" }] }, [
        { id: "rnd9", startsAt: R1_START, ongoing: true },
      ]),
      NOW,
    );
    expect(live.competition.status).toBe("ongoing");
    expect(live.events.map((e) => e.status)).toEqual(["live", "live"]);
    expect(live.events[1]?.result).toBeNull();
  });
});

describe("tournaments with no games yet", () => {
  const upcoming = mapTournament(
    {
      tour: { id: "tourNew", name: "Future Open 2027", dates: [R2_START, null] },
      rounds: [{ id: "fut1", startsAt: R2_START }],
      gamesByRoundId: {},
      fetchedAt: FETCHED,
    },
    NOW,
  );

  it("is still ingested, with relevance left to backfill", () => {
    expect(upcoming.competition.status).toBe("upcoming");
    expect(upcoming.competition.startDate?.getTime()).toBe(R2_START);
    expect(upcoming.competition.endDate).toBeNull();
    expect(upcoming.competition.participants).toEqual([]);
    expect(upcoming.competition.relevantCountryIso2).toEqual([]);
    expect(upcoming.events).toHaveLength(1);
    expect(upcoming.events[0]?.kind).toBe("round");
  });
});

describe("repeated syncs", () => {
  it("re-derives identical provider identities, so writes update in place", () => {
    const first = mapTournament(
      bundle({ rnd1: [{ id: "g1", players: [GUKESH, CARLSEN], status: "*" }] }),
      NOW,
    );
    const later = mapTournament(
      {
        ...bundle({
          rnd1: [{ id: "g1", players: [GUKESH, CARLSEN], status: "1-0" }],
        }),
        fetchedAt: new Date(FETCHED.getTime() + 3_600_000),
      },
      new Date(NOW.getTime() + 3_600_000),
    );

    const refs = (m: typeof first) =>
      m.events.map((e) => e.sources.map((s) => s.providerRef).join(","));
    expect(refs(later)).toEqual(refs(first));

    // Persistence merges by (provider, providerRef): one row, newest fetch.
    const merged = mergeSources(
      toSourceRows(first.competition.sources),
      toSourceRows(later.competition.sources),
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]?.fetchedAt).toBe(
      new Date(FETCHED.getTime() + 3_600_000).toISOString(),
    );
  });
});

/**
 * The stored side of the outbound-link contract, proved on real mapper output:
 * ingestion keeps the round's page as the URL and the board's id in the ref, and
 * that is exactly what the link layer needs to reach one board out of many.
 */
describe("linking a mapped board", () => {
  const mapped = mapTournament(
    bundle({
      rnd1: [
        { id: "g1", players: [GUKESH, CARLSEN], status: "1-0" },
        { id: "g2", players: [INDIAN_IM, NOTHING_KNOWN], status: "*" },
      ],
    }),
    NOW,
  );

  const linkFor = (ref: string, isLive: boolean) => {
    const event = mapped.events.find((e) => e.sources[0]?.providerRef === ref);
    return resolveExternalEventLink({
      sources: (event?.sources ?? []).map((s) => ({
        provider: s.provider,
        providerRef: s.providerRef,
        url: s.url ?? null,
      })),
      isLive,
      labels: CHESS_GAME_LINK_LABELS,
    });
  };

  it("stores the round page and the board id, not one merged string", () => {
    const game = mapped.events.find((e) => e.sources[0]?.providerRef === "rnd1/g1");
    expect(game?.sources[0]?.url).toBe(ROUND_1.url);
    expect(game?.sources[0]?.providerRef).toBe("rnd1/g1");
  });

  it("resolves the two boards of one round to two different URLs", () => {
    const finished = linkFor("rnd1/g1", false);
    const live = linkFor("rnd1/g2", true);

    expect(finished?.href).toBe(`${ROUND_1.url}/g1`);
    expect(live?.href).toBe(`${ROUND_1.url}/g2`);
    expect(finished?.href).not.toBe(live?.href);
    expect(finished?.label).toBe("View game");
    expect(live?.label).toBe("Watch now");
  });

  it("leaves the round container pointing at the round", () => {
    expect(linkFor("rnd1", false)?.href).toBe(ROUND_1.url);
  });
});
