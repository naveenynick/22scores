import type { ChessTournament, ChessTournamentGm } from "@/core/queries/chess";
import { CompetitionStatusBadge } from "@/components/chess/status-badge";
import { RoundProgress } from "@/components/chess/round-progress";
import { formatDateRange, formatRelativeTime, toIsoAttribute } from "@/lib/format";

/**
 * One tournament. Every row is omitted when the underlying value is missing, so
 * an absent date or entrant list is visibly absent rather than filled in.
 *
 * The card reads top to bottom as: what it is, when it is, how far it has got,
 * and who from this country is in it.
 */
export function TournamentCard({
  tournament,
  countryLabel,
  now,
}: {
  tournament: ChessTournament;
  countryLabel: string;
  /** Render time, used only for a "starts in …" countdown. */
  now?: Date;
}) {
  const dates = formatDateRange(tournament.startDate, tournament.endDate);
  const { rounds, startDate } = tournament;
  const countdown =
    tournament.status === "upcoming" && startDate !== null && now !== undefined
      ? `Starts ${formatRelativeTime(startDate, now)}`
      : null;

  return (
    <li className="overflow-hidden rounded-xl border bg-card shadow-sm">
      <article>
        <div className="p-4 sm:p-5">
          <div className="flex items-start justify-between gap-3">
            <h3 className="text-[0.9375rem] font-semibold leading-snug sm:text-base">
              {tournament.name}
            </h3>
            <CompetitionStatusBadge status={tournament.status} />
          </div>

          {(dates !== null || countdown !== null) && (
            <dl className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs sm:text-[0.8125rem]">
              {dates !== null && (
                <div>
                  <dt className="sr-only">Dates</dt>
                  <dd className="font-medium text-muted-foreground">
                    <time dateTime={isoOrUndefined(tournament.startDate)}>
                      {dates}
                    </time>
                  </dd>
                </div>
              )}
              {countdown !== null && (
                <div>
                  <dt className="sr-only">Starts</dt>
                  <dd className="font-semibold text-sky-900">{countdown}</dd>
                </div>
              )}
            </dl>
          )}

          {rounds !== null && <RoundProgress rounds={rounds} className="mt-4" />}
        </div>

        <div className="border-t bg-muted/30 px-4 py-3 sm:px-5">
          <h4 className="text-[0.6875rem] font-bold uppercase tracking-[0.08em] text-muted-foreground">
            {countryLabel} Grandmasters
          </h4>
          {tournament.gms.length === 0 ? (
            <p className="mt-1.5 text-sm text-muted-foreground">
              Entrant list not published yet.
            </p>
          ) : (
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {tournament.gms.map((gm) => (
                <GmChip key={gm.name} gm={gm} />
              ))}
            </ul>
          )}
        </div>
      </article>
    </li>
  );
}

function GmChip({ gm }: { gm: ChessTournamentGm }) {
  // "entered" is the default state and adds nothing; anything else (withdrawn,
  // for instance) changes what the row means, so it is shown.
  const noteworthyStatus =
    gm.entryStatus !== null && gm.entryStatus !== "entered"
      ? gm.entryStatus
      : null;

  return (
    <li className="inline-flex items-center gap-1.5 rounded-full border bg-background px-2.5 py-1 text-[0.8125rem] shadow-sm">
      {gm.title !== null && (
        <span className="rounded bg-muted px-1 py-0.5 text-[0.625rem] font-bold uppercase leading-none tracking-[0.06em] text-muted-foreground">
          {gm.title}
        </span>
      )}
      <span className="font-semibold">{gm.name}</span>
      {gm.finalRank !== null && (
        <span className="tabular-nums text-xs font-medium text-muted-foreground">
          <span className="sr-only">final rank </span>#{gm.finalRank}
        </span>
      )}
      {noteworthyStatus !== null && (
        <span className="rounded-full bg-amber-50 px-1.5 py-0.5 text-[0.625rem] font-bold uppercase leading-none tracking-[0.06em] text-amber-800 ring-1 ring-amber-700/25">
          {noteworthyStatus}
        </span>
      )}
    </li>
  );
}

function isoOrUndefined(date: Date | null): string | undefined {
  return date === null ? undefined : toIsoAttribute(date);
}
