import {
  Competition,
  type CompetitionParticipant,
  type CompetitionStatus,
  Event,
  type EventParticipant,
  type EventStatus,
  Participant,
  type SourceRef,
} from "@/core/models/canonical";

import {
  calendarDate,
  type CricketDataMatch,
  type CricketDataScore,
  type CricketDataSeries,
  type CricketDataSeriesInfoBody,
  utcTimestamp,
} from "./cricketdata-schemas";

/**
 * Pure raw -> canonical mapping for CricketData.
 *
 * No HTTP, no database, and no hidden clock: every function that needs the
 * current time takes it as an argument, so status derivation is reproducible in
 * tests. Anything the provider did not send stays null — no date, participant,
 * score, status or country is ever invented.
 */

export const CRICKETDATA_PROVIDER_ID = "cricketdata";

const INDIA_ISO2 = "IN";

/**
 * The one age window in this mapper, measured from the start time because
 * CricketData sends no end time. It bounds two things:
 *
 *  - how long a completed match counts as "recent" rather than "finished";
 *  - how long an unfinished match may still be claimed as "live".
 *
 * A week clears the longest real format — a five-day Test — so the live bound
 * never demotes a match that is genuinely in progress. On the "recent" side the
 * same arithmetic leaves such a Test only about two days of recency, since the
 * clock runs from its first ball rather than its last.
 *
 * This is a mapping-time bound on what the provider's booleans may assert. The
 * read-time freshness rule in `@/core/queries/freshness` is separate, applies to
 * provenance age, and is inherited by cricket unchanged.
 */
export const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// --- Team country resolution ------------------------------------------------

/**
 * National team name -> ISO 3166-1 alpha-2, by EXACT normalized name.
 *
 * An allowlist, and the direct counterpart of the chess mapper's FED_TO_ISO2: a
 * name that is not listed resolves to null rather than being guessed, so no team
 * is ever labelled with a country it does not have. There is no fuzzy matching,
 * no substring test and no suffix stripping — inferring that some unknown
 * "X Warriors" belongs to X is precisely the guess that quietly mislabels data.
 *
 * Deliberate absences: England and Scotland (UK subdivisions — ISO 3166-1 has no
 * alpha-2 for either, and "GB" names a different entity) and West Indies (a
 * multi-nation side with no country code at all). Those stay null by design.
 *
 * Domestic and franchise sides (IPL, Ranji Trophy) are NOT here. They are Indian
 * teams, but enumerating them is a curation job of its own; until that list
 * exists they resolve to null rather than being pattern-matched.
 */
const NATIONAL_TEAM_ISO2: Readonly<Record<string, string>> = {
  AFGHANISTAN: "AF",
  ARGENTINA: "AR",
  AUSTRALIA: "AU",
  AUSTRIA: "AT",
  BAHAMAS: "BS",
  BAHRAIN: "BH",
  BANGLADESH: "BD",
  BELGIUM: "BE",
  BELIZE: "BZ",
  BERMUDA: "BM",
  BHUTAN: "BT",
  BOTSWANA: "BW",
  BRAZIL: "BR",
  BULGARIA: "BG",
  CAMBODIA: "KH",
  CAMEROON: "CM",
  CANADA: "CA",
  "CAYMAN ISLANDS": "KY",
  CHILE: "CL",
  CHINA: "CN",
  COLOMBIA: "CO",
  "COOK ISLANDS": "CK",
  "COSTA RICA": "CR",
  CROATIA: "HR",
  CYPRUS: "CY",
  CZECHIA: "CZ",
  "CZECH REPUBLIC": "CZ",
  DENMARK: "DK",
  ESTONIA: "EE",
  ESWATINI: "SZ",
  FIJI: "FJ",
  FINLAND: "FI",
  FRANCE: "FR",
  GAMBIA: "GM",
  GERMANY: "DE",
  GHANA: "GH",
  GIBRALTAR: "GI",
  GREECE: "GR",
  GUERNSEY: "GG",
  "HONG KONG": "HK",
  "HONG KONG, CHINA": "HK",
  HUNGARY: "HU",
  INDIA: "IN",
  INDONESIA: "ID",
  IRAN: "IR",
  IRELAND: "IE",
  "ISLE OF MAN": "IM",
  ISRAEL: "IL",
  ITALY: "IT",
  JAPAN: "JP",
  JERSEY: "JE",
  KAZAKHSTAN: "KZ",
  KENYA: "KE",
  KUWAIT: "KW",
  LESOTHO: "LS",
  LUXEMBOURG: "LU",
  MALAWI: "MW",
  MALAYSIA: "MY",
  MALDIVES: "MV",
  MALI: "ML",
  MALTA: "MT",
  MEXICO: "MX",
  MONGOLIA: "MN",
  MOZAMBIQUE: "MZ",
  MYANMAR: "MM",
  NAMIBIA: "NA",
  NEPAL: "NP",
  NETHERLANDS: "NL",
  "NEW ZEALAND": "NZ",
  NIGERIA: "NG",
  NORWAY: "NO",
  OMAN: "OM",
  PAKISTAN: "PK",
  PANAMA: "PA",
  "PAPUA NEW GUINEA": "PG",
  PERU: "PE",
  PHILIPPINES: "PH",
  PORTUGAL: "PT",
  QATAR: "QA",
  ROMANIA: "RO",
  RWANDA: "RW",
  SAMOA: "WS",
  "SAUDI ARABIA": "SA",
  SERBIA: "RS",
  SEYCHELLES: "SC",
  "SIERRA LEONE": "SL",
  SINGAPORE: "SG",
  SLOVENIA: "SI",
  "SOUTH AFRICA": "ZA",
  "SOUTH KOREA": "KR",
  SPAIN: "ES",
  "SRI LANKA": "LK",
  SWEDEN: "SE",
  SWITZERLAND: "CH",
  TANZANIA: "TZ",
  THAILAND: "TH",
  TURKEY: "TR",
  UAE: "AE",
  UGANDA: "UG",
  "UNITED ARAB EMIRATES": "AE",
  "UNITED STATES": "US",
  USA: "US",
  UZBEKISTAN: "UZ",
  VANUATU: "VU",
  ZAMBIA: "ZM",
  ZIMBABWE: "ZW",
};

/**
 * Qualifiers CricketData appends to a national side's name.
 *
 * Expanded into the lookup table up front, so the lookup itself stays an exact
 * match against a fixed set of strings — there is no pattern matching at read
 * time. "India Women" and "India A" are India; a name built any other way is not.
 */
const TEAM_QUALIFIERS: readonly string[] = [
  "WOMEN",
  "A",
  "B",
  "U19",
  "U19 WOMEN",
  "WOMEN U19",
  "U23",
  "EMERGING",
  "LEGENDS",
  "XI",
];

/** One-off exact names that no qualifier rule would produce. */
const NAMED_TEAM_ISO2: Readonly<Record<string, string>> = {
  "INDIA BLUE": "IN",
  "INDIA GREEN": "IN",
  "INDIA RED": "IN",
  "INDIA SENIORS": "IN",
  "INDIA UNDER-19": "IN",
  "INDIA WOMEN UNDER-19": "IN",
};

function buildTeamIso2(): Readonly<Record<string, string>> {
  const table: Record<string, string> = {};
  for (const [name, iso2] of Object.entries(NATIONAL_TEAM_ISO2)) {
    table[name] = iso2;
    for (const qualifier of TEAM_QUALIFIERS) {
      table[`${name} ${qualifier}`] = iso2;
    }
  }
  return { ...table, ...NAMED_TEAM_ISO2 };
}

const TEAM_ISO2 = buildTeamIso2();

// --- Small helpers ----------------------------------------------------------

/** Collapse whitespace; blank and non-string values become null. */
export function normalizeName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  return text === "" ? null : text;
}

/** The country a team represents, or null when the name is not on the allowlist. */
export function teamCountryIso2(value: unknown): string | null {
  const name = normalizeName(value);
  if (name === null) return null;
  return TEAM_ISO2[name.toUpperCase()] ?? null;
}

/** Only http(s) URLs are ever attached as provenance. */
function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Provenance for one canonical record.
 *
 * CricketData's v1 responses contain no web-page URL for a match or a series —
 * only team crest images — so `url` is normally absent. It is attached only when
 * a real http(s) URL is actually supplied, never synthesized from an id.
 */
export function source(
  providerRef: string,
  fetchedAt: Date,
  url?: unknown,
): SourceRef {
  const ref: SourceRef = {
    provider: CRICKETDATA_PROVIDER_ID,
    providerRef,
    fetchedAt,
  };
  return isHttpUrl(url) ? { ...ref, url } : ref;
}

// --- Status -----------------------------------------------------------------

/**
 * Whether a match is young enough for its start time to still say something
 * about now. One window, one comparison, used by every branch below.
 *
 * A start time in the future counts as fresh rather than stale — that is clock
 * skew or a corrected schedule, not evidence the match is old — matching how
 * `@/core/queries/freshness` treats a future fetch. Exactly at the boundary is
 * fresh too, for the same reason it is there.
 */
function withinRecentWindow(startTime: Date, now: Date): boolean {
  return now.getTime() - startTime.getTime() <= RECENT_WINDOW_MS;
}

/**
 * Deterministic status, from the two booleans CricketData actually commits to.
 *
 * `status` on a raw match is free text — a result, a start time, or a chase
 * summary — and the live feed really does return result-shaped prose while
 * `matchEnded` is still false. So the prose is never parsed: `matchEnded` and
 * `matchStarted` decide, and a match the provider has not flagged as started
 * stays "upcoming" however old its scheduled time is.
 *
 * "live" is the one status that asserts something about *now*, so it is the one
 * status that also has to age. `matchStarted: true, matchEnded: false` is a
 * claim the provider can get stuck on — a match abandoned mid-innings, or a row
 * it simply stops updating — and because every sync re-stamps provenance, the
 * read-time freshness guard would keep confirming that claim forever. So a
 * started-but-unfinished match is believed only while its start is inside the
 * same window a completed match counts as recent within: seven days, which
 * clears the longest real format (a five-day Test) with room to spare, so no
 * genuinely live match is ever demoted.
 *
 * Past that — and when there is no start time to age at all, since an
 * unverifiable live claim is not a confirmed one — the match becomes "recent":
 * still real, still readable, but no longer asserting it is in progress. It is
 * NOT called "finished", because the provider never said so, and `result` stays
 * null in `mapMatchToEvent` for exactly the same reason.
 */
export function matchEventStatus(
  match: Pick<CricketDataMatch, "matchStarted" | "matchEnded">,
  startTime: Date | null,
  now: Date,
): EventStatus {
  if (match.matchEnded === true) {
    if (startTime === null) return "finished";
    return withinRecentWindow(startTime, now) ? "recent" : "finished";
  }
  if (match.matchStarted !== true) return "upcoming";
  if (startTime === null) return "recent";
  return withinRecentWindow(startTime, now) ? "live" : "recent";
}

/**
 * Series status.
 *
 * "Every match we happen to hold is finished" is NOT "the series is over": a
 * partial match list would retire a live series. Only the provider's own total
 * match count can settle that, so without it the series stays "ongoing".
 */
export function deriveSeriesStatus(
  matches: readonly CricketDataMatch[],
  totalMatches: number | null,
  startDate: Date | null,
  now: Date,
): CompetitionStatus {
  const live = matches.some(
    (match) => match.matchStarted === true && match.matchEnded !== true,
  );
  if (live) return "ongoing";

  const ended = matches.filter((match) => match.matchEnded === true).length;
  if (ended > 0) {
    if (totalMatches !== null && ended >= totalMatches) return "finished";
    return "ongoing";
  }
  if (startDate === null) return "upcoming";
  return startDate.getTime() > now.getTime() ? "upcoming" : "ongoing";
}

// --- Scores -----------------------------------------------------------------

/** One innings as "116/2 (16.4)", degrading as far as the data allows. */
function formatInnings(entry: CricketDataScore): string | null {
  const runs = typeof entry.r === "number" ? entry.r : null;
  if (runs === null) return null;
  const wickets = typeof entry.w === "number" ? entry.w : null;
  const overs = typeof entry.o === "number" ? entry.o : null;
  const total = wickets === null ? `${runs}` : `${runs}/${wickets}`;
  return overs === null || overs === 0 ? total : `${total} (${overs})`;
}

/**
 * A team's innings, attributed by its `inning` label ("India Inning 1").
 *
 * The team name must be followed by "Inning", which is what keeps "India" from
 * claiming "India Women Inning 1". Test innings are joined with " & ", the way a
 * scorecard reads. A team with no innings in the payload gets null, not "0".
 */
export function teamScore(
  teamName: string,
  scores: readonly CricketDataScore[],
): string | null {
  const prefix = `${teamName.toUpperCase()} INNING`;
  const innings = scores.flatMap((entry) => {
    const label = normalizeName(entry.inning)?.toUpperCase() ?? null;
    if (label === null || !label.startsWith(prefix)) return [];
    const formatted = formatInnings(entry);
    return formatted === null ? [] : [formatted];
  });
  return innings.length === 0 ? null : innings.join(" & ");
}

// --- Sides ------------------------------------------------------------------

/**
 * The named sides of a match, in the provider's order, de-duplicated.
 *
 * `teams` is the ordered list but is sometimes SHORTER than `teamInfo` — one live
 * row listed a single side while `teamInfo` named both — and the two arrays are
 * not in the same order. Dropping a side the same payload names elsewhere would
 * lose a real participant, so `teams` sets the order and `teamInfo` only fills
 * gaps. Nothing is read from the match `name` string.
 */
export function matchSides(match: CricketDataMatch): string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();
  const add = (value: unknown): void => {
    const name = normalizeName(value);
    if (name === null) return;
    const key = name.toUpperCase();
    if (seen.has(key)) return;
    seen.add(key);
    ordered.push(name);
  };
  for (const team of match.teams ?? []) add(team);
  for (const info of match.teamInfo ?? []) add(info.name);
  return ordered;
}

// --- Matches -> events ------------------------------------------------------

export interface MapMatchOptions {
  fetchedAt: Date;
  now: Date;
  /** Resolved series name, or null when the series is not in this snapshot. */
  competitionName?: string | null;
}

/**
 * One raw match as a canonical event, or null when the record is unusable.
 *
 * A match with no named side is dropped rather than stored as a fixture with no
 * teams — there is nothing to show and nothing to dedupe on.
 *
 * `role` carries the provider's team ordering using the canonical vocabulary the
 * model names for cricket. Read it as "first-named side" / "second-named side":
 * CricketData does not state who is at home, and many fixtures are at neutral
 * venues, so it is an ordering label, not a claim about the ground. `position`
 * stays null because it means finishing place, which a two-sided match has none of.
 *
 * `venueCountryIso2` is always null. The payload carries a free-text `venue`
 * ("Sano International Cricket Ground, Sano"), and turning that into a country
 * needs exactly the fuzzy string matching this mapper refuses to do.
 */
export function mapMatchToEvent(
  match: CricketDataMatch,
  options: MapMatchOptions,
): Event | null {
  const sides = matchSides(match);
  if (sides.length === 0) return null;

  const scores = match.score ?? [];
  // `dateTimeGMT` is the precise instant; `date` is the fallback calendar day.
  const startTime = utcTimestamp(match.dateTimeGMT) ?? calendarDate(match.date);
  const ended = match.matchEnded === true;

  const participants: EventParticipant[] = sides.map((name, index) => ({
    participantName: name,
    countryIso2: teamCountryIso2(name),
    title: null,
    role: index === 0 ? "home" : index === 1 ? "away" : null,
    score: teamScore(name, scores),
    result: null,
    position: null,
  }));

  const indiaRelevant = participants.some(
    (side) => side.countryIso2 === INDIA_ISO2,
  );

  const parsed = Event.safeParse({
    sport: "cricket",
    kind: "match",
    status: matchEventStatus(match, startTime, options.now),
    competitionName: normalizeName(options.competitionName),
    startTime,
    participants,
    // The provider's own summary, and only once it says the match is over. While
    // a match is live the same field holds a chase note, not a result.
    result: ended ? normalizeName(match.status) : null,
    venueCountryIso2: null,
    relevantCountryIso2: indiaRelevant ? [INDIA_ISO2] : [],
    sources: [source(match.id, options.fetchedAt)],
  });
  return parsed.success ? parsed.data : null;
}

// --- Teams -> participants --------------------------------------------------

/**
 * A team as a canonical participant. `providerRef` is "team:<name>" because
 * CricketData exposes no stable team id — only names and crest images.
 */
export function mapTeamToParticipant(
  value: unknown,
  fetchedAt: Date,
): Participant | null {
  const name = normalizeName(value);
  if (name === null) return null;
  const parsed = Participant.safeParse({
    sport: "cricket",
    type: "team",
    name,
    countryIso2: teamCountryIso2(name),
    title: null,
    sources: [source(`team:${name}`, fetchedAt)],
  });
  return parsed.success ? parsed.data : null;
}

// --- Series -> competitions -------------------------------------------------

/**
 * `/series_info` restates the series with lower-cased date keys, so it is folded
 * into the `/series` shape here rather than teaching every caller both spellings.
 */
export function seriesFromInfo(
  body: CricketDataSeriesInfoBody,
): CricketDataSeries {
  return {
    ...body,
    startDate: body.startdate,
    endDate: body.enddate,
  };
}

export interface MapSeriesOptions {
  fetchedAt: Date;
  now: Date;
}

/**
 * One series as a canonical competition, or null when it has no usable name.
 *
 * `kind` is always "series" — that is literally the entity CricketData exposes
 * (`/series`, `series_id`). Reclassifying the IPL as a "league" would mean reading
 * the words in its name, which is the fuzzy matching this mapper avoids.
 *
 * `endDate` is usually null even though the provider sends something, because
 * what it sends is a partial like "Jul 30" with no year. Borrowing the year from
 * the start date would invent a date, and a series that crosses New Year would be
 * given the wrong one, so it stays empty.
 *
 * `hostCountryIso2` is always null: the series name is the only location hint and
 * parsing it is guesswork.
 */
export function mapSeriesToCompetition(
  series: CricketDataSeries,
  matches: readonly CricketDataMatch[],
  options: MapSeriesOptions,
): Competition | null {
  const name = normalizeName(series.name);
  if (name === null) return null;

  const startDate = calendarDate(series.startDate);
  const totalMatches =
    typeof series.matches === "number" ? series.matches : null;

  const entrants = new Map<string, CompetitionParticipant>();
  for (const match of matches) {
    for (const side of matchSides(match)) {
      const key = side.toUpperCase();
      if (entrants.has(key)) continue;
      entrants.set(key, {
        participantName: side,
        countryIso2: teamCountryIso2(side),
        title: null,
        status: "entered",
        finalRank: null,
      });
    }
  }
  const participants = [...entrants.values()];

  const parsed = Competition.safeParse({
    sport: "cricket",
    name,
    kind: "series",
    status: deriveSeriesStatus(matches, totalMatches, startDate, options.now),
    startDate,
    endDate: calendarDate(series.endDate),
    hostCountryIso2: null,
    participants,
    relevantCountryIso2: participants.some(
      (entrant) => entrant.countryIso2 === INDIA_ISO2,
    )
      ? [INDIA_ISO2]
      : [],
    sources: [source(series.id, options.fetchedAt)],
  });
  return parsed.success ? parsed.data : null;
}

// --- Whole snapshot ---------------------------------------------------------

export interface CricketDataSnapshotInput {
  /** Series discovered this cycle, in provider order. */
  series: readonly CricketDataSeries[];
  /** Matches discovered this cycle, richest source first. */
  matches: readonly CricketDataMatch[];
  /**
   * match id -> series id, for matches read through `/series_info`: those entries
   * carry no `series_id` of their own, so the caller records where they came from.
   */
  seriesIdByMatchId?: Readonly<Record<string, string>>;
  /** Stamped before the first request of the cycle. */
  fetchedAt: Date;
}

export interface MappedCricketData {
  competitions: Competition[];
  events: Event[];
  participants: Participant[];
}

/**
 * Map a whole discovery cycle. Records that cannot be mapped are skipped, never
 * substituted: an event with no sides, a series with no name, and a match whose
 * series is not in this snapshot all degrade to less data rather than wrong data
 * (the last keeps its own event, with `competitionName` null).
 */
export function mapSnapshot(
  snapshot: CricketDataSnapshotInput,
  now: Date = new Date(),
): MappedCricketData {
  const { fetchedAt } = snapshot;
  const options = { fetchedAt, now };

  const seriesById = new Map<string, CricketDataSeries>();
  for (const series of snapshot.series) {
    if (!seriesById.has(series.id)) seriesById.set(series.id, series);
  }

  const seriesIdFor = (match: CricketDataMatch): string | null => {
    const own = normalizeName(match.series_id);
    if (own !== null) return own;
    return snapshot.seriesIdByMatchId?.[match.id] ?? null;
  };

  const matchesBySeries = new Map<string, CricketDataMatch[]>();
  const events: Event[] = [];
  const teams = new Map<string, Participant>();

  for (const match of snapshot.matches) {
    const seriesId = seriesIdFor(match);
    const series = seriesId === null ? undefined : seriesById.get(seriesId);
    if (seriesId !== null) {
      const bucket = matchesBySeries.get(seriesId);
      if (bucket === undefined) matchesBySeries.set(seriesId, [match]);
      else bucket.push(match);
    }

    const event = mapMatchToEvent(match, {
      ...options,
      competitionName: series?.name ?? null,
    });
    if (event !== null) events.push(event);

    for (const side of matchSides(match)) {
      const key = side.toUpperCase();
      if (teams.has(key)) continue;
      const participant = mapTeamToParticipant(side, fetchedAt);
      if (participant !== null) teams.set(key, participant);
    }
  }

  const competitions = snapshot.series.flatMap((series) => {
    const competition = mapSeriesToCompetition(
      series,
      matchesBySeries.get(series.id) ?? [],
      options,
    );
    return competition === null ? [] : [competition];
  });

  return { competitions, events, participants: [...teams.values()] };
}
