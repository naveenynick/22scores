/**
 * Lichess HTTP client.
 *
 * Etiquette baked in, per Lichess's published guidance and our validation spike:
 *  - requests are SERIALIZED through one queue (never parallel),
 *  - a minimum interval is enforced between requests,
 *  - every request carries an identifying User-Agent,
 *  - requests time out instead of hanging,
 *  - 429 triggers bounded backoff + retry, then fails loudly.
 *
 * The client only fetches and parses. It never touches the database, so a
 * Lichess outage can only produce an error — never a destructive write.
 */

const DEFAULT_BASE_URL = "https://lichess.org";
const DEFAULT_MIN_INTERVAL_MS = 1200;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BACKOFF_MS = 5_000;

export interface LichessClientOptions {
  baseUrl?: string;
  userAgent?: string;
  minIntervalMs?: number;
  timeoutMs?: number;
  maxRetries?: number;
  backoffMs?: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export class LichessHttpError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
  ) {
    super(`Lichess HTTP ${status} for ${path}`);
    this.name = "LichessHttpError";
  }
}

function defaultUserAgent(): string {
  return (
    process.env.PROVIDER_CONTACT_USER_AGENT ??
    "22scores (+https://github.com/naveenynick/22scores)"
  );
}

export class LichessClient {
  private readonly baseUrl: string;
  private readonly userAgent: string;
  private readonly minIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly backoffMs: number;
  private readonly fetchImpl: typeof fetch;

  /** Tail of the serial request queue. */
  private queue: Promise<unknown> = Promise.resolve();
  private lastRequestAt = 0;
  private requestCount = 0;

  constructor(options: LichessClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.userAgent = options.userAgent ?? defaultUserAgent();
    this.minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  get requestsMade(): number {
    return this.requestCount;
  }

  private static sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Queue a task so only one Lichess request is ever in flight. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    // Keep the chain alive even when a task rejects.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async throttle(): Promise<void> {
    const waitFor = this.lastRequestAt + this.minIntervalMs - Date.now();
    if (waitFor > 0) await LichessClient.sleep(waitFor);
  }

  /** Fetch a path and return the raw response body as text. */
  async getText(path: string, accept: string): Promise<string> {
    return this.enqueue(async () => {
      let attempt = 0;
      for (;;) {
        await this.throttle();
        this.lastRequestAt = Date.now();
        this.requestCount += 1;

        let res: Response;
        try {
          res = await this.fetchImpl(`${this.baseUrl}${path}`, {
            headers: { Accept: accept, "User-Agent": this.userAgent },
            signal: AbortSignal.timeout(this.timeoutMs),
          });
        } catch (cause) {
          // Network error or timeout: retry within budget, then surface.
          if (attempt >= this.maxRetries) throw cause;
          attempt += 1;
          await LichessClient.sleep(this.backoffMs);
          continue;
        }

        if (res.status === 429) {
          if (attempt >= this.maxRetries) throw new LichessHttpError(429, path);
          attempt += 1;
          await LichessClient.sleep(this.backoffMs * attempt);
          continue;
        }
        if (!res.ok) throw new LichessHttpError(res.status, path);
        return res.text();
      }
    });
  }

  async getJson(path: string): Promise<unknown> {
    const body = await this.getText(path, "application/json");
    return JSON.parse(body) as unknown;
  }

  /** Fetch NDJSON and return one parsed value per non-empty line. */
  async getNdjson(path: string): Promise<unknown[]> {
    const body = await this.getText(path, "application/x-ndjson");
    const out: unknown[] = [];
    for (const line of body.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        out.push(JSON.parse(trimmed) as unknown);
      } catch {
        // Skip a malformed line rather than losing the whole page.
      }
    }
    return out;
  }
}
