import type { ChessRoundProgress } from "@/core/queries/chess";

/**
 * Turning counted round states into something drawable.
 *
 * The canonical schema has no round ordinal, so this never claims "round 4":
 * it lays the counted rounds out in playing order (played, then any round in
 * progress, then the rest) purely so progress can be seen at a glance.
 */

export type RoundSegmentState = "completed" | "live" | "upcoming";

/** Above this, one marker per round stops being readable on a phone. */
export const MAX_ROUND_SEGMENTS = 15;

/**
 * One marker per round, or null when the rounds cannot be drawn that way — too
 * many, or a total that does not match the counted states. Callers fall back to
 * the sentence ("3 of 7 rounds played"), which is always shown either way.
 */
export function roundSegments(
  rounds: ChessRoundProgress,
): RoundSegmentState[] | null {
  const { total, completed, live, upcoming } = rounds;
  if (total < 1 || total > MAX_ROUND_SEGMENTS) return null;
  if (completed + live + upcoming !== total) return null;
  return [
    ...(Array<RoundSegmentState>(completed).fill("completed")),
    ...(Array<RoundSegmentState>(live).fill("live")),
    ...(Array<RoundSegmentState>(upcoming).fill("upcoming")),
  ];
}
