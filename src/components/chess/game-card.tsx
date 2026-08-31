import type { ChessGame, ChessGameSide } from "@/core/queries/chess";
import { EventStatusBadge } from "@/components/chess/status-badge";
import { Badge } from "@/components/ui/badge";
import { ExternalEventLinkButton } from "@/components/ui/external-link-button";
import { cn } from "@/lib/utils";
import {
  CHESS_GAME_LINK_LABELS,
  resolveExternalEventLink,
} from "@/lib/external-links";
import { formatDayTime, toIsoAttribute } from "@/lib/format";

/**
 * One game, laid out like a scoreboard: the tournament and state on top, one row
 * per side in board order (white first) as recorded, outcome right-aligned so a
 * column of games lines up, and the game result underneath.
 *
 * The side from the country being viewed is highlighted in place rather than
 * moved to the top: board order is a fact, and reordering it would hide who had
 * white.
 *
 * A game the data still calls live but the query layer could not confirm is
 * presented as *last seen in progress*: no pulsing badge, no "Watch now", no
 * invented result, and no claim that it finished. Only the confidence changes —
 * see `@/core/queries/freshness`.
 *
 * The card itself is not a link. The provenance URL leads off-site, and one
 * outbound action ("Watch now" while live, "View game" once over) is easier to
 * reach by keyboard and to describe than a card-sized target wrapped around the
 * player rows. It appears only when the stored source can be trusted.
 */
export function GameCard({
  game,
  countryIso2,
}: {
  game: ChessGame;
  countryIso2: string;
}) {
  const claim = game.liveClaim;
  // Confirmed live only: "Watch now" and the live tint must never appear on a
  // row whose live claim has aged out.
  const isLive = claim?.confidence === "confirmed";
  const isUnconfirmed = claim?.confidence === "unconfirmed";
  // Only worth printing when the claim is the thing in doubt; a confirmed row's
  // fetch time is already covered by the page's own "updated" line.
  const lastSeenAt = isUnconfirmed ? (claim?.lastSeenAt ?? null) : null;
  const link = resolveExternalEventLink({
    sources: game.sources,
    isLive,
    labels: CHESS_GAME_LINK_LABELS,
    context: gameSubject(game),
  });

  return (
    <li
      className={cn(
        "overflow-hidden rounded-xl border bg-card shadow-sm",
        isLive && "border-rose-200 ring-1 ring-rose-100",
        isUnconfirmed && "border-amber-200",
      )}
    >
      <article>
        <div
          className={cn(
            "flex items-center gap-2 border-b px-3 py-2 sm:px-4",
            isLive
              ? "bg-rose-50/70"
              : isUnconfirmed
                ? "bg-amber-50/60"
                : "bg-muted/40",
          )}
        >
          <EventStatusBadge
            status={game.status}
            liveConfidence={claim?.confidence ?? null}
          />
          <h3 className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">
            {game.competitionName ?? "Tournament not recorded"}
          </h3>
        </div>

        {game.sides.length === 0 ? (
          <p className="px-3 py-4 text-sm text-muted-foreground sm:px-4">
            Players not recorded yet.
          </p>
        ) : (
          <ul className="divide-y">
            {game.sides.map((side) => (
              <SideRow
                key={`${side.role ?? "side"}-${side.name}`}
                side={side}
                highlight={side.countryIso2 === countryIso2}
              />
            ))}
          </ul>
        )}

        <footer className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t bg-muted/20 px-3 py-2.5 text-xs sm:px-4">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
            <p>
              {game.result !== null ? (
                <>
                  <span className="text-muted-foreground">Result </span>
                  <span className="font-bold tabular-nums">{game.result}</span>
                </>
              ) : isLive ? (
                <span className="font-semibold text-rose-700">In progress</span>
              ) : isUnconfirmed ? (
                // Not "Result not recorded", which reads as a finished game with
                // a missing score. Nothing here is known to have finished.
                <span className="font-semibold text-amber-800">
                  Last seen in progress
                </span>
              ) : (
                <span className="font-semibold text-muted-foreground">
                  Result not recorded
                </span>
              )}
            </p>
            {game.startTime !== null && (
              <p className="text-muted-foreground">
                {game.status === "upcoming" ? "Starts " : "Started "}
                <time dateTime={toIsoAttribute(game.startTime)}>
                  {formatDayTime(game.startTime)}
                </time>
              </p>
            )}
            {lastSeenAt !== null && (
              <p className="text-muted-foreground">
                Not confirmed since{" "}
                <time dateTime={toIsoAttribute(lastSeenAt)}>
                  {formatDayTime(lastSeenAt)}
                </time>
              </p>
            )}
          </div>
          {link !== null && <ExternalEventLinkButton link={link} />}
        </footer>
      </article>
    </li>
  );
}

/**
 * What the outbound link leads to, for its accessible name. Built only from
 * recorded values, so it shortens to the players or the tournament alone rather
 * than filling a gap.
 */
function gameSubject(game: ChessGame): string | null {
  const players = game.sides.map((side) => side.name).join(" vs ");
  if (game.competitionName === null) return players === "" ? null : players;
  return players === ""
    ? game.competitionName
    : `${players} at ${game.competitionName}`;
}

const SIDE_RESULT_LABEL: Record<string, string> = {
  win: "Win",
  loss: "Loss",
  draw: "Draw",
};

/**
 * One player. The highlighted side is marked three ways — a rule down the left
 * edge, a tinted row and a filled federation chip — so it survives without
 * colour and without competing with the win/loss tints on the right.
 */
function SideRow({
  side,
  highlight,
}: {
  side: ChessGameSide;
  highlight: boolean;
}) {
  return (
    <li
      className={cn(
        "relative flex items-center gap-2.5 px-3 py-2.5 sm:px-4",
        highlight && "bg-muted/60",
      )}
    >
      {highlight && (
        <span
          aria-hidden="true"
          className="absolute inset-y-0 left-0 w-[3px] bg-foreground"
        />
      )}
      <RoleMark role={side.role} />
      <p
        className={cn(
          "min-w-0 flex-1 text-sm leading-snug sm:text-[0.9375rem]",
          highlight ? "font-bold" : "font-medium",
        )}
      >
        {side.title !== null && (
          <span className="mr-1.5 rounded bg-muted px-1 py-0.5 text-[0.625rem] font-bold uppercase leading-none tracking-[0.06em] text-muted-foreground">
            {side.title}
          </span>
        )}
        {side.name}
        {side.countryIso2 !== null && (
          <span className="ml-1.5 inline-block">
            <Badge tone={highlight ? "solid" : "neutral"} size="sm">
              <span className="sr-only">federation </span>
              {side.countryIso2}
            </Badge>
          </span>
        )}
      </p>
      <SideOutcome score={side.score} result={side.result} />
    </li>
  );
}

/** Right-hand column: a score if one is recorded, and the side's outcome. */
function SideOutcome({
  score,
  result,
}: {
  score: string | null;
  result: string | null;
}) {
  if (score === null && result === null) return null;
  return (
    <div className="flex shrink-0 items-center gap-2">
      {score !== null && (
        <span className="min-w-5 text-right text-sm font-bold tabular-nums">
          <span className="sr-only">score </span>
          {score}
        </span>
      )}
      {result !== null && (
        <span
          className={cn(
            "rounded px-1.5 py-1 text-[0.625rem] font-bold uppercase leading-none tracking-[0.06em]",
            result === "win" && "bg-emerald-100 text-emerald-900",
            result === "loss" && "bg-rose-100 text-rose-900",
            result === "draw" && "bg-slate-200 text-slate-800",
            !(result in SIDE_RESULT_LABEL) &&
              "bg-secondary text-secondary-foreground",
          )}
        >
          {SIDE_RESULT_LABEL[result] ?? result}
        </span>
      )}
    </div>
  );
}

/** White/black square. The letter is decorative; the word is for assistive tech. */
function RoleMark({ role }: { role: string | null }) {
  const known = role === "white" || role === "black";
  const isWhite = role === "white";
  return (
    <span className="flex shrink-0 items-center">
      <span className="sr-only">
        {known ? (isWhite ? "White" : "Black") : "Side not recorded"}
      </span>
      <span
        aria-hidden="true"
        className={cn(
          "grid size-6 place-items-center rounded-md border text-[0.6875rem] font-bold",
          known
            ? isWhite
              ? "border-slate-300 bg-white text-slate-800"
              : "border-slate-900 bg-slate-900 text-white"
            : "border-dashed text-muted-foreground",
        )}
      >
        {known ? (isWhite ? "W" : "B") : "?"}
      </span>
    </span>
  );
}
