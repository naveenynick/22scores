import { z } from "zod";

/**
 * Zod schemas for RAW CricketData (api.cricapi.com/v1) payloads.
 *
 * Shapes were confirmed against the live API. Everything is permissive on
 * purpose: unknown fields pass through and optional fields stay optional, so a
 * provider change degrades a single record instead of failing a sync. Nothing
 * here is canonical — mapping happens in cricketdata-mapper.ts.
 *
 * Quirks the live responses really do exhibit, each handled below rather than
 * assumed away:
 *  - `dateTimeGMT` carries no zone suffix ("2026-07-28T12:00:00") and is UTC, so
 *    it must never be handed to `new Date()` unqualified;
 *  - `teams` can list FEWER sides than `teamInfo`, and the two are not in the
 *    same order, so neither array alone describes a match;
 *  - `score` may hold one innings for a two-team match, or none at all;
 *  - `/series` uses `startDate`/`endDate` while `/series_info` uses lower-cased
 *    `startdate`/`enddate`, and either end value can be a partial date with no
 *    year ("Jul 30");
 *  - `/series_info` match entries carry no `series_id` of their own;
 *  - `/matches` entries carry no `score` at all — only `/currentMatches` and
 *    `/match_info` do.
 */

// --- Response envelope ------------------------------------------------------

/** Quota and paging metadata. `hitsLimit` is 100/day on the free plan. */
export const CricketDataInfo = z
  .object({
    hitsToday: z.number().optional(),
    hitsUsed: z.number().optional(),
    hitsLimit: z.number().optional(),
    credits: z.number().optional(),
    offsetRows: z.number().optional(),
    totalRows: z.number().optional(),
    cache: z.number().optional(),
  })
  .passthrough();
export type CricketDataInfo = z.infer<typeof CricketDataInfo>;

/**
 * Every v1 response is wrapped in this. `status` is "success" or "failure";
 * a failure carries `reason` (bad key, quota exhausted) and no usable data.
 *
 * The real response also echoes the API key back as `apikey`. It is deliberately
 * NOT declared here and must never be read, logged, or re-serialized.
 */
export const CricketDataEnvelope = z
  .object({
    status: z.string().optional(),
    reason: z.string().optional(),
    data: z.unknown().optional(),
    info: CricketDataInfo.optional(),
  })
  .passthrough();
export type CricketDataEnvelope = z.infer<typeof CricketDataEnvelope>;

// --- Entities ---------------------------------------------------------------

export const CricketDataTeamInfo = z
  .object({
    name: z.string().optional(),
    shortname: z.string().optional(),
    img: z.string().optional(),
  })
  .passthrough();
export type CricketDataTeamInfo = z.infer<typeof CricketDataTeamInfo>;

/** One innings: runs, wickets, overs, and a "<team> Inning <n>" label. */
export const CricketDataScore = z
  .object({
    r: z.number().optional(),
    w: z.number().optional(),
    o: z.number().optional(),
    inning: z.string().optional(),
  })
  .passthrough();
export type CricketDataScore = z.infer<typeof CricketDataScore>;

/**
 * A match, as returned by `/currentMatches`, `/matches`, `/match_info` and
 * `/series_info`. Only `id` is required: it is the provenance ref and the only
 * field that makes a stored row re-readable.
 */
export const CricketDataMatch = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    matchType: z.string().optional(),
    /** Free-text human status: a result, a start time, or a chase summary. */
    status: z.string().optional(),
    venue: z.string().optional(),
    date: z.string().optional(),
    dateTimeGMT: z.string().optional(),
    teams: z.array(z.string()).optional(),
    teamInfo: z.array(CricketDataTeamInfo).optional(),
    score: z.array(CricketDataScore).optional(),
    series_id: z.string().optional(),
    /** The two deterministic status signals. Everything else is prose. */
    matchStarted: z.boolean().optional(),
    matchEnded: z.boolean().optional(),
  })
  .passthrough();
export type CricketDataMatch = z.infer<typeof CricketDataMatch>;

/** A row from `/series`. `matches` is the series' TOTAL match count. */
export const CricketDataSeries = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    startDate: z.string().optional(),
    endDate: z.string().optional(),
    odi: z.number().optional(),
    t20: z.number().optional(),
    test: z.number().optional(),
    squads: z.number().optional(),
    matches: z.number().optional(),
  })
  .passthrough();
export type CricketDataSeries = z.infer<typeof CricketDataSeries>;

/** `/series_info` restates the series with lower-cased date keys. */
export const CricketDataSeriesInfoBody = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    startdate: z.string().optional(),
    enddate: z.string().optional(),
    odi: z.number().optional(),
    t20: z.number().optional(),
    test: z.number().optional(),
    squads: z.number().optional(),
    matches: z.number().optional(),
  })
  .passthrough();
export type CricketDataSeriesInfoBody = z.infer<typeof CricketDataSeriesInfoBody>;

export const CricketDataSeriesInfo = z
  .object({
    info: CricketDataSeriesInfoBody,
    matchList: z.array(CricketDataMatch).optional(),
  })
  .passthrough();
export type CricketDataSeriesInfo = z.infer<typeof CricketDataSeriesInfo>;

// --- Boundary parsing helpers ----------------------------------------------

/**
 * Parse a `data` array row by row, skipping records that do not fit.
 *
 * One malformed record must cost only itself: a page with a broken row still
 * yields the rest, exactly as the Lichess NDJSON reader does per line.
 */
export function parseRows<T extends z.ZodTypeAny>(
  schema: T,
  data: unknown,
): z.infer<T>[] {
  if (!Array.isArray(data)) return [];
  return data.flatMap((row) => {
    const parsed = schema.safeParse(row);
    return parsed.success ? [parsed.data as z.infer<T>] : [];
  });
}

/** Parse a single-object `data` payload, or null when it does not fit. */
export function parseOne<T extends z.ZodTypeAny>(
  schema: T,
  data: unknown,
): z.infer<T> | null {
  const parsed = schema.safeParse(data);
  return parsed.success ? (parsed.data as z.infer<T>) : null;
}

/**
 * `dateTimeGMT` as a real instant.
 *
 * The API sends "2026-07-28T12:00:00" with no zone, and the field name is the only
 * thing that says GMT. Passing that to `new Date()` would read it as the server's
 * local time and silently shift every kickoff, so a bare timestamp is qualified as
 * UTC here.
 *
 * Only ISO-8601-shaped input is accepted, and that matters: `new Date()` will
 * happily turn the partial "Jul 28" into July 2001 in the local zone. A value this
 * function cannot recognize becomes null rather than an invented instant.
 */
const ISO_TIMESTAMP =
  /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?)(Z|[+-]\d{2}:?\d{2})?$/;

export function utcTimestamp(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const match = ISO_TIMESTAMP.exec(value.trim());
  if (match === null) return null;
  const [, day, time, zone] = match;
  const parsed = new Date(`${day}T${time}${zone ?? "Z"}`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * A calendar date, but ONLY when the provider sent a complete one.
 *
 * Series end dates arrive as partials such as "Jul 30" with no year. A year is
 * missing data, not something to infer from the start date, so a partial value
 * resolves to null and the canonical `endDate` stays empty. Range roll-over
 * ("2026-13-40") is rejected too, by round-tripping the parsed date.
 */
export function calendarDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (match === null) return null;
  const [, year, month, day] = match;
  const date = new Date(
    Date.UTC(Number(year), Number(month) - 1, Number(day)),
  );
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10) === `${year}-${month}-${day}`
    ? date
    : null;
}
