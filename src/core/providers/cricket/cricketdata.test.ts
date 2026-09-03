import { describe, expect, it } from "vitest";

import { getProviders } from "@/core/providers/registry";

import { CricketDataClient } from "./cricketdata-client";
import {
  CricketDataProvider,
  type CricketDataProviderOptions,
  quarterAllowance,
  recoveryMatchIds,
} from "./cricketdata";

/**
 * Provider behaviour, against an injected fetch. No network, no database.
 *
 * `paths` records every call as "endpoint?params" with the API key stripped, so
 * each test can assert exactly which requests a cycle made — the point of a
 * provider whose free plan allows 100 requests a DAY.
 */

const KEY = "secret-key-abc123";
const NOW = new Date("2026-09-03T12:00:00.000Z");
const SERIES_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LIVE_ID = "11111111-1111-4111-8111-111111111111";
const UPCOMING_ID = "22222222-2222-4222-8222-222222222222";
const DONE_ID = "33333333-3333-4333-8333-333333333333";

const envelope = (data: unknown, info?: Record<string, number>): string =>
  JSON.stringify({ apikey: KEY, status: "success", data, info });

const LIVE = {
  id: LIVE_ID,
  name: "India vs Australia, 2nd ODI",
  status: "India need 42 runs in 30 balls",
  dateTimeGMT: "2026-09-03T09:00:00",
  teams: ["India", "Australia"],
  score: [{ r: 233, w: 4, o: 45.2, inning: "India Inning 1" }],
  series_id: SERIES_ID,
  matchStarted: true,
  matchEnded: false,
};

const UPCOMING = {
  id: UPCOMING_ID,
  name: "Nepal vs Netherlands, 1st T20I",
  dateTimeGMT: "2026-09-09T10:00:00",
  teams: ["Nepal", "Netherlands"],
  series_id: SERIES_ID,
  matchStarted: false,
  matchEnded: false,
};

const DONE = {
  id: DONE_ID,
  name: "Namibia Women vs Uganda Women, 3rd Match",
  status: "Namibia Women won by 5 wkts",
  dateTimeGMT: "2026-09-01T08:00:00",
  teams: ["Namibia Women", "Uganda Women"],
  series_id: SERIES_ID,
  matchStarted: true,
  matchEnded: true,
};

const SERIES = {
  id: SERIES_ID,
  name: "India tour of Australia, 2026",
  startDate: "2026-08-28",
  endDate: "Sep 20",
  matches: 3,
};

type Handler = (params: URLSearchParams) => Response;

interface FakeApi {
  fetchImpl: typeof fetch;
  paths: string[];
}

/** Routes by endpoint name; anything unrouted answers with an empty page. */
function fakeApi(routes: Record<string, Handler>): FakeApi {
  const api: FakeApi = {
    paths: [],
    fetchImpl: (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const endpoint = url.pathname.split("/").pop() ?? "";
      const params = new URLSearchParams(url.searchParams);
      // Proves the key was sent, and keeps it out of the recorded path.
      expect(params.get("apikey")).toBe(KEY);
      params.delete("apikey");
      const query = params.toString();
      api.paths.push(query === "" ? endpoint : `${endpoint}?${query}`);
      return (routes[endpoint] ?? (() => new Response(envelope([]))))(params);
    }) as typeof fetch,
  };
  return api;
}

const fullSeason = (): Record<string, Handler> => ({
  currentMatches: () => new Response(envelope([LIVE])),
  matches: () => new Response(envelope([UPCOMING, DONE])),
  series: () => new Response(envelope([SERIES])),
});

function clientFor(api: FakeApi, apiKey: string | null = KEY): CricketDataClient {
  return new CricketDataClient({
    apiKey,
    fetchImpl: api.fetchImpl,
    minIntervalMs: 0,
    maxRetries: 0,
    backoffMs: 0,
  });
}

function providerFor(
  client: CricketDataClient,
  options: CricketDataProviderOptions = {},
): CricketDataProvider {
  return new CricketDataProvider({ client, now: () => NOW, ...options });
}

describe("CricketDataProvider — credentials", () => {
  it("fails health with no request when the key is missing", async () => {
    const api = fakeApi(fullSeason());
    const provider = providerFor(clientFor(api, null));

    const health = await provider.health();

    expect(health.ok).toBe(false);
    expect(health.detail).toBe("CRICKETDATA_API_KEY is not configured");
    expect(health.checkedAt).toEqual(NOW);
    expect(api.paths).toEqual([]);
  });

  it("reads empty rather than throwing, so nothing is fetched or written", async () => {
    const api = fakeApi(fullSeason());
    const client = clientFor(api, null);
    const provider = providerFor(client);

    expect(await provider.getEvents()).toEqual([]);
    expect(await provider.getCompetitions()).toEqual([]);
    expect(await provider.getParticipants()).toEqual([]);
    expect(api.paths).toEqual([]);
    expect(client.requestsMade).toBe(0);
  });

  it("is registered as the primary cricket provider, with TheSportsDB behind it", () => {
    expect(getProviders("cricket").map((provider) => provider.id)).toEqual([
      "cricketdata",
      "thesportsdb",
    ]);
    expect(getProviders("cricket")[0]?.capabilities).toEqual({
      liveEvents: true,
      upcomingEvents: true,
      recentEvents: true,
      tournamentDiscovery: true,
      participants: true,
    });
  });
});

describe("CricketDataProvider — discovery", () => {
  it("runs one cycle and shares it across all three read methods", async () => {
    const api = fakeApi(fullSeason());
    const client = clientFor(api);
    const provider = providerFor(client);

    const events = await provider.getEvents();
    const competitions = await provider.getCompetitions();
    const participants = await provider.getParticipants();

    expect(api.paths).toEqual([
      "currentMatches?offset=0",
      "matches?offset=0",
      "series?offset=0",
    ]);
    expect(client.requestsMade).toBe(3);
    expect(events.map((event) => event.status)).toEqual([
      "live",
      "upcoming",
      "recent",
    ]);
    expect(events.every((event) => event.kind === "match")).toBe(true);
    expect(competitions.map((competition) => competition.name)).toEqual([SERIES.name]);
    expect(competitions[0]?.kind).toBe("series");
    expect(participants.map((team) => team.name)).toEqual([
      "India",
      "Australia",
      "Nepal",
      "Netherlands",
      "Namibia Women",
      "Uganda Women",
    ]);
  });

  it("keeps the live feed's scores when the fixture list repeats a match", async () => {
    // `/matches` carries no `score`, so a later sighting must not overwrite one.
    const api = fakeApi({
      currentMatches: () => new Response(envelope([LIVE])),
      matches: () => new Response(envelope([{ ...LIVE, score: undefined }])),
      series: () => new Response(envelope([SERIES])),
    });
    const provider = providerFor(clientFor(api));

    const events = await provider.getEvents();

    expect(events).toHaveLength(1);
    expect(events[0]?.participants[0]?.score).toBe("233/4 (45.2)");
  });

  it("looks up a series the index did not cover, bounded, and names its matches", async () => {
    const other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const extra = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const api = fakeApi({
      currentMatches: () =>
        new Response(
          envelope([
            { ...LIVE, series_id: other },
            { ...UPCOMING, series_id: extra },
          ]),
        ),
      series: () => new Response(envelope([])),
      series_info: (params) =>
        new Response(
          envelope({
            info: { id: params.get("id"), name: `Series ${params.get("id")}`, startdate: "2026-08-28", matches: 1 },
            // matchList entries carry no series_id of their own.
            matchList: [{ ...DONE, series_id: undefined }],
          }),
        ),
    });
    const provider = providerFor(clientFor(api), { maxRequests: 5 });

    const events = await provider.getEvents();

    // 5/4 = 1 lookup allowed, so only the first unknown series is resolved.
    expect(api.paths.filter((path) => path.startsWith("series_info"))).toEqual([
      `series_info?id=${other}`,
    ]);
    expect(events.find((event) => event.sources[0]?.providerRef === LIVE_ID)?.competitionName).toBe(
      `Series ${other}`,
    );
    expect(events.find((event) => event.sources[0]?.providerRef === UPCOMING_ID)?.competitionName).toBeNull();
    // The match that arrived inside series_info is attributed to that series.
    expect(events.find((event) => event.sources[0]?.providerRef === DONE_ID)?.competitionName).toBe(
      `Series ${other}`,
    );
  });

  it("re-reads stored refs first and treats the cache key as including them", async () => {
    const api = fakeApi({
      ...fullSeason(),
      match_info: (params) =>
        new Response(envelope({ ...DONE, id: params.get("id"), status: "Match tied" })),
    });
    const client = clientFor(api);
    const provider = providerFor(client, { maxRequests: 8 });

    const healed = await provider.getEvents({
      refreshRefs: { cricketdata: [DONE_ID, "not-a-cricketdata-ref"] },
    });

    expect(api.paths[0]).toBe(`match_info?id=${DONE_ID}`);
    expect(healed.find((event) => event.sources[0]?.providerRef === DONE_ID)?.result).toBe(
      "Match tied",
    );

    // A different recovery set must not be served the cached snapshot.
    const before = client.requestsMade;
    await provider.getEvents({ refreshRefs: { cricketdata: [LIVE_ID] } });
    expect(client.requestsMade).toBeGreaterThan(before);
    // ...but the same query within the TTL costs nothing.
    const after = client.requestsMade;
    await provider.getEvents({ refreshRefs: { cricketdata: [LIVE_ID] } });
    expect(client.requestsMade).toBe(after);
  });
});

describe("CricketDataProvider — request bounds", () => {
  const page = (row: object, count = 25): unknown[] =>
    Array.from({ length: count }, (_, index) => ({ ...row, id: `${index}-${JSON.stringify(row).length}` }));

  it("never exceeds the per-cycle ceiling, however many pages are configured", async () => {
    const api = fakeApi({
      currentMatches: () => new Response(envelope(page(LIVE))),
      matches: () => new Response(envelope(page(UPCOMING))),
      series: () => new Response(envelope(page(SERIES))),
    });
    const client = clientFor(api);
    const provider = providerFor(client, {
      currentPages: 4,
      fixturePages: 6,
      seriesPages: 6,
      maxRequests: 4,
    });

    await provider.getEvents();

    expect(client.requestsMade).toBe(4);
    expect(api.paths).toHaveLength(4);
  });

  it("stops paging as soon as a page comes back short", async () => {
    const api = fakeApi(fullSeason());
    const client = clientFor(api);
    const provider = providerFor(client, {
      currentPages: 3,
      fixturePages: 3,
      seriesPages: 3,
    });

    await provider.getEvents();

    expect(api.paths).toEqual([
      "currentMatches?offset=0",
      "matches?offset=0",
      "series?offset=0",
    ]);
  });

  it("caps the rows it keeps", async () => {
    const api = fakeApi({
      currentMatches: () => new Response(envelope(page(LIVE))),
    });
    const provider = providerFor(clientFor(api), {
      maxMatches: 5,
      currentPages: 1,
      fixturePages: 0,
      seriesPages: 0,
    });

    expect(await provider.getEvents()).toHaveLength(5);
  });

  it("bounds discovered competitions with query.limit", async () => {
    const api = fakeApi({
      currentMatches: () => new Response(envelope([])),
      series: () =>
        new Response(
          envelope([SERIES, { ...SERIES, id: "bbbb", name: "Second" }, { ...SERIES, id: "cccc", name: "Third" }]),
        ),
    });
    const provider = providerFor(clientFor(api), { fixturePages: 0 });

    expect(await provider.getCompetitions({ limit: 2 })).toHaveLength(2);
  });

  it("refuses to start a cycle once the daily quota is spent", async () => {
    const api = fakeApi({
      currentMatches: () => new Response(envelope([LIVE], { hitsToday: 100, hitsLimit: 100 })),
      matches: () => new Response(envelope([])),
      series: () => new Response(envelope([])),
    });
    const client = clientFor(api);
    const provider = providerFor(client, { snapshotTtlMs: 0, fixturePages: 1 });

    await provider.getEvents();
    expect(client.hitsRemaining).toBe(0);
    // The rest of the first cycle was skipped rather than sent.
    expect(api.paths).toEqual(["currentMatches?offset=0"]);

    const spent = client.requestsMade;
    await expect(provider.getEvents()).rejects.toThrow(/quota is exhausted/);
    expect(client.requestsMade).toBe(spent);
  });
});

describe("CricketDataProvider — query mapping", () => {
  const provider = (): CricketDataProvider => providerFor(clientFor(fakeApi(fullSeason())));

  it("filters events by country against the relevance index", async () => {
    const events = await provider().getEvents({ country: "in" });
    expect(events.map((event) => event.sources[0]?.providerRef)).toEqual([LIVE_ID]);
  });

  it("filters events by status", async () => {
    const events = await provider().getEvents({ status: ["upcoming", "recent"] });
    expect(events.map((event) => event.status)).toEqual(["upcoming", "recent"]);
  });

  it("filters events by since and until", async () => {
    const target = provider();
    const since = await target.getEvents({ since: new Date("2026-09-02T00:00:00.000Z") });
    expect(since.map((event) => event.sources[0]?.providerRef)).toEqual([
      LIVE_ID,
      UPCOMING_ID,
    ]);

    const until = await target.getEvents({ until: new Date("2026-09-03T23:59:00.000Z") });
    expect(until.map((event) => event.sources[0]?.providerRef)).toEqual([LIVE_ID, DONE_ID]);
  });

  it("narrows events and participants by participantRefs", async () => {
    const target = provider();
    const events = await target.getEvents({ participantRefs: ["  nepal "] });
    expect(events.map((event) => event.sources[0]?.providerRef)).toEqual([UPCOMING_ID]);
    expect(await target.getParticipants({ participantRefs: ["India"] })).toHaveLength(1);
  });

  it("filters competitions and participants by country", async () => {
    const target = provider();
    expect(await target.getCompetitions({ country: "IN" })).toHaveLength(1);
    expect(await target.getCompetitions({ country: "AU" })).toHaveLength(0);
    expect((await target.getParticipants({ country: "IN" })).map((team) => team.name)).toEqual([
      "India",
    ]);
  });
});

describe("CricketDataProvider — health", () => {
  it("reports the cached snapshot without spending a request", async () => {
    const api = fakeApi(fullSeason());
    const client = clientFor(api);
    const provider = providerFor(client);

    expect(await provider.health()).toMatchObject({ ok: true, detail: "not yet fetched" });
    await provider.getEvents();
    const spent = client.requestsMade;

    expect(await provider.health()).toMatchObject({ ok: true, detail: "snapshot cached" });
    expect(client.requestsMade).toBe(spent);
  });

  it("goes unhealthy when the live feed fails, and writes nothing", async () => {
    const api = fakeApi({
      currentMatches: () => new Response("boom", { status: 500 }),
    });
    const provider = providerFor(clientFor(api));

    await expect(provider.getEvents()).rejects.toThrow(/CricketData HTTP 500/);

    const health = await provider.health();
    expect(health.ok).toBe(false);
    expect(health.detail).toContain("/currentMatches?offset=0");
    expect(health.detail).not.toContain(KEY);
  });

  it("stays healthy when only a supplementary call fails", async () => {
    const api = fakeApi({
      currentMatches: () => new Response(envelope([LIVE])),
      matches: () => new Response("boom", { status: 500 }),
      series: () => new Response("boom", { status: 500 }),
    });
    const provider = providerFor(clientFor(api));

    const events = await provider.getEvents();

    expect(events).toHaveLength(1);
    // The series index never loaded, so the name is absent — not invented.
    expect(events[0]?.competitionName).toBeNull();
    expect((await provider.health()).ok).toBe(true);
  });
});

describe("recoveryMatchIds", () => {
  it("keeps only refs this provider could have written, de-duplicated and bounded", () => {
    expect(
      recoveryMatchIds([LIVE_ID, LIVE_ID.toUpperCase(), "abc", `${DONE_ID}`], 5),
    ).toEqual([LIVE_ID, DONE_ID]);
    expect(recoveryMatchIds([LIVE_ID, DONE_ID], 1)).toEqual([LIVE_ID]);
    expect(recoveryMatchIds(undefined, 5)).toEqual([]);
    expect(recoveryMatchIds([LIVE_ID], 0)).toEqual([]);
  });

  it("gives recovery a quarter of the cycle", () => {
    expect(quarterAllowance(8)).toBe(2);
    expect(quarterAllowance(3)).toBe(0);
    expect(quarterAllowance(-1)).toBe(0);
  });
});
