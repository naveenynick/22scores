import { describe, expect, it } from "vitest";

import {
  classifyLiveClaim,
  isConfirmedLive,
  liveClaimFor,
  newestFetchedAt,
  LIVE_FRESHNESS_WINDOW_MS,
} from "@/core/queries/freshness";

/**
 * The freshness rule is the one place "is this still live?" is decided, so it is
 * tested directly and at its edges: the boundary, missing and unusable
 * provenance, several sources, and a clock that disagrees with ingestion.
 */

const NOW = new Date("2026-08-31T12:00:00.000Z");

/** An ISO timestamp `ms` before `NOW`. */
function ago(ms: number): string {
  return new Date(NOW.getTime() - ms).toISOString();
}

function sources(...fetchedAt: string[]): { fetchedAt: string }[] {
  return fetchedAt.map((value) => ({ fetchedAt: value }));
}

describe("the window", () => {
  it("is inside the range chess live data can tolerate", () => {
    // Documented as 20–30 minutes: a shorter window flags genuinely live
    // classical games, a longer one lets a finished game keep claiming to play.
    expect(LIVE_FRESHNESS_WINDOW_MS).toBeGreaterThanOrEqual(20 * 60 * 1000);
    expect(LIVE_FRESHNESS_WINDOW_MS).toBeLessThanOrEqual(30 * 60 * 1000);
  });
});

describe("newestFetchedAt", () => {
  it("takes the newest source, whatever order they arrive in", () => {
    expect(
      newestFetchedAt(sources(ago(60_000), ago(600_000), ago(120_000))),
    ).toEqual(new Date(ago(60_000)));
  });

  it("returns null when there is nothing to read", () => {
    expect(newestFetchedAt([])).toBeNull();
  });

  it("ignores a value that does not parse rather than counting it", () => {
    expect(newestFetchedAt(sources("not a date"))).toBeNull();
    expect(newestFetchedAt(sources("not a date", ago(1000)))).toEqual(
      new Date(ago(1000)),
    );
  });
});

describe("classifyLiveClaim", () => {
  it("confirms a fetch inside the window and reports its age", () => {
    const claim = classifyLiveClaim(sources(ago(60_000)), NOW);
    expect(claim).toEqual({
      confidence: "confirmed",
      lastSeenAt: new Date(ago(60_000)),
      ageMs: 60_000,
      windowMs: LIVE_FRESHNESS_WINDOW_MS,
    });
  });

  it("still confirms a fetch exactly on the boundary", () => {
    expect(
      classifyLiveClaim(sources(ago(LIVE_FRESHNESS_WINDOW_MS)), NOW)
        .confidence,
    ).toBe("confirmed");
  });

  it("stops confirming one millisecond past the boundary", () => {
    const claim = classifyLiveClaim(
      sources(ago(LIVE_FRESHNESS_WINDOW_MS + 1)),
      NOW,
    );
    expect(claim.confidence).toBe("unconfirmed");
    // The fact survives the verdict: a caller can say when it was last seen.
    expect(claim.lastSeenAt).toEqual(new Date(ago(LIVE_FRESHNESS_WINDOW_MS + 1)));
    expect(claim.ageMs).toBe(LIVE_FRESHNESS_WINDOW_MS + 1);
  });

  it("cannot confirm a claim with no usable provenance", () => {
    for (const list of [sources(), sources("nonsense")]) {
      expect(classifyLiveClaim(list, NOW)).toEqual({
        confidence: "unconfirmed",
        lastSeenAt: null,
        ageMs: null,
        windowMs: LIVE_FRESHNESS_WINDOW_MS,
      });
    }
  });

  it("treats a future fetch time as clock skew, not staleness", () => {
    const claim = classifyLiveClaim(sources(ago(-90_000)), NOW);
    expect(claim.confidence).toBe("confirmed");
    expect(claim.ageMs).toBe(0);
  });

  it("is fresh as long as its freshest source is", () => {
    expect(
      classifyLiveClaim(
        sources(ago(LIVE_FRESHNESS_WINDOW_MS * 4), ago(30_000)),
        NOW,
      ).confidence,
    ).toBe("confirmed");
  });

  it("honours an explicit window so the rule stays configurable in one place", () => {
    const list = sources(ago(10 * 60 * 1000));
    expect(classifyLiveClaim(list, NOW, 5 * 60 * 1000).confidence).toBe(
      "unconfirmed",
    );
    expect(classifyLiveClaim(list, NOW, 15 * 60 * 1000).confidence).toBe(
      "confirmed",
    );
  });
});

describe("liveClaimFor", () => {
  it("makes no claim about a row that never said it was live", () => {
    for (const status of ["upcoming", "recent", "finished"] as const) {
      expect(
        liveClaimFor({ status, sources: sources(ago(1000)) }, NOW),
      ).toBeNull();
      expect(isConfirmedLive({ status, sources: sources(ago(1000)) }, NOW)).toBe(
        false,
      );
    }
  });

  it("answers a live row with a claim either way", () => {
    const fresh = { status: "live", sources: sources(ago(1000)) } as const;
    const stale = {
      status: "live",
      sources: sources(ago(LIVE_FRESHNESS_WINDOW_MS * 2)),
    } as const;

    expect(liveClaimFor(fresh, NOW)?.confidence).toBe("confirmed");
    expect(liveClaimFor(stale, NOW)?.confidence).toBe("unconfirmed");
    expect(isConfirmedLive(fresh, NOW)).toBe(true);
    expect(isConfirmedLive(stale, NOW)).toBe(false);
  });
});
