import { describe, expect, it } from "vitest";

import {
  CRICKETDATA_PROVIDER_ID,
  deriveSeriesStatus,
  mapMatchToEvent,
  mapSeriesToCompetition,
  mapSnapshot,
  mapTeamToParticipant,
  matchEventStatus,
  matchSides,
  RECENT_WINDOW_MS,
  seriesFromInfo,
  teamCountryIso2,
  teamScore,
} from "./cricketdata-mapper";
import {
  calendarDate,
  CricketDataMatch,
  type CricketDataSeries,
  parseRows,
  utcTimestamp,
} from "./cricketdata-schemas";

/**
 * Mapper behaviour. Pure functions, a fixed clock, no HTTP and no database.
 *
 * The fixtures are shaped after real `/currentMatches`, `/matches` and `/series`
 * payloads, quirks included: `teamInfo` out of order with `teams`, a `teams` array
 * missing a side, a yearless series end date, and result-shaped prose on a match
 * the provider has not yet flagged as ended.
 */

const NOW = new Date("2026-09-03T12:00:00.000Z");
const FETCHED = new Date("2026-09-03T11:59:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const OPTIONS = { fetchedAt: FETCHED, now: NOW };

const SERIES_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const LIVE: CricketDataMatch = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "India vs Australia, 2nd ODI",
  matchType: "odi",
  status: "India need 42 runs in 30 balls",
  venue: "Wankhede Stadium, Mumbai",
  date: "2026-09-03",
  dateTimeGMT: "2026-09-03T09:00:00",
  teams: ["India", "Australia"],
  // Deliberately in the opposite order to `teams`, as the live API returns it.
  teamInfo: [
    { name: "Australia", shortname: "AUS", img: "https://h.cricapi.com/aus.png" },
    { name: "India", shortname: "IND", img: "https://h.cricapi.com/ind.png" },
  ],
  score: [
    { r: 274, w: 8, o: 50, inning: "Australia Inning 1" },
    { r: 233, w: 4, o: 45.2, inning: "India Inning 1" },
  ],
  series_id: SERIES_ID,
  matchStarted: true,
  matchEnded: false,
};

const UPCOMING: CricketDataMatch = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "Nepal vs Netherlands, 1st T20I",
  matchType: "t20",
  status: "Match starts at Sep 09, 10:00 GMT",
  date: "2026-09-09",
  dateTimeGMT: "2026-09-09T10:00:00",
  teams: ["Nepal", "Netherlands"],
  series_id: SERIES_ID,
  matchStarted: false,
  matchEnded: false,
};

const COMPLETED: CricketDataMatch = {
  id: "33333333-3333-4333-8333-333333333333",
  name: "Namibia Women vs Uganda Women, 3rd Match",
  matchType: "t20",
  status: "Namibia Women won by 5 wkts",
  date: "2026-09-01",
  dateTimeGMT: "2026-09-01T08:00:00",
  teams: ["Namibia Women", "Uganda Women"],
  score: [
    { r: 116, w: 9, o: 20, inning: "Uganda Women Inning 1" },
    { r: 117, w: 5, o: 18.4, inning: "Namibia Women Inning 1" },
  ],
  series_id: SERIES_ID,
  matchStarted: true,
  matchEnded: true,
};

const SERIES: CricketDataSeries = {
  id: SERIES_ID,
  name: "India tour of Australia, 2026",
  startDate: "2026-08-28",
  // The real API sends a partial with no year here.
  endDate: "Sep 20",
  odi: 3,
  t20: 0,
  test: 0,
  matches: 3,
};

describe("teamCountryIso2", () => {
  it("resolves national sides and their qualified variants", () => {
    expect(teamCountryIso2("India")).toBe("IN");
    expect(teamCountryIso2("India Women")).toBe("IN");
    expect(teamCountryIso2("India A")).toBe("IN");
    expect(teamCountryIso2("  india   women  ")).toBe("IN");
    expect(teamCountryIso2("Australia")).toBe("AU");
    expect(teamCountryIso2("Hong Kong, China Women")).toBe("HK");
  });

  it("leaves anything not on the allowlist null instead of guessing", () => {
    // No ISO 3166-1 alpha-2 exists for these, so none is invented.
    expect(teamCountryIso2("England")).toBeNull();
    expect(teamCountryIso2("West Indies")).toBeNull();
    expect(teamCountryIso2("Scotland")).toBeNull();
    // Franchise and unknown sides are not pattern-matched onto a country.
    expect(teamCountryIso2("Mumbai Indians")).toBeNull();
    expect(teamCountryIso2("India Warriors")).toBeNull();
    expect(teamCountryIso2("Indianapolis")).toBeNull();
    expect(teamCountryIso2(undefined)).toBeNull();
    expect(teamCountryIso2("")).toBeNull();
  });
});

describe("matchEventStatus", () => {
  const start = new Date("2026-09-01T08:00:00.000Z");
  const ago = (ms: number): Date => new Date(NOW.getTime() - ms);

  it("uses the provider booleans, never the prose", () => {
    expect(matchEventStatus({ matchStarted: true, matchEnded: false }, start, NOW)).toBe("live");
    expect(matchEventStatus({ matchStarted: false, matchEnded: false }, start, NOW)).toBe("upcoming");
    expect(matchEventStatus({}, start, NOW)).toBe("upcoming");
  });

  it("splits completed matches into recent and finished by age", () => {
    const ended = { matchStarted: true, matchEnded: true };
    expect(matchEventStatus(ended, new Date(NOW.getTime() - 2 * DAY), NOW)).toBe("recent");
    expect(matchEventStatus(ended, new Date(NOW.getTime() - 30 * DAY), NOW)).toBe("finished");
    // No start time to age against: "finished" is the honest answer.
    expect(matchEventStatus(ended, null, NOW)).toBe("finished");
  });

  /**
   * The live claim has to age. `matchStarted: true, matchEnded: false` is a state
   * the provider can get stuck in, and re-stamped provenance would let the
   * read-time guard keep confirming it, so the bound belongs here.
   */
  describe("a started, unfinished match", () => {
    const started = { matchStarted: true, matchEnded: false };

    it("is live while its start is inside the window", () => {
      expect(matchEventStatus(started, ago(0), NOW)).toBe("live");
      expect(matchEventStatus(started, ago(3 * DAY), NOW)).toBe("live");
      // Skew, or a schedule corrected forwards — not evidence of age.
      expect(matchEventStatus(started, new Date(NOW.getTime() + DAY), NOW)).toBe("live");
    });

    it("is live exactly at the window, and not one millisecond past it", () => {
      expect(matchEventStatus(started, ago(RECENT_WINDOW_MS), NOW)).toBe("live");
      expect(matchEventStatus(started, ago(RECENT_WINDOW_MS + 1), NOW)).toBe("recent");
    });

    it("stops claiming live once it is stale, without claiming an ending", () => {
      for (const startTime of [ago(RECENT_WINDOW_MS + 1), ago(30 * DAY), ago(400 * DAY)]) {
        const status = matchEventStatus(started, startTime, NOW);
        expect(status).toBe("recent");
        // Neither a live assertion nor a finish the provider never reported.
        expect(status).not.toBe("live");
        expect(status).not.toBe("finished");
      }
    });

    it("does not claim live when there is no start time to verify it against", () => {
      expect(matchEventStatus(started, null, NOW)).toBe("recent");
    });

    it("still clears the longest real format, so nothing genuinely live is demoted", () => {
      // A five-day Test, judged on its final day.
      expect(matchEventStatus(started, ago(5 * DAY), NOW)).toBe("live");
      expect(RECENT_WINDOW_MS).toBeGreaterThan(5 * DAY);
    });
  });
});

describe("mapMatchToEvent", () => {
  it("maps a live match with per-side scores", () => {
    const event = mapMatchToEvent(LIVE, { ...OPTIONS, competitionName: SERIES.name });

    expect(event).not.toBeNull();
    expect(event?.sport).toBe("cricket");
    expect(event?.kind).toBe("match");
    expect(event?.status).toBe("live");
    expect(event?.competitionName).toBe("India tour of Australia, 2026");
    expect(event?.startTime?.toISOString()).toBe("2026-09-03T09:00:00.000Z");
    // Live prose is a chase note, not a result, so nothing is claimed.
    expect(event?.result).toBeNull();
    expect(event?.relevantCountryIso2).toEqual(["IN"]);
    expect(event?.participants).toEqual([
      {
        participantName: "India",
        countryIso2: "IN",
        title: null,
        role: "home",
        score: "233/4 (45.2)",
        result: null,
        position: null,
      },
      {
        participantName: "Australia",
        countryIso2: "AU",
        title: null,
        role: "away",
        score: "274/8 (50)",
        result: null,
        position: null,
      },
    ]);
  });

  it("maps an upcoming match with no score and no result", () => {
    const event = mapMatchToEvent(UPCOMING, OPTIONS);

    expect(event?.status).toBe("upcoming");
    expect(event?.result).toBeNull();
    expect(event?.participants.map((side) => side.score)).toEqual([null, null]);
    expect(event?.participants.map((side) => side.countryIso2)).toEqual(["NP", "NL"]);
    expect(event?.startTime?.toISOString()).toBe("2026-09-09T10:00:00.000Z");
  });

  it("keeps the provider's summary once a match is over", () => {
    const recent = mapMatchToEvent(COMPLETED, OPTIONS);
    expect(recent?.status).toBe("recent");
    expect(recent?.result).toBe("Namibia Women won by 5 wkts");
    expect(recent?.participants[0]?.score).toBe("117/5 (18.4)");
    expect(recent?.participants[1]?.score).toBe("116/9 (20)");
    // Who won is not split across the sides: the payload does not say per team.
    expect(recent?.participants.map((side) => side.result)).toEqual([null, null]);

    const old = mapMatchToEvent(
      { ...COMPLETED, dateTimeGMT: "2026-07-01T08:00:00" },
      OPTIONS,
    );
    expect(old?.status).toBe("finished");
  });

  it("trusts matchEnded over result-shaped prose", () => {
    // A real live row: the status reads like a result while matchEnded is false.
    const awarded = mapMatchToEvent(
      {
        ...LIVE,
        status: "Tanzania Women awarded the match (opposition refused to play)",
        matchStarted: true,
        matchEnded: false,
      },
      OPTIONS,
    );
    expect(awarded?.status).toBe("live");
    expect(awarded?.result).toBeNull();
  });

  it("withdraws a long-stuck live claim but keeps everything it saw", () => {
    // Started, never flagged as ended, and a month old: not live any more.
    const stuck = mapMatchToEvent({ ...LIVE, dateTimeGMT: "2026-08-01T09:00:00" }, OPTIONS);

    expect(stuck?.status).toBe("recent");
    expect(stuck?.status).not.toBe("finished");
    // No ending was reported, so none is written — at either level.
    expect(stuck?.result).toBeNull();
    expect(stuck?.participants.map((side) => side.result)).toEqual([null, null]);
    // Only the live claim is withdrawn; the data itself survives intact.
    expect(stuck?.startTime?.toISOString()).toBe("2026-08-01T09:00:00.000Z");
    expect(stuck?.participants.map((side) => side.participantName)).toEqual([
      "India",
      "Australia",
    ]);
    expect(stuck?.participants[0]?.score).toBe("233/4 (45.2)");
    expect(stuck?.relevantCountryIso2).toEqual(["IN"]);
    expect(stuck?.sources[0]?.providerRef).toBe(LIVE.id);
  });

  it("decides liveness from the injected clock, not an ambient one", () => {
    const stuck = { ...LIVE, dateTimeGMT: "2026-08-01T09:00:00" };

    // Same record, two clocks, two answers — there is no hidden `new Date()`.
    expect(
      mapMatchToEvent(stuck, { ...OPTIONS, now: new Date("2026-08-01T15:00:00.000Z") })?.status,
    ).toBe("live");
    expect(mapMatchToEvent(stuck, OPTIONS)?.status).toBe("recent");
  });

  it("marks nothing India-relevant when no side is an Indian team", () => {
    const event = mapMatchToEvent(
      {
        ...COMPLETED,
        id: "44444444-4444-4444-8444-444444444444",
        teams: ["West Indies", "England"],
        score: [],
      },
      OPTIONS,
    );

    expect(event?.relevantCountryIso2).toEqual([]);
    expect(event?.participants.map((side) => side.countryIso2)).toEqual([null, null]);
  });

  it("recovers a side that only `teamInfo` names, keeping `teams` order", () => {
    // Straight from the live feed: one team listed, two in teamInfo.
    const event = mapMatchToEvent(
      {
        id: "55555555-5555-4555-8555-555555555555",
        teams: ["Hong Kong"],
        teamInfo: [{ name: "Hong Kong" }, { name: "Tanzania Women" }],
        matchStarted: false,
      },
      OPTIONS,
    );

    expect(event?.participants.map((side) => side.participantName)).toEqual([
      "Hong Kong",
      "Tanzania Women",
    ]);
    expect(event?.participants.map((side) => side.countryIso2)).toEqual(["HK", "TZ"]);
  });

  it("survives a record with nothing but an id and two names", () => {
    const event = mapMatchToEvent(
      { id: "66666666-6666-4666-8666-666666666666", teams: ["India", "Nepal"] },
      OPTIONS,
    );

    expect(event?.status).toBe("upcoming");
    expect(event?.startTime).toBeNull();
    expect(event?.result).toBeNull();
    expect(event?.venueCountryIso2).toBeNull();
    expect(event?.competitionName).toBeNull();
    expect(event?.participants).toHaveLength(2);
  });

  it("drops a match with no named side rather than storing an empty fixture", () => {
    expect(mapMatchToEvent({ id: "77777777-7777-4777-8777-777777777777" }, OPTIONS)).toBeNull();
    expect(mapMatchToEvent({ id: "x", teams: [], teamInfo: [{ img: "a.png" }] }, OPTIONS)).toBeNull();
  });

  it("generates a stable, url-free source ref", () => {
    const first = mapMatchToEvent(LIVE, OPTIONS);
    const second = mapMatchToEvent(LIVE, OPTIONS);

    expect(first?.sources).toEqual([
      {
        provider: CRICKETDATA_PROVIDER_ID,
        providerRef: LIVE.id,
        fetchedAt: FETCHED,
      },
    ]);
    expect(second?.sources).toEqual(first?.sources);
    // The v1 payload carries no web page for a match, so none is invented.
    expect(first?.sources[0]).not.toHaveProperty("url");
  });
});

describe("teamScore", () => {
  it("formats an innings, degrading with the data", () => {
    expect(teamScore("India", [{ r: 233, w: 4, o: 45.2, inning: "India Inning 1" }])).toBe("233/4 (45.2)");
    expect(teamScore("India", [{ r: 233, w: 4, inning: "India Inning 1" }])).toBe("233/4");
    expect(teamScore("India", [{ r: 233, inning: "India Inning 1" }])).toBe("233");
    expect(teamScore("India", [{ o: 0, inning: "India Inning 1" }])).toBeNull();
    expect(teamScore("India", [])).toBeNull();
  });

  it("joins Test innings the way a scorecard reads", () => {
    expect(
      teamScore("England", [
        { r: 325, w: 10, o: 90, inning: "England Inning 1" },
        { r: 180, w: 6, o: 55, inning: "England Inning 2" },
      ]),
    ).toBe("325/10 (90) & 180/6 (55)");
  });

  it("does not let one team claim another's innings", () => {
    const scores = [
      { r: 250, w: 7, o: 50, inning: "India Inning 1" },
      { r: 140, w: 8, o: 20, inning: "India Women Inning 1" },
    ];
    expect(teamScore("India", scores)).toBe("250/7 (50)");
    expect(teamScore("India Women", scores)).toBe("140/8 (20)");
  });
});

describe("matchSides", () => {
  it("de-duplicates across teams and teamInfo, case-insensitively", () => {
    expect(
      matchSides({
        id: "a",
        teams: ["India", "india"],
        teamInfo: [{ name: "INDIA" }, { name: "Nepal" }],
      }),
    ).toEqual(["India", "Nepal"]);
  });
});

describe("mapTeamToParticipant", () => {
  it("maps a team with a name-keyed provider ref", () => {
    expect(mapTeamToParticipant("India Women", FETCHED)).toEqual({
      sport: "cricket",
      type: "team",
      name: "India Women",
      countryIso2: "IN",
      title: null,
      sources: [
        {
          provider: CRICKETDATA_PROVIDER_ID,
          providerRef: "team:India Women",
          fetchedAt: FETCHED,
        },
      ],
    });
  });

  it("returns null for an unusable name", () => {
    expect(mapTeamToParticipant("   ", FETCHED)).toBeNull();
    expect(mapTeamToParticipant(undefined, FETCHED)).toBeNull();
  });
});

describe("deriveSeriesStatus", () => {
  const started = new Date("2026-08-28T00:00:00.000Z");
  const future = new Date("2026-12-01T00:00:00.000Z");

  it("is ongoing while any match is in progress", () => {
    expect(deriveSeriesStatus([LIVE], 3, started, NOW)).toBe("ongoing");
  });

  it("only finishes when the provider's own match count is accounted for", () => {
    const ended = [COMPLETED];
    expect(deriveSeriesStatus(ended, 1, started, NOW)).toBe("finished");
    // A partial match list must not retire a live series.
    expect(deriveSeriesStatus(ended, 3, started, NOW)).toBe("ongoing");
    expect(deriveSeriesStatus(ended, null, started, NOW)).toBe("ongoing");
  });

  it("falls back to the start date when nothing has been played", () => {
    expect(deriveSeriesStatus([UPCOMING], 3, future, NOW)).toBe("upcoming");
    expect(deriveSeriesStatus([UPCOMING], 3, started, NOW)).toBe("ongoing");
    expect(deriveSeriesStatus([], 3, null, NOW)).toBe("upcoming");
  });
});

describe("mapSeriesToCompetition", () => {
  it("maps a series, leaving the yearless end date empty", () => {
    const competition = mapSeriesToCompetition(SERIES, [LIVE, UPCOMING], OPTIONS);

    expect(competition?.sport).toBe("cricket");
    expect(competition?.kind).toBe("series");
    expect(competition?.status).toBe("ongoing");
    expect(competition?.startDate?.toISOString()).toBe("2026-08-28T00:00:00.000Z");
    // "Sep 20" has no year, and one is never borrowed from the start date.
    expect(competition?.endDate).toBeNull();
    expect(competition?.hostCountryIso2).toBeNull();
    expect(competition?.relevantCountryIso2).toEqual(["IN"]);
    expect(competition?.participants.map((entrant) => entrant.participantName)).toEqual([
      "India",
      "Australia",
      "Nepal",
      "Netherlands",
    ]);
    expect(competition?.participants[0]).toEqual({
      participantName: "India",
      countryIso2: "IN",
      title: null,
      status: "entered",
      finalRank: null,
    });
    expect(competition?.sources).toEqual([
      { provider: CRICKETDATA_PROVIDER_ID, providerRef: SERIES_ID, fetchedAt: FETCHED },
    ]);
  });

  it("drops a series with no usable name", () => {
    expect(mapSeriesToCompetition({ id: SERIES_ID }, [], OPTIONS)).toBeNull();
  });

  it("folds the lower-cased /series_info date keys into one shape", () => {
    const folded = seriesFromInfo({
      id: SERIES_ID,
      name: "Emerging Asia Cup",
      startdate: "2026-07-21",
      enddate: "Jul 30",
      matches: 6,
    });
    expect(folded.startDate).toBe("2026-07-21");
    expect(folded.endDate).toBe("Jul 30");
    expect(mapSeriesToCompetition(folded, [], OPTIONS)?.startDate?.toISOString()).toBe(
      "2026-07-21T00:00:00.000Z",
    );
  });
});

describe("mapSnapshot", () => {
  it("names each event's series and de-duplicates teams", () => {
    const mapped = mapSnapshot(
      { series: [SERIES], matches: [LIVE, UPCOMING, COMPLETED], fetchedAt: FETCHED },
      NOW,
    );

    expect(mapped.events.map((event) => event.status)).toEqual([
      "live",
      "upcoming",
      "recent",
    ]);
    expect(new Set(mapped.events.map((event) => event.competitionName))).toEqual(
      new Set([SERIES.name]),
    );
    expect(mapped.competitions).toHaveLength(1);
    expect(mapped.participants.map((team) => team.name)).toEqual([
      "India",
      "Australia",
      "Nepal",
      "Netherlands",
      "Namibia Women",
      "Uganda Women",
    ]);
  });

  it("attributes /series_info matches that carry no series_id of their own", () => {
    const orphan: CricketDataMatch = { ...LIVE, series_id: undefined };
    const mapped = mapSnapshot(
      {
        series: [SERIES],
        matches: [orphan],
        seriesIdByMatchId: { [orphan.id]: SERIES_ID },
        fetchedAt: FETCHED,
      },
      NOW,
    );

    expect(mapped.events[0]?.competitionName).toBe(SERIES.name);
    expect(mapped.competitions[0]?.participants).toHaveLength(2);
  });

  it("keeps an event whose series is not in the snapshot, unnamed", () => {
    const mapped = mapSnapshot(
      { series: [], matches: [LIVE], fetchedAt: FETCHED },
      NOW,
    );

    expect(mapped.events).toHaveLength(1);
    expect(mapped.events[0]?.competitionName).toBeNull();
    expect(mapped.competitions).toEqual([]);
  });

  it("skips unmappable records instead of substituting anything", () => {
    const mapped = mapSnapshot(
      {
        series: [SERIES, { id: "no-name-series" }],
        matches: [LIVE, { id: "sideless" }],
        fetchedAt: FETCHED,
      },
      NOW,
    );

    expect(mapped.events).toHaveLength(1);
    expect(mapped.competitions).toHaveLength(1);
  });
});

describe("boundary parsing", () => {
  it("skips malformed rows and keeps the rest of the page", () => {
    const rows = parseRows(CricketDataMatch, [
      { id: "ok-1", teams: ["India"] },
      { name: "missing an id" },
      null,
      "not an object",
      { id: 42 },
      { id: "ok-2" },
    ]);

    expect(rows.map((row) => row.id)).toEqual(["ok-1", "ok-2"]);
  });

  it("reads a zone-less dateTimeGMT as UTC, not local time", () => {
    expect(utcTimestamp("2026-07-28T12:00:00")?.toISOString()).toBe(
      "2026-07-28T12:00:00.000Z",
    );
    expect(utcTimestamp("2026-07-28T12:00:00Z")?.toISOString()).toBe(
      "2026-07-28T12:00:00.000Z",
    );
    expect(utcTimestamp("Jul 28")).toBeNull();
    expect(utcTimestamp(undefined)).toBeNull();
  });

  it("accepts only complete calendar dates", () => {
    expect(calendarDate("2026-07-21")?.toISOString()).toBe("2026-07-21T00:00:00.000Z");
    expect(calendarDate("Jul 30")).toBeNull();
    expect(calendarDate("2026-13-40")).toBeNull();
    expect(calendarDate("")).toBeNull();
  });
});
