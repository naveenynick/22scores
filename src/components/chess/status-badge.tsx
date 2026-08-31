import type { CompetitionStatus, EventStatus } from "@/core/models/canonical";
import { Badge } from "@/components/ui/badge";

/**
 * Canonical status -> user-facing label. Statuses are never re-interpreted here:
 * "recent" and "finished" both mean the game is over, which is what a reader
 * cares about, and the distinction (how recently) is carried by the timestamp.
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

export function EventStatusBadge({ status }: { status: EventStatus }) {
  if (status === "live") {
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
