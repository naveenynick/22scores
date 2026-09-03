import { describe, expect, it } from "vitest";

import {
  CricketDataApiError,
  CricketDataClient,
  CricketDataHttpError,
  CricketDataMissingKeyError,
  CricketDataTransportError,
} from "./cricketdata-client";

/**
 * Client behaviour, against an injected fetch. No network, no database.
 *
 * The recurring assertion is that the API key never escapes: CricketData
 * authenticates by query parameter, so the key is in every request URL, and an
 * error message, a `path`, or a borrowed transport message must never carry it.
 */

const KEY = "secret-key-abc123";

/** An envelope shaped like the real one — including the echoed `apikey`. */
const ok = (data: unknown, info?: Record<string, number>): string =>
  JSON.stringify({ apikey: KEY, status: "success", data, info });

const failure = (reason: string): string =>
  JSON.stringify({ apikey: KEY, status: "failure", reason });

interface Fake {
  fetchImpl: typeof fetch;
  urls: string[];
  /** Resolved in call order; a value may be an Error to throw instead. */
  queue: (Response | Error)[];
}

function fakeFetch(...responses: (Response | Error)[]): Fake {
  const fake: Fake = {
    urls: [],
    queue: [...responses],
    fetchImpl: (async (input: RequestInfo | URL) => {
      fake.urls.push(String(input));
      const next = fake.queue.shift();
      if (next === undefined) return new Response(ok([]));
      if (next instanceof Error) throw next;
      return next;
    }) as typeof fetch,
  };
  return fake;
}

const clientFor = (fake: Fake, apiKey: string | null = KEY): CricketDataClient =>
  new CricketDataClient({
    apiKey,
    fetchImpl: fake.fetchImpl,
    minIntervalMs: 0,
    maxRetries: 0,
    backoffMs: 0,
  });

describe("CricketDataClient", () => {
  it("sends the key as a query parameter and unwraps `data`", async () => {
    const fake = fakeFetch(new Response(ok([{ id: "a" }])));
    const client = clientFor(fake);

    const { data } = await client.currentMatches();

    expect(data).toEqual([{ id: "a" }]);
    expect(client.requestsMade).toBe(1);
    const url = new URL(fake.urls[0] ?? "");
    expect(url.pathname).toBe("/v1/currentMatches");
    expect(url.searchParams.get("apikey")).toBe(KEY);
    expect(url.searchParams.get("offset")).toBe("0");
  });

  it("paginates by row offset and identifies itself", async () => {
    const fake = fakeFetch(new Response(ok([])), new Response(ok([])));
    const client = clientFor(fake);

    await client.matches(25);
    await client.series(50);

    expect(fake.urls).toHaveLength(2);
    expect(fake.urls[0]).toContain("offset=25");
    expect(fake.urls[1]).toContain("/series?");
    expect(fake.urls[1]).toContain("offset=50");
  });

  it("reports the daily quota the API sends back", async () => {
    const fake = fakeFetch(
      new Response(ok([], { hitsToday: 12, hitsLimit: 100 })),
    );
    const client = clientFor(fake);
    expect(client.hitsRemaining).toBeNull();

    await client.currentMatches();

    expect(client.hitsRemaining).toBe(88);
  });

  it("treats an envelope failure as an error and never retries it", async () => {
    const fake = fakeFetch(new Response(failure("Invalid API Key")));
    const client = new CricketDataClient({
      apiKey: KEY,
      fetchImpl: fake.fetchImpl,
      minIntervalMs: 0,
      maxRetries: 3,
      backoffMs: 0,
    });

    await expect(client.currentMatches()).rejects.toThrow(CricketDataApiError);
    // A rejected key does not fix itself, so the retry budget is not spent on it.
    expect(client.requestsMade).toBe(1);
  });

  it("zeroes the remaining quota when the failure says the limit is spent", async () => {
    const fake = fakeFetch(new Response(failure("Hits limit reached")));
    const client = clientFor(fake);

    await expect(client.matches()).rejects.toThrow(/Hits limit reached/);
    expect(client.hitsRemaining).toBe(0);
  });

  it("throws before opening a connection when no key is configured", async () => {
    const fake = fakeFetch(new Response(ok([])));
    const client = clientFor(fake, null);

    expect(client.configured).toBe(false);
    await expect(client.currentMatches()).rejects.toThrow(
      CricketDataMissingKeyError,
    );
    expect(fake.urls).toEqual([]);
    expect(client.requestsMade).toBe(0);
  });

  it("treats a blank key as absent", () => {
    const fake = fakeFetch();
    expect(clientFor(fake, "   ").configured).toBe(false);
    expect(clientFor(fake, KEY).configured).toBe(true);
  });

  it("resolves the key lazily from the environment when none is passed", () => {
    const previous = process.env.CRICKETDATA_API_KEY;
    process.env.CRICKETDATA_API_KEY = KEY;
    try {
      const client = new CricketDataClient({ fetchImpl: fakeFetch().fetchImpl });
      expect(client.configured).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.CRICKETDATA_API_KEY;
      else process.env.CRICKETDATA_API_KEY = previous;
    }
  });

  it("surfaces a non-2xx status with a key-free path", async () => {
    const fake = fakeFetch(new Response("nope", { status: 500 }));
    const client = clientFor(fake);

    const error = await client.matchInfo("abc").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CricketDataHttpError);
    expect((error as CricketDataHttpError).path).toBe("/match_info?id=abc");
    expect((error as Error).message).not.toContain(KEY);
  });

  it("retries a 429 within budget, then gives up", async () => {
    const fake = fakeFetch(
      new Response("slow down", { status: 429 }),
      new Response(ok([{ id: "b" }])),
    );
    const client = new CricketDataClient({
      apiKey: KEY,
      fetchImpl: fake.fetchImpl,
      minIntervalMs: 0,
      maxRetries: 1,
      backoffMs: 0,
    });

    const { data } = await client.currentMatches();
    expect(data).toEqual([{ id: "b" }]);
    expect(client.requestsMade).toBe(2);

    const exhausted = fakeFetch(
      new Response("slow down", { status: 429 }),
      new Response("slow down", { status: 429 }),
    );
    await expect(clientFor(exhausted).currentMatches()).rejects.toThrow(
      /CricketData HTTP 429/,
    );
  });

  it("retries a transport failure, then reports it without the key", async () => {
    const recovering = fakeFetch(
      new Error("connect ECONNRESET"),
      new Response(ok([{ id: "c" }])),
    );
    const client = new CricketDataClient({
      apiKey: KEY,
      fetchImpl: recovering.fetchImpl,
      minIntervalMs: 0,
      maxRetries: 1,
      backoffMs: 0,
    });
    const { data } = await client.series();
    expect(data).toEqual([{ id: "c" }]);

    // An undici error can quote the request URL, and that URL holds the key.
    const leaky = fakeFetch(
      new Error(`fetch failed for https://api.cricapi.com/v1/matches?apikey=${KEY}`),
    );
    const error = await clientFor(leaky)
      .matches()
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CricketDataTransportError);
    expect((error as Error).message).not.toContain(KEY);
    expect((error as Error).message).toContain("<redacted>");
  });

  it("rejects a body that is not JSON without quoting it", async () => {
    const fake = fakeFetch(new Response("<html>gateway</html>"));
    const error = await clientFor(fake)
      .series()
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CricketDataApiError);
    expect((error as Error).message).toContain("response was not JSON");
    expect((error as Error).message).not.toContain("html");
  });

  it("serializes requests: one in flight at a time", async () => {
    let concurrent = 0;
    let peak = 0;
    const fetchImpl = (async () => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 5));
      concurrent -= 1;
      return new Response(ok([]));
    }) as typeof fetch;
    const client = new CricketDataClient({
      apiKey: KEY,
      fetchImpl,
      minIntervalMs: 0,
    });

    await Promise.all([
      client.currentMatches(),
      client.matches(),
      client.series(),
    ]);

    expect(peak).toBe(1);
    expect(client.requestsMade).toBe(3);
  });

  it("keeps the queue alive after a rejection", async () => {
    const fake = fakeFetch(
      new Response("boom", { status: 500 }),
      new Response(ok([{ id: "d" }])),
    );
    const client = clientFor(fake);

    const [first, second] = await Promise.allSettled([
      client.currentMatches(),
      client.matches(),
    ]);

    expect(first?.status).toBe("rejected");
    expect(second?.status).toBe("fulfilled");
  });
});
