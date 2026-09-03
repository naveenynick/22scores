import { getEnv } from "@/lib/env";

import { CricketDataEnvelope, type CricketDataInfo } from "./cricketdata-schemas";

/**
 * CricketData (api.cricapi.com/v1) HTTP client.
 *
 * Transport only: it serializes requests, retries a bounded number of times,
 * unwraps the response envelope, and hands back the raw `data` payload. It does
 * no schema validation beyond the envelope (that is the provider's job via the
 * permissive schemas), and it never touches the database.
 *
 * Two things make this stricter than the Lichess client:
 *
 *  1. Authentication is a QUERY PARAMETER (`?apikey=...`), not a header. That
 *     means the API key is inside every request URL, so the URL can never be put
 *     into an error message, a log line, or a thrown transport error. Every error
 *     raised here carries a `path` built WITHOUT the key, and any borrowed message
 *     text is passed through `scrub()` first.
 *  2. The free plan allows 100 requests per DAY. `hitsRemaining` surfaces the
 *     quota the API reports back in `info` so the provider can stop making
 *     optional calls instead of burning a day's budget on one sync.
 */

const DEFAULT_BASE_URL = "https://api.cricapi.com/v1";
const DEFAULT_MIN_INTERVAL_MS = 1200;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BACKOFF_MS = 5_000;

/** Reasons that mean "stop asking today", not "try again in a moment". */
const QUOTA_EXHAUSTED = /\b(limit|exhaust|quota|upgrade|credit)/i;

export interface CricketDataClientOptions {
  baseUrl?: string;
  /**
   * Key override. Omit to read the validated environment lazily; pass null or ""
   * to model "not configured" without mutating the environment (what the
   * missing-credentials tests do).
   */
  apiKey?: string | null;
  userAgent?: string;
  minIntervalMs?: number;
  timeoutMs?: number;
  maxRetries?: number;
  backoffMs?: number;
  fetchImpl?: typeof fetch;
}

/** A non-2xx response. `path` is key-free and safe to log. */
export class CricketDataHttpError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
  ) {
    super(`CricketData HTTP ${status} for ${path}`);
    this.name = "CricketDataHttpError";
  }
}

/**
 * The transport succeeded but the API declined: `status: "failure"`, with a
 * `reason` such as a rejected key or an exhausted daily quota. Not retried —
 * neither of those resolves itself within a request budget.
 */
export class CricketDataApiError extends Error {
  constructor(
    readonly reason: string,
    readonly path: string,
  ) {
    super(`CricketData error for ${path}: ${reason}`);
    this.name = "CricketDataApiError";
  }
}

/**
 * A network-level failure, re-thrown as our own type on purpose: an undici error
 * can quote the request URL, and this provider's URLs contain the API key.
 */
export class CricketDataTransportError extends Error {
  constructor(
    readonly path: string,
    detail: string,
  ) {
    super(`CricketData request to ${path} failed: ${detail}`);
    this.name = "CricketDataTransportError";
  }
}

/** No key configured. Thrown before any socket is opened. */
export class CricketDataMissingKeyError extends Error {
  constructor() {
    super("CRICKETDATA_API_KEY is not configured");
    this.name = "CricketDataMissingKeyError";
  }
}

/** The `data` payload plus the quota metadata that came with it. */
export interface CricketDataResponse {
  data: unknown;
  info: CricketDataInfo | null;
}

type QueryParams = Readonly<Record<string, string | number>>;

function defaultUserAgent(): string {
  return (
    process.env.PROVIDER_CONTACT_USER_AGENT ??
    "22scores (contact: you@example.com)"
  );
}

/**
 * The key, from the validated environment.
 *
 * `getEnv()` validates the WHOLE schema, so on a machine with no DATABASE_URL it
 * throws — and "no database configured" must not present itself as "cricket is
 * broken". The raw variable is the documented fallback for exactly that case;
 * the validated path is still the one that normally runs.
 */
function apiKeyFromEnv(): string | null {
  let raw: string | undefined;
  try {
    raw = getEnv().CRICKETDATA_API_KEY;
  } catch {
    raw = process.env.CRICKETDATA_API_KEY;
  }
  const key = raw?.trim() ?? "";
  return key === "" ? null : key;
}

export class CricketDataClient {
  private readonly baseUrl: string;
  private readonly apiKeyOption: string | null | undefined;
  private readonly userAgent: string;
  private readonly minIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly backoffMs: number;
  private readonly fetchImpl: typeof fetch;

  /** Serializes every request: one in flight at a time, like the Lichess client. */
  private queue: Promise<unknown> = Promise.resolve();
  private lastRequestAt = 0;
  private requestCount = 0;
  private hitsLeft: number | null = null;
  private keyResolved = false;
  private resolvedKey: string | null = null;

  constructor(options: CricketDataClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.apiKeyOption = options.apiKey;
    this.userAgent = options.userAgent ?? defaultUserAgent();
    this.minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  /** How many requests this client has actually sent. */
  get requestsMade(): number {
    return this.requestCount;
  }

  /**
   * Requests left in the provider's daily allowance, as the API last reported it,
   * or null before the first response. 0 means the day is spent.
   */
  get hitsRemaining(): number | null {
    return this.hitsLeft;
  }

  /** Whether a key is available. Costs nothing and opens no connection. */
  get configured(): boolean {
    return this.apiKey !== null;
  }

  /**
   * Resolved lazily and memoized. The registry constructs providers at import
   * time, and reading validated env there would make `next build` depend on a
   * live database configuration.
   */
  private get apiKey(): string | null {
    if (this.apiKeyOption !== undefined) {
      const explicit = this.apiKeyOption?.trim() ?? "";
      return explicit === "" ? null : explicit;
    }
    if (!this.keyResolved) {
      this.resolvedKey = apiKeyFromEnv();
      this.keyResolved = true;
    }
    return this.resolvedKey;
  }

  /** Remove the key from any text that is about to be surfaced. */
  private scrub(text: string): string {
    const key = this.apiKey;
    return key === null ? text : text.split(key).join("<redacted>");
  }

  private static sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    // Both settle paths chain the same task, so one rejection cannot break the
    // queue for every request behind it.
    const run = this.queue.then(task, task);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async throttle(): Promise<void> {
    const wait = this.lastRequestAt + this.minIntervalMs - Date.now();
    if (wait > 0) await CricketDataClient.sleep(wait);
  }

  private absorbQuota(info: CricketDataInfo | null): void {
    if (info === null) return;
    const { hitsToday, hitsLimit } = info;
    if (typeof hitsToday === "number" && typeof hitsLimit === "number") {
      this.hitsLeft = Math.max(0, hitsLimit - hitsToday);
    }
  }

  /** Endpoint plus its non-secret parameters. Never includes the key. */
  private static safePath(endpoint: string, params: QueryParams): string {
    const entries = Object.entries(params);
    if (entries.length === 0) return `/${endpoint}`;
    const query = entries
      .map(([key, value]) => `${key}=${String(value)}`)
      .join("&");
    return `/${endpoint}?${query}`;
  }

  private url(endpoint: string, params: QueryParams, key: string): string {
    const url = new URL(`${this.baseUrl}/${endpoint}`);
    url.searchParams.set("apikey", key);
    for (const [name, value] of Object.entries(params)) {
      url.searchParams.set(name, String(value));
    }
    return url.toString();
  }

  /**
   * One v1 call. Resolves with the unwrapped `data`, or throws:
   * `CricketDataMissingKeyError` (no key — nothing sent), `CricketDataHttpError`,
   * `CricketDataApiError` (envelope said failure), `CricketDataTransportError`.
   */
  async request(
    endpoint: string,
    params: QueryParams = {},
  ): Promise<CricketDataResponse> {
    const key = this.apiKey;
    if (key === null) throw new CricketDataMissingKeyError();
    const path = CricketDataClient.safePath(endpoint, params);
    const target = this.url(endpoint, params, key);

    return this.enqueue(async () => {
      let attempt = 0;
      for (;;) {
        await this.throttle();
        this.lastRequestAt = Date.now();
        this.requestCount += 1;

        let res: Response;
        try {
          res = await this.fetchImpl(target, {
            headers: { Accept: "application/json", "User-Agent": this.userAgent },
            signal: AbortSignal.timeout(this.timeoutMs),
          });
        } catch (cause) {
          if (attempt >= this.maxRetries) {
            const detail =
              cause instanceof Error ? this.scrub(cause.message) : "unknown error";
            throw new CricketDataTransportError(path, detail);
          }
          attempt += 1;
          await CricketDataClient.sleep(this.backoffMs * attempt);
          continue;
        }

        if (res.status === 429) {
          if (attempt >= this.maxRetries) {
            throw new CricketDataHttpError(429, path);
          }
          attempt += 1;
          await CricketDataClient.sleep(this.backoffMs * attempt);
          continue;
        }
        if (!res.ok) throw new CricketDataHttpError(res.status, path);

        // Parsed from text so a non-JSON body cannot leak into an error message.
        let payload: unknown;
        try {
          payload = JSON.parse(await res.text());
        } catch {
          throw new CricketDataApiError("response was not JSON", path);
        }
        const envelope = CricketDataEnvelope.safeParse(payload);
        if (!envelope.success) {
          throw new CricketDataApiError("unrecognized response envelope", path);
        }

        const info = envelope.data.info ?? null;
        this.absorbQuota(info);

        const status = envelope.data.status;
        if (status !== undefined && status.toLowerCase() !== "success") {
          const reason = this.scrub(envelope.data.reason ?? "request failed");
          if (QUOTA_EXHAUSTED.test(reason)) this.hitsLeft = 0;
          throw new CricketDataApiError(reason, path);
        }

        return { data: envelope.data.data ?? null, info };
      }
    });
  }

  /** `/currentMatches` — live and in-progress matches. The only feed with scores. */
  currentMatches(offset = 0): Promise<CricketDataResponse> {
    return this.request("currentMatches", { offset });
  }

  /** `/matches` — the full fixture list, 25 per page, no scores. */
  matches(offset = 0): Promise<CricketDataResponse> {
    return this.request("matches", { offset });
  }

  /** `/series` — series index, 25 per page. */
  series(offset = 0): Promise<CricketDataResponse> {
    return this.request("series", { offset });
  }

  /** `/series_info` — one series plus its match list. */
  seriesInfo(id: string): Promise<CricketDataResponse> {
    return this.request("series_info", { id });
  }

  /** `/match_info` — one match, re-read directly by its provider id. */
  matchInfo(id: string): Promise<CricketDataResponse> {
    return this.request("match_info", { id });
  }
}
