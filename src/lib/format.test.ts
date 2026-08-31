import { describe, expect, it } from "vitest";

import {
  formatDateRange,
  formatDay,
  formatDayTime,
  formatRelativeTime,
  formatTime,
  TIME_ZONE_LABEL,
  toIsoAttribute,
} from "@/lib/format";

/**
 * Assertions are deliberately loose about ICU's exact punctuation (a minor Node
 * upgrade can change a space or the case of "pm") and strict about the things a
 * reader would notice: the IST calendar day, the timezone label, how a range
 * collapses, and that a missing date produces nothing at all.
 */

const AUG_27 = new Date("2026-08-27T14:30:00.000Z"); // 8:00 pm IST
const SEP_02 = new Date("2026-09-02T14:30:00.000Z");

describe("absolute formatting", () => {
  it("renders the IST calendar day", () => {
    expect(formatDay(AUG_27)).toContain("27");
    expect(formatDay(AUG_27)).toContain("Aug");
    expect(formatDay(AUG_27)).toContain("2026");
  });

  it("shifts a late-UTC time into the next IST day", () => {
    // 22:00 UTC on 31 Aug is already 03:30 on 1 Sep in Kolkata.
    const lateUtc = new Date("2026-08-31T22:00:00.000Z");
    expect(formatDay(lateUtc)).toContain("1 Sep");
  });

  it("labels the timezone on every time", () => {
    expect(formatTime(AUG_27)).toContain(TIME_ZONE_LABEL);
    expect(formatTime(AUG_27)).toContain("8:00");
    expect(formatDayTime(AUG_27)).toContain("27 Aug 2026");
    expect(formatDayTime(AUG_27)).toContain(TIME_ZONE_LABEL);
  });

  it("emits a machine-readable timestamp for <time dateTime>", () => {
    expect(toIsoAttribute(AUG_27)).toBe("2026-08-27T14:30:00.000Z");
  });
});

describe("date ranges", () => {
  it("prints the year once when both ends share it", () => {
    // CLDR abbreviates September as "Sept" in en-IN; both spellings are fine.
    expect(formatDateRange(AUG_27, SEP_02)).toMatch(/^27 Aug – 2 Sept? 2026$/);
  });

  it("prints both years across a new year", () => {
    const range = formatDateRange(
      new Date("2026-12-28T06:00:00.000Z"),
      new Date("2027-01-04T06:00:00.000Z"),
    );
    expect(range).toContain("2026");
    expect(range).toContain("2027");
  });

  it("collapses a single-day event", () => {
    expect(formatDateRange(AUG_27, AUG_27)).toBe("27 Aug 2026");
  });

  it("stays open-ended when only one end is known", () => {
    expect(formatDateRange(AUG_27, null)).toBe("From 27 Aug 2026");
    expect(formatDateRange(null, SEP_02)).toMatch(/^Until 2 Sept? 2026$/);
  });

  it("returns null rather than inventing a date", () => {
    expect(formatDateRange(null, null)).toBeNull();
  });
});

describe("relative time", () => {
  const now = new Date("2026-08-31T12:00:00.000Z");

  it("treats a few seconds as now", () => {
    expect(formatRelativeTime(new Date("2026-08-31T11:59:40.000Z"), now)).toBe(
      "just now",
    );
  });

  it("counts backwards in the largest sensible unit", () => {
    expect(formatRelativeTime(new Date("2026-08-31T11:35:00.000Z"), now)).toBe(
      "25 minutes ago",
    );
    expect(formatRelativeTime(new Date("2026-08-31T09:00:00.000Z"), now)).toBe(
      "3 hours ago",
    );
    expect(formatRelativeTime(new Date("2026-08-29T12:00:00.000Z"), now)).toBe(
      "2 days ago",
    );
  });

  it("handles a future time", () => {
    expect(formatRelativeTime(new Date("2026-08-31T14:00:00.000Z"), now)).toBe(
      "in 2 hours",
    );
  });
});
