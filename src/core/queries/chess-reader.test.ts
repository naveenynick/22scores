import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { describe, expect, it } from "vitest";

import {
  competitionRoundsQuery,
  gameSidesQuery,
  gamesQuery,
  tournamentGmsQuery,
  tournamentsQuery,
} from "@/core/queries/chess-reader";
import { schema } from "@/lib/db";

/**
 * SQL-shape tests. postgres.js connects lazily and `.toSQL()` only renders the
 * statement, so nothing here opens a socket or needs a database. The point is to
 * pin down the parts that silently change behaviour if they regress: the
 * relevance join, the confirmed-GM requirement, null-safe ordering, and the fact
 * that this layer only ever reads.
 */
const db = drizzle(
  postgres("postgres://reader@127.0.0.1:5432/unused", { prepare: false }),
  { schema },
);

function isReadOnly(sql: string): boolean {
  return !/\b(insert|update|delete|truncate|drop)\b/i.test(sql);
}

describe("tournament SQL", () => {
  const { sql, params } = tournamentsQuery(db, {
    countryIso2: "IN",
    statuses: ["ongoing", "upcoming"],
    order: "desc",
    limit: 7,
  }).toSQL();

  it("enters through the competition relevance index", () => {
    expect(sql).toContain('from "competitions"');
    expect(sql).toContain('"competition_relevant_countries"');
    expect(sql).toContain('"relevance_country"."iso2"');
    expect(params).toContain("IN");
    expect(params).toContain("chess");
  });

  it("requires a confirmed GM entrant from that country", () => {
    expect(sql).toContain("exists");
    expect(sql).toContain('"competition_participants"');
    expect(sql).toContain('upper("participants"."title")');
    expect(sql).toContain('"gm_country"."iso2"');
    expect(params).toContain("GM");
  });

  it("sorts undated rows last and bounds the result", () => {
    expect(sql).toContain('"competitions"."start_date" desc nulls last');
    expect(sql).toContain("limit");
    expect(params).toContain(7);
  });

  it("only reads", () => {
    expect(isReadOnly(sql)).toBe(true);
  });
});

describe("game SQL", () => {
  const { sql, params } = gamesQuery(db, {
    countryIso2: "IN",
    statuses: ["live"],
    order: "desc",
    limit: 3,
  }).toSQL();

  it("selects India-relevant chess games only", () => {
    expect(sql).toContain('from "events"');
    expect(sql).toContain('"event_relevant_countries"');
    expect(params).toContain("game");
    expect(params).toContain("live");
    expect(params).toContain("IN");
  });

  it("requires a confirmed GM from that country to have played", () => {
    expect(sql).toContain("exists");
    expect(sql).toContain('"event_participants"');
    expect(sql).toContain('upper("participants"."title")');
    expect(params).toContain("GM");
  });

  it("left joins the competition so an unlinked game still appears", () => {
    expect(sql).toContain('left join "competitions"');
    expect(sql).toContain('"events"."start_time" desc nulls last');
    expect(isReadOnly(sql)).toBe(true);
  });

  it("orders ascending when asked", () => {
    const ascending = gamesQuery(db, {
      countryIso2: "IN",
      statuses: ["upcoming"],
      order: "asc",
      limit: 3,
    }).toSQL();
    expect(ascending.sql).toContain('"events"."start_time" asc nulls last');
  });
});

describe("child batch SQL", () => {
  it("fetches entrants for many competitions in one statement", () => {
    const { sql, params } = tournamentGmsQuery(db, {
      competitionIds: ["a", "b", "c"],
      countryIso2: "IN",
    }).toSQL();
    expect(sql).toContain('"competition_participants"."competition_id" in ');
    expect(params).toEqual(expect.arrayContaining(["a", "b", "c"]));
    expect(sql).toContain('upper("participants"."title")');
    expect(isReadOnly(sql)).toBe(true);
  });

  it("fetches every side for many events in one statement", () => {
    const { sql, params } = gameSidesQuery(db, {
      eventIds: ["e1", "e2"],
    }).toSQL();
    expect(sql).toContain('"event_participants"."event_id" in ');
    expect(params).toEqual(expect.arrayContaining(["e1", "e2"]));
    // Country is left joined: an opponent with unknown federation must appear.
    expect(sql).toContain('left join "countries" "participant_country"');
    expect(sql).not.toContain("upper(");
    expect(isReadOnly(sql)).toBe(true);
  });

  it("fetches round containers for many competitions in one statement", () => {
    const { sql, params } = competitionRoundsQuery(db, {
      competitionIds: ["c1", "c2"],
    }).toSQL();
    expect(sql).toContain('from "events"');
    expect(sql).toContain('"events"."competition_id" in ');
    expect(params).toEqual(expect.arrayContaining(["c1", "c2", "round"]));
    // Rounds carry no sides, so nothing is joined to them.
    expect(sql).not.toContain("join");
    expect(sql).toContain('"events"."start_time" asc nulls last');
    expect(isReadOnly(sql)).toBe(true);
  });

  it("reads a round's provenance so the freshness rule can judge it", () => {
    // Without `sources` a round stored as live could never be checked, and the
    // tournament would advertise a round in progress forever.
    const { sql } = competitionRoundsQuery(db, {
      competitionIds: ["c1"],
    }).toSQL();
    expect(sql).toMatch(/select .*"sources".* from "events"/);
  });
});
