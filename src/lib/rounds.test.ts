import { describe, expect, it } from "vitest";

import type { ChessRoundProgress } from "@/core/queries/chess";
import { MAX_ROUND_SEGMENTS, roundSegments } from "@/lib/rounds";

function progress(
  overrides: Partial<ChessRoundProgress> & { total: number },
): ChessRoundProgress {
  return {
    completed: 0,
    live: 0,
    upcoming: 0,
    nextStartTime: null,
    ...overrides,
  };
}

describe("roundSegments", () => {
  it("lays the counted rounds out in playing order", () => {
    const segments = roundSegments(
      progress({ total: 7, completed: 3, live: 1, upcoming: 3 }),
    );
    expect(segments).toEqual([
      "completed",
      "completed",
      "completed",
      "live",
      "upcoming",
      "upcoming",
      "upcoming",
    ]);
  });

  it("draws a single-round tournament", () => {
    expect(roundSegments(progress({ total: 1, upcoming: 1 }))).toEqual([
      "upcoming",
    ]);
  });

  it("refuses to draw more markers than fit", () => {
    const total = MAX_ROUND_SEGMENTS + 1;
    expect(roundSegments(progress({ total, upcoming: total }))).toBeNull();
  });

  it("refuses to draw when the states do not add up to the total", () => {
    // A state this layer does not know about would leave a short bar, which
    // would read as missing rounds rather than unknown ones.
    expect(
      roundSegments(progress({ total: 5, completed: 1, upcoming: 1 })),
    ).toBeNull();
  });

  it("draws nothing for a total below one", () => {
    expect(roundSegments(progress({ total: 0 }))).toBeNull();
  });
});
