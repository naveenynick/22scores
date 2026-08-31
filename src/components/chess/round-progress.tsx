import type { ChessRoundProgress } from "@/core/queries/chess";
import { formatDayTime, toIsoAttribute } from "@/lib/format";
import { roundSegments } from "@/lib/rounds";
import { cn } from "@/lib/utils";

/**
 * How far a tournament has got. The markers are drawn from the counted round
 * states only — there is no round ordinal in the data, so nothing here numbers a
 * round. The sentence below them is the accessible version of the same fact.
 *
 * A round the data still calls live but can no longer confirm is worded as "last
 * seen in progress" rather than "in progress": the round is not claimed to be
 * under way, and it is not claimed to be over either.
 */
export function RoundProgress({
  rounds,
  className,
}: {
  rounds: ChessRoundProgress;
  className?: string;
}) {
  const segments = roundSegments(rounds);

  return (
    <div className={cn("space-y-2", className)}>
      {segments !== null && (
        <div aria-hidden="true" className="flex items-center gap-1">
          {segments.map((state, index) => (
            <span
              key={index}
              className={cn(
                "h-1.5 flex-1 rounded-full",
                state === "completed" && "bg-foreground/70",
                state === "live" && "bg-rose-600",
                state === "live-unconfirmed" && "bg-amber-400",
                state === "upcoming" && "bg-foreground/15",
              )}
            />
          ))}
        </div>
      )}
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs sm:text-[0.8125rem]">
        <span className="font-semibold tabular-nums">
          {rounds.completed} of {rounds.total}{" "}
          {rounds.total === 1 ? "round" : "rounds"} played
        </span>
        {rounds.live > 0 ? (
          <span className="font-semibold text-rose-700">Round in progress</span>
        ) : rounds.liveUnconfirmed > 0 ? (
          <span className="font-semibold text-amber-800">
            Round last seen in progress
          </span>
        ) : (
          rounds.nextStartTime !== null && (
            <span className="text-muted-foreground">
              Next round{" "}
              <time dateTime={toIsoAttribute(rounds.nextStartTime)}>
                {formatDayTime(rounds.nextStartTime)}
              </time>
            </span>
          )
        )}
      </p>
    </div>
  );
}
