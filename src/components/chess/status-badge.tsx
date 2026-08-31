import type { CompetitionStatus, EventStatus } from "@/core/models/canonical";
import type { LiveConfidence } from "@/core/queries/chess";
import { Badge } from "@/components/ui/badge";

/**
 * Canonical status -> user-facing label. Statuses are never re-interpreted here:
 * "recent" and "finished" both mean the game is over, which is what a reader
 * cares about, and the distinction (how recently) is carried by the timestamp.
 *
 * The one status that is qualified is "live", because it is a claim about right
 * now. When the query layer could not confirm that claim the badge says so
 * instead of asserting either state — see `@/core/queries/freshness`.
 */

export function CompetitionStatusBadge({ status }: { status: CompetitionStatus }) {
  if (status === "ongoing") {
    return <Badge tone="ongoing">Ongoing</Badge>;
  }
  if (status === "upcoming") {
    return <Badge tone="upcoming">Upcoming</Badge>;
  }
  return <Badge tone="final">Finished</Badge>;
}

export function EventStatusBadge({
  status,
  liveConfidence = null,
}: {
  status: EventStatus;
  /** From `ChessGame.liveClaim`. Only consulted when `status` is "live". */
  liveConfidence?: LiveConfidence | null;
}) {
  if (status === "live") {
    if (liveConfidence === "unconfirmed") {
      // No pulsing dot: nothing is known to be moving.
      return <Badge tone="unconfirmed">Last seen live</Badge>;
    }
    return (
      <Badge tone="live">
        {/* Decorative: the word "Live" carries the meaning on its own. */}
        <span
          aria-hidden="true"
          className="size-1.5 animate-pulse rounded-full bg-white"
        />
        Live
      </Badge>
    );
  }
  if (status === "upcoming") {
    return <Badge tone="upcoming">Scheduled</Badge>;
  }
  return <Badge tone="final">Final</Badge>;
}
