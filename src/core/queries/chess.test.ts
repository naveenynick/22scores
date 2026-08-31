import { describe, expect, it } from "vitest";

import {
  assembleGames,
  assembleTournaments,
  getChessCountryOverview,
  getIndiaChessOverview,
  getLiveChessGames,
  getOngoingChessTournaments,
  getRecentChessGames,
  getUpcomingChessTournaments,
  latestFetchedAt,
  normalizeCountryIso2,
  orderSides,
  summarizeRounds,
  toCanonicalSources,
  type ChessCountryOverview,
} from "@/core/queries/chess";
import type {
  ChessReader,
  CompetitionRoundRow,
  GameRow,
  GameSideRow,
  TournamentGmRow,
  TournamentRow,
} from "@/core/queries/chess-reader";

/**
 * The query layer is tested through an in-memory `ChessReader`, so these tests
 * assert the things the layer is actually responsible for: which statuses it
 * asks for, that children are fetched in ONE batch (no N+1), how rows are
 * assembled, and that nothing is invented. The reader's SQL is exercised
 * against the live database by the /api/india/chess endpoint.
 */

const FETCHED = "2026-08-31T12:00:05.000Z";

function tournament(
  id: string,
  status: TournamentRow["status"],
  startDate: Date | null = null,
): TournamentRow {
  return {
    id,
    name: `Tournament ${id}`,
    kind: "tournament",
    status,
    startDate,
    endDate: null,
    sources: [{ provider: "lichess", providerRef: id, fetchedAt: FETCHED }],
  };
}

function gmRow(
  competitionId: string,
  name: string,
  finalRank: number | null = null,
): TournamentGmRow {
  return {
    competitionId,
    name,
    title: "GM",
    countryIso2: "IN",
    entryStatus: "entered",
    finalRank,
  };
}

function game(
  id: string,
  status: GameRow["status"],
  result: string | null,
  startTime: Date | null = null,
): GameRow {
  return {
    id,
    status,
    startTime,
    result,
    competitionName: "Linares 2026",
    sources: [
      {
        provider: "lichess",
        providerRef: `rnd1/${id}`,
        fetchedAt: FETCHED,
        url: `https://lichess.org/broadcast/${id}`,
      },
    ],
  };
}

function side(
  eventId: string,
  name: string,
  role: string | null,
  result: string | null,
  extra: {
    title?: string | null;
    countryIso2?: string | null;
    position?: number | null;
  } = {},
): GameSideRow {
  return {
    eventId,
    name,
    title: extra.title === undefined ? "GM" : extra.title,
    countryIso2: extra.countryIso2 === undefined ? "IN" : extra.countryIso2,
    role,
    score: null,
    result,
    position: extra.position ?? null,
  };
}

function round(
  competitionId: string,
  status: CompetitionRoundRow["status"],
  startTime: Date | null = null,
): CompetitionRoundRow {
  return { competitionId, status, startTime };
}

interface ReaderCall {
  fn: keyof ChessReader;
  args: Record<string, unknown>;
}

/** Records every read so batching and filtering can be asserted exactly. */
function fakeReader(
  data: {
    tournaments?: TournamentRow[];
    gms?: TournamentGmRow[];
    rounds?: CompetitionRoundRow[];
    games?: GameRow[];
    sides?: GameSideRow[];
  } = {},
): { reader: ChessReader; calls: ReaderCall[] } {
  const calls: ReaderCall[] = [];
  const reader: ChessReader = {
    async tournaments(query) {
      calls.push({ fn: "tournaments", args: { ...query } });
      return (data.tournaments ?? [])
        .filter((row) => query.statuses.includes(row.status))
        .slice(0, query.limit);
    },
    async tournamentGms(query) {
      calls.push({ fn: "tournamentGms", args: { ...query } });
      return (data.gms ?? []).filter((row) =>
        query.competitionIds.includes(row.competitionId),
      );
    },
    async competitionRounds(query) {
      calls.push({ fn: "competitionRounds", args: { ...query } });
      return (data.rounds ?? []).filter((row) =>
        query.competitionIds.includes(row.competitionId),
      );
    },
    async games(query) {
      calls.push({ fn: "games", args: { ...query } });
      return (data.games ?? [])
        .filter((row) => query.statuses.includes(row.status))
        .slice(0, query.limit);
    },
    async gameSides(query) {
      calls.push({ fn: "gameSides", args: { ...query } });
      return (data.sides ?? []).filter((row) =>
        query.eventIds.includes(row.eventId),
      );
    },
  };
  return { reader, calls };
}

const TOURNAMENTS = [
  tournament("c1", "ongoing", new Date("2026-08-25T09:00:00.000Z")),
  tournament("c2", "ongoing", new Date("2026-08-20T09:00:00.000Z")),
  tournament("c3", "upcoming", new Date("2026-09-10T09:00:00.000Z")),
  tournament("c4", "finished", new Date("2026-07-01T09:00:00.000Z")),
];

const GMS = [
  gmRow("c1", "Narayanan S L"),
  gmRow("c1", "Puranik, Abhimanyu"),
  gmRow("c2", "Gukesh D", 1),
  gmRow("c3", "Erigaisi Arjun"),
  // Belongs to a tournament that is never selected: must not leak anywhere.
  gmRow("c9", "Someone Else"),
];

const ROUNDS = [
  round("c1", "recent", new Date("2026-08-25T09:00:00.000Z")),
  round("c1", "finished", new Date("2026-08-24T09:00:00.000Z")),
  round("c1", "live", new Date("2026-08-26T09:00:00.000Z")),
  round("c1", "upcoming", new Date("2026-08-28T09:00:00.000Z")),
  round("c1", "upcoming", null),
  // Same leak guard as the entrants: c9 is never selected.
  round("c9", "live", new Date("2026-08-26T09:00:00.000Z")),
];

describe("ongoing tournaments", () => {
  it("asks for ongoing only and fetches all entrants in one batch", async () => {
    const { reader, calls } = fakeReader({
      tournaments: TOURNAMENTS,
      gms: GMS,
      rounds: ROUNDS,
    });

    const result = await getOngoingChessTournaments(reader, {
      countryIso2: "in", // lower case on purpose
    });

    expect(result.map((t) => t.id)).toEqual(["c1", "c2"]);
    // Three reads for two tournaments — the N+1 guard.
    expect(calls).toEqual([
      {
        fn: "tournaments",
        args: {
          countryIso2: "IN",
          statuses: ["ongoing"],
          order: "desc",
          limit: 25,
        },
      },
      {
        fn: "tournamentGms",
        args: { competitionIds: ["c1", "c2"], countryIso2: "IN" },
      },
      {
        fn: "competitionRounds",
        args: { competitionIds: ["c1", "c2"] },
      },
    ]);

    expect(result[0]?.gms.map((g) => g.name)).toEqual([
      "Narayanan S L",
      "Puranik, Abhimanyu",
    ]);
    expect(result[1]?.gms).toEqual([
      {
        name: "Gukesh D",
        title: "GM",
        countryIso2: "IN",
        entryStatus: "entered",
        finalRank: 1,
      },
    ]);
    expect(result[0]?.relevantCountryIso2).toBe("IN");
    expect(result[0]?.sources).toEqual([
      { provider: "lichess", providerRef: "c1", url: null, fetchedAt: FETCHED },
    ]);
  });

  it("counts each tournament's own rounds and leaves unknown ones null", async () => {
    const { reader } = fakeReader({
      tournaments: TOURNAMENTS,
      rounds: ROUNDS,
    });

    const result = await getOngoingChessTournaments(reader, {
      countryIso2: "IN",
    });

    expect(result[0]?.rounds).toEqual({
      total: 5,
      completed: 2,
      live: 1,
      upcoming: 2,
      nextStartTime: new Date("2026-08-26T09:00:00.000Z"),
    });
    // c2 has no stored rounds: unknown, not "zero rounds".
    expect(result[1]?.rounds).toBeNull();
  });
});

describe("upcoming tournaments", () => {
  it("asks for upcoming, soonest first, and honours the limit", async () => {
    const { reader, calls } = fakeReader({ tournaments: TOURNAMENTS, gms: GMS });

    const result = await getUpcomingChessTournaments(reader, {
      countryIso2: "IN",
      limit: 5,
    });

    expect(calls[0]?.args).toEqual({
      countryIso2: "IN",
      statuses: ["upcoming"],
      order: "asc",
      limit: 5,
    });
    expect(result.map((t) => t.id)).toEqual(["c3"]);
    expect(result[0]?.gms.map((g) => g.name)).toEqual(["Erigaisi Arjun"]);
  });

  it("returns nothing and skips the entrant query when there are no rows", async () => {
    const { reader, calls } = fakeReader({ gms: GMS });

    expect(
      await getUpcomingChessTournaments(reader, { countryIso2: "IN" }),
    ).toEqual([]);
    expect(calls.map((c) => c.fn)).toEqual(["tournaments"]);
  });

  it("keeps an entrant list empty rather than inventing entrants", async () => {
    const { reader } = fakeReader({ tournaments: TOURNAMENTS, gms: [] });

    const result = await getUpcomingChessTournaments(reader, {
      countryIso2: "IN",
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.gms).toEqual([]);
    expect(result[0]?.rounds).toBeNull();
    expect(result[0]?.startDate).toEqual(
      new Date("2026-09-10T09:00:00.000Z"),
    );
    expect(result[0]?.endDate).toBeNull();
  });
});

const GAMES = [
  game("g1", "recent", "1-0", new Date("2026-08-30T09:00:00.000Z")),
  game("g2", "live", null, new Date("2026-08-31T09:00:00.000Z")),
  game("g3", "finished", "1/2-1/2", new Date("2026-08-01T09:00:00.000Z")),
  game("g4", "upcoming", null, new Date("2026-09-02T09:00:00.000Z")),
];

const SIDES = [
  // Stored black-first on purpose: board order must be restored, not assumed.
  side("g1", "Warmerdam, Max", "black", "loss", { countryIso2: null }),
  side("g1", "Puranik, Abhimanyu", "white", "win"),
  side("g2", "Narayanan S L", "black", null),
  side("g2", "Castellanos Rodriguez, Renier", "white", null, {
    countryIso2: null,
  }),
  side("g3", "Gukesh D", "white", "draw"),
  side("g3", "Carlsen, Magnus", "black", "draw", { countryIso2: null }),
];

describe("recent games and results", () => {
  it("spans recent and finished, newest first, with one sides query", async () => {
    const { reader, calls } = fakeReader({ games: GAMES, sides: SIDES });

    const result = await getRecentChessGames(reader, { countryIso2: "IN" });

    expect(calls).toEqual([
      {
        fn: "games",
        args: {
          countryIso2: "IN",
          statuses: ["recent", "finished"],
          order: "desc",
          limit: 25,
        },
      },
      { fn: "gameSides", args: { eventIds: ["g1", "g3"] } },
    ]);
    expect(result.map((g) => `${g.status}:${g.result}`)).toEqual([
      "recent:1-0",
      "finished:1/2-1/2",
    ]);
    expect(result[0]?.sides).toEqual([
      {
        name: "Puranik, Abhimanyu",
        title: "GM",
        countryIso2: "IN",
        role: "white",
        score: null,
        result: "win",
        position: null,
      },
      {
        name: "Warmerdam, Max",
        title: "GM",
        countryIso2: null,
        role: "black",
        score: null,
        result: "loss",
        position: null,
      },
    ]);
    expect(result[0]?.competitionName).toBe("Linares 2026");
    expect(result[0]?.sources[0]?.url).toBe(
      "https://lichess.org/broadcast/g1",
    );
  });
});

describe("live games", () => {
  it("asks for live only and leaves an undecided result null", async () => {
    const { reader, calls } = fakeReader({ games: GAMES, sides: SIDES });

    const result = await getLiveChessGames(reader, { countryIso2: "IN" });

    expect(calls[0]?.args).toEqual({
      countryIso2: "IN",
      statuses: ["live"],
      order: "desc",
      limit: 25,
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("g2");
    expect(result[0]?.result).toBeNull();
    expect(result[0]?.sides.map((s) => `${s.role}:${s.name}`)).toEqual([
      "white:Castellanos Rodriguez, Renier",
      "black:Narayanan S L",
    ]);
    expect(result[0]?.sides.every((s) => s.result === null)).toBe(true);
  });

  it("does not assume two sides", async () => {
    const { reader } = fakeReader({
      games: [game("gN", "live", null)],
      sides: [
        side("gN", "Third Player", null, null, { position: 3, title: null }),
        side("gN", "Black Player", "black", null),
        side("gN", "White Player", "white", null),
      ],
    });

    const result = await getLiveChessGames(reader, { countryIso2: "IN" });

    expect(result[0]?.sides.map((s) => s.name)).toEqual([
      "White Player",
      "Black Player",
      "Third Player",
    ]);
    expect(result[0]?.sides[2]).toEqual({
      name: "Third Player",
      title: null,
      countryIso2: "IN",
      role: null,
      score: null,
      result: null,
      position: 3,
    });
  });
});

describe("country overview", () => {
  it("fills all four sections in seven reads, sharing the child batches", async () => {
    const { reader, calls } = fakeReader({
      tournaments: TOURNAMENTS,
      gms: GMS,
      rounds: ROUNDS,
      games: GAMES,
      sides: SIDES,
    });

    const overview = await getChessCountryOverview(reader, {
      countryIso2: "IN",
      limit: 10,
    });

    expect(overview.ongoingTournaments.map((t) => t.id)).toEqual(["c1", "c2"]);
    expect(overview.upcomingTournaments.map((t) => t.id)).toEqual(["c3"]);
    expect(overview.recentGames.map((g) => g.id)).toEqual(["g1", "g3"]);
    expect(overview.liveGames.map((g) => g.id)).toEqual(["g2"]);

    // Four parent lists + one batch per child kind, each fetched exactly once.
    expect(calls).toHaveLength(7);
    expect(calls.filter((c) => c.fn === "tournamentGms")).toEqual([
      {
        fn: "tournamentGms",
        args: { competitionIds: ["c1", "c2", "c3"], countryIso2: "IN" },
      },
    ]);
    expect(calls.filter((c) => c.fn === "competitionRounds")).toEqual([
      { fn: "competitionRounds", args: { competitionIds: ["c1", "c2", "c3"] } },
    ]);
    expect(calls.filter((c) => c.fn === "gameSides")).toEqual([
      { fn: "gameSides", args: { eventIds: ["g2", "g1", "g3"] } },
    ]);

    // Shared batches must still land on the right parent.
    expect(overview.ongoingTournaments[0]?.gms.map((g) => g.name)).toEqual([
      "Narayanan S L",
      "Puranik, Abhimanyu",
    ]);
    expect(overview.ongoingTournaments[0]?.rounds?.total).toBe(5);
    expect(overview.upcomingTournaments[0]?.gms.map((g) => g.name)).toEqual([
      "Erigaisi Arjun",
    ]);
    expect(overview.upcomingTournaments[0]?.rounds).toBeNull();
    expect(overview.liveGames[0]?.sides).toHaveLength(2);
  });

  it("defaults to India and asks for no children when every section is empty", async () => {
    const { reader, calls } = fakeReader({});

    expect(await getIndiaChessOverview(reader)).toEqual({
      countryIso2: "IN",
      ongoingTournaments: [],
      upcomingTournaments: [],
      recentGames: [],
      liveGames: [],
    });
    expect(calls.map((c) => c.fn)).toEqual([
      "tournaments",
      "tournaments",
      "games",
      "games",
    ]);
  });
});

describe("pure helpers", () => {
  it("normalizes a country code", () => {
    expect(normalizeCountryIso2(" in ")).toBe("IN");
  });

  it("normalizes provenance and keeps the fetch time", () => {
    expect(
      toCanonicalSources([
        { provider: "lichess", providerRef: "x", fetchedAt: FETCHED },
      ]),
    ).toEqual([
      { provider: "lichess", providerRef: "x", url: null, fetchedAt: FETCHED },
    ]);
    expect(toCanonicalSources(null)).toEqual([]);
  });

  it("leaves sides with unknown roles in their incoming order", () => {
    const unknown = ["B", "A"].map((name) => ({
      name,
      title: null,
      countryIso2: null,
      role: null,
      score: null,
      result: null,
      position: null,
    }));
    expect(orderSides(unknown).map((s) => s.name)).toEqual(["B", "A"]);
  });

  it("assembles a game that has no recorded sides", () => {
    const [assembled] = assembleGames([game("gz", "upcoming", null)], [], "IN");
    expect(assembled?.sides).toEqual([]);
    expect(assembled?.result).toBeNull();
  });

  it("reports no round progress rather than zero rounds", () => {
    expect(summarizeRounds([])).toBeNull();
  });

  it("prefers an upcoming start only when no round is live", () => {
    expect(
      summarizeRounds([
        round("c1", "upcoming", new Date("2026-09-02T09:00:00.000Z")),
        round("c1", "upcoming", new Date("2026-09-01T09:00:00.000Z")),
      ]),
    ).toEqual({
      total: 2,
      completed: 0,
      live: 0,
      upcoming: 2,
      nextStartTime: new Date("2026-09-01T09:00:00.000Z"),
    });
  });

  it("keeps the next start null when no round has a time", () => {
    expect(summarizeRounds([round("c1", "live"), round("c1", "upcoming")])
      ?.nextStartTime).toBeNull();
  });

  it("reports the newest fetch across every section", () => {
    const older = "2026-08-31T10:00:00.000Z";
    const newest = "2026-08-31T13:30:00.000Z";
    const [ongoing] = assembleTournaments(
      [tournament("c1", "ongoing")],
      [],
      [],
      "IN",
    );
    const [recent] = assembleGames([game("g1", "recent", "1-0")], [], "IN");
    const empty: ChessCountryOverview = {
      countryIso2: "IN",
      ongoingTournaments: [],
      upcomingTournaments: [],
      recentGames: [],
      liveGames: [],
    };

    expect(latestFetchedAt(empty)).toBeNull();
    expect(
      latestFetchedAt({
        ...empty,
        ongoingTournaments: ongoing
          ? [
              {
                ...ongoing,
                sources: [
                  { provider: "p", providerRef: "a", url: null, fetchedAt: older },
                ],
              },
            ]
          : [],
        recentGames: recent
          ? [
              {
                ...recent,
                sources: [
                  {
                    provider: "p",
                    providerRef: "b",
                    url: null,
                    fetchedAt: newest,
                  },
                  { provider: "p", providerRef: "c", url: null, fetchedAt: older },
                ],
              },
            ]
          : [],
      }),
    ).toBe(newest);
  });
});
