import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { describe, expect, it } from "vitest";

import {
  countRefreshRefs,
  groupStaleLiveRefs,
  staleLiveEventsQuery,
  type StaleLiveRow,
} from "@/core/ingest/stale-live";
import { LIVE_FRESHNESS_WINDOW_MS } from "@/core/queries/freshness";
import { schema } from "@/lib/db";
import type { SourceRefRow } from "@/lib/db/schema";

/**
 * Which stored rows a sync asks the provider to re-read. Getting this wrong is
 * how a finished game keeps claiming to be live: too narrow and it is never
 * re-fetched, too broad and every sync spends its budget on rows that are fine.
 *
 * No database is needed — the query is asserted through `.toSQL()`, and the
 * selection rule itself is pure.
 */
const db = drizzle(
  postgres("postgres://reader@127.0.0.1:5432/unused", { prepare: false }),
  { schema },
);

const NOW = new Date("2026-08-31T12:00:00.000Z");
const MINUTE = 60 * 1000;

function source(providerRef: string, agoMs: number, provider = "lichess"): SourceRefRow {
  return {
    provider,
    providerRef,
    fetchedAt: new Date(NOW.getTime() - agoMs).toISOString(),
    url: "https://lichess.org/broadcast/x/round-4/VhSJZLbt",
  };
}

function row(
  status: StaleLiveRow["status"],
  sources: SourceRefRow[] | null,
): StaleLiveRow {
  return { status, sources };
}

describe("stale live scan SQL", () => {
  const { sql, params } = staleLiveEventsQuery(db, {
    sport: "chess",
    limit: 50,
  }).toSQL();

  it("reads only this sport's rows that claim to be live", () => {
    expect(sql).toContain('from "events"');
    expect(sql).toContain('"events"."sport"');
    expect(sql).toContain('"events"."status"');
    expect(params).toContain("chess");
    expect(params).toContain("live");
  });

  it("reads the provenance the rule needs, and bounds the scan", () => {
    expect(sql).toMatch(/select .*"sources".* from "events"/);
    expect(sql).toContain("limit");
    expect(params).toContain(50);
  });

  it("only reads", () => {
    expect(/\b(insert|update|delete|truncate|drop)\b/i.test(sql)).toBe(false);
  });
});

describe("selecting rounds to refresh", () => {
  it("selects a live row whose last fetch is outside the freshness window", () => {
    const stale = row("live", [source("VhSJZLbt/EBQUS81R", 13 * 60 * MINUTE)]);
    expect(groupStaleLiveRefs([stale], NOW)).toEqual({
      lichess: ["VhSJZLbt/EBQUS81R"],
    });
  });

  it("leaves a live row alone while its claim is still confirmed", () => {
    const fresh = row("live", [source("VhSJZLbt/EBQUS81R", 2 * MINUTE)]);
    expect(groupStaleLiveRefs([fresh], NOW)).toEqual({});
    // Exactly at the boundary is still confirmed, as the read path treats it.
    const edge = row("live", [source("VhSJZLbt/EBQUS81R", LIVE_FRESHNESS_WINDOW_MS)]);
    expect(groupStaleLiveRefs([edge], NOW)).toEqual({});
  });

  it("ignores rows that make no live claim, however old", () => {
    const rows = [
      row("recent", [source("VhSJZLbt/gDone", 40 * 24 * 60 * MINUTE)]),
      row("finished", [source("VhSJZLbt/gOld", 40 * 24 * 60 * MINUTE)]),
      row("upcoming", [source("rndNext/gSoon", 40 * 24 * 60 * MINUTE)]),
    ];
    expect(groupStaleLiveRefs(rows, NOW)).toEqual({});
  });

  it("refreshes a live row whose timestamp cannot be read", () => {
    // Nothing to address when there is no provenance at all.
    expect(groupStaleLiveRefs([row("live", [])], NOW)).toEqual({});
    expect(groupStaleLiveRefs([row("live", null)], NOW)).toEqual({});
    // But an unverifiable live claim is not a confirmed one, so a row that does
    // carry a ref is worth re-reading.
    const unparseable = row("live", [
      { provider: "lichess", providerRef: "VhSJZLbt/EBQUS81R", fetchedAt: "not a date" },
    ]);
    expect(groupStaleLiveRefs([unparseable], NOW)).toEqual({
      lichess: ["VhSJZLbt/EBQUS81R"],
    });
  });

  it("keeps each provider's refs to itself", () => {
    const rows = [
      row("live", [
        source("VhSJZLbt/EBQUS81R", 3 * 60 * MINUTE),
        source("evt-9/board-2", 3 * 60 * MINUTE, "chesscom"),
      ]),
    ];
    expect(groupStaleLiveRefs(rows, NOW)).toEqual({
      lichess: ["VhSJZLbt/EBQUS81R"],
      chesscom: ["evt-9/board-2"],
    });
  });

  it("returns each ref once, and counts what a sync will try to heal", () => {
    const rows = [
      row("live", [source("VhSJZLbt/EBQUS81R", 3 * 60 * MINUTE)]),
      row("live", [source("VhSJZLbt/EBQUS81R", 4 * 60 * MINUTE)]),
      row("live", [source("VhSJZLbt/gOther", 4 * 60 * MINUTE)]),
      // The round container itself, stored with no game half.
      row("live", [source("VhSJZLbt", 4 * 60 * MINUTE)]),
      row("live", [source(" krWy7u6E/g2 ", 4 * 60 * MINUTE)]),
    ];
    const refs = groupStaleLiveRefs(rows, NOW);
    expect(refs).toEqual({
      lichess: ["VhSJZLbt/EBQUS81R", "VhSJZLbt/gOther", "VhSJZLbt", "krWy7u6E/g2"],
    });
    expect(countRefreshRefs(refs)).toBe(4);
    expect(countRefreshRefs({})).toBe(0);
  });

  it("skips provenance with nothing to address", () => {
    const rows = [
      row("live", [
        { provider: "  ", providerRef: "VhSJZLbt/x", fetchedAt: NOW.toISOString() },
        { provider: "lichess", providerRef: "   ", fetchedAt: NOW.toISOString() },
      ]),
    ];
    expect(groupStaleLiveRefs(rows, NOW)).toEqual({});
  });

  it("honours a caller-supplied window without changing the default", () => {
    const rows = [row("live", [source("VhSJZLbt/EBQUS81R", 10 * MINUTE)])];
    expect(groupStaleLiveRefs(rows, NOW)).toEqual({});
    expect(groupStaleLiveRefs(rows, NOW, 5 * MINUTE)).toEqual({
      lichess: ["VhSJZLbt/EBQUS81R"],
    });
  });
});
