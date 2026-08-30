import { z } from "zod";

/**
 * Zod schemas for RAW Lichess broadcast payloads.
 *
 * Shapes were confirmed against the live public API. Everything is permissive
 * on purpose: unknown fields pass through, and optional fields stay optional so
 * a Lichess response change degrades a single record instead of failing a sync.
 * Nothing here is canonical — mapping happens in lichess-mapper.ts.
 */

/** Federation is normally a code string ("IND"); some endpoints nest an object. */
export const LichessFed = z.union([
  z.string(),
  z.object({ id: z.string().optional(), name: z.string().optional() }).passthrough(),
]);

export const LichessPlayer = z
  .object({
    name: z.string().optional(),
    title: z.string().optional(),
    rating: z.number().optional(),
    fideId: z.number().optional(),
    fed: LichessFed.optional(),
    clock: z.number().optional(),
  })
  .passthrough();
export type LichessPlayer = z.infer<typeof LichessPlayer>;

export const LichessRound = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    slug: z.string().optional(),
    startsAt: z.number().optional(),
    url: z.string().optional(),
    ongoing: z.boolean().optional(),
    finished: z.boolean().optional(),
  })
  .passthrough();
export type LichessRound = z.infer<typeof LichessRound>;

export const LichessTour = z
  .object({
    id: z.string(),
    name: z.string(),
    slug: z.string().optional(),
    url: z.string().optional(),
    tier: z.number().optional(),
    description: z.string().optional(),
    createdAt: z.number().optional(),
    /** Shape varies ({start,end} or [start,end]); parsed defensively. */
    dates: z.unknown().optional(),
    info: z.unknown().optional(),
  })
  .passthrough();
export type LichessTour = z.infer<typeof LichessTour>;

export const LichessGame = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    players: z.array(LichessPlayer).optional(),
    status: z.string().optional(),
  })
  .passthrough();
export type LichessGame = z.infer<typeof LichessGame>;

/** One NDJSON line from GET /api/broadcast?page=N (rounds included inline). */
export const LichessBroadcastListEntry = z
  .object({
    tour: LichessTour,
    rounds: z.array(LichessRound).optional(),
    defaultRoundId: z.string().optional(),
  })
  .passthrough();
export type LichessBroadcastListEntry = z.infer<typeof LichessBroadcastListEntry>;

/** An entry inside GET /api/broadcast/top (single `round`, no `rounds` array). */
export const LichessTopEntry = z
  .object({
    tour: LichessTour,
    round: LichessRound.optional(),
  })
  .passthrough();
export type LichessTopEntry = z.infer<typeof LichessTopEntry>;

export const LichessTopResponse = z
  .object({
    active: z.array(LichessTopEntry).optional(),
    upcoming: z.array(LichessTopEntry).optional(),
    /** Either a bare array or a paginator object depending on API version. */
    past: z.unknown().optional(),
  })
  .passthrough();
export type LichessTopResponse = z.infer<typeof LichessTopResponse>;

/** GET /api/broadcast/-/-/{roundId} */
export const LichessRoundDetail = z
  .object({
    round: LichessRound,
    tour: LichessTour,
    games: z.array(LichessGame).optional(),
  })
  .passthrough();
export type LichessRoundDetail = z.infer<typeof LichessRoundDetail>;

/** Extract `past` entries from either supported container shape. */
export function extractPastEntries(past: unknown): LichessTopEntry[] {
  const raw = Array.isArray(past)
    ? past
    : past && typeof past === "object" &&
        Array.isArray((past as { currentPageResults?: unknown }).currentPageResults)
      ? (past as { currentPageResults: unknown[] }).currentPageResults
      : [];
  return raw.flatMap((item) => {
    const parsed = LichessTopEntry.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

/** Normalize a federation value to a plain code, or null when absent. */
export function fedCode(fed: unknown): string | null {
  if (typeof fed === "string") return fed.trim().toUpperCase() || null;
  if (fed && typeof fed === "object") {
    const obj = fed as { id?: unknown; name?: unknown };
    if (typeof obj.id === "string") return obj.id.trim().toUpperCase() || null;
    if (typeof obj.name === "string") return obj.name.trim().toUpperCase() || null;
  }
  return null;
}

/** Parse the variable `tour.dates` field. Never invents a date. */
export function parseTourDates(dates: unknown): {
  start: number | null;
  end: number | null;
} {
  if (Array.isArray(dates)) {
    const [start, end] = dates;
    return {
      start: typeof start === "number" ? start : null,
      end: typeof end === "number" ? end : null,
    };
  }
  if (dates && typeof dates === "object") {
    const obj = dates as { start?: unknown; end?: unknown };
    return {
      start: typeof obj.start === "number" ? obj.start : null,
      end: typeof obj.end === "number" ? obj.end : null,
    };
  }
  return { start: null, end: null };
}
