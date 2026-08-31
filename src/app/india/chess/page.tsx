import type { Metadata } from "next";

import { DataFreshness } from "@/components/chess/data-freshness";
import { GameCard } from "@/components/chess/game-card";
import { CHESS_SHELL as SHELL } from "@/components/chess/layout";
import { RetryButton } from "@/components/chess/retry-button";
import { Section } from "@/components/chess/section";
import { TournamentCard } from "@/components/chess/tournament-card";
import {
  getIndiaChessOverview,
  latestFetchedAt,
  type ChessCountryOverview,
} from "@/core/queries/chess";
import { getDb } from "@/lib/db";
import { cn } from "@/lib/utils";

/**
 * /india/chess — what Indian Grandmasters are playing now and next.
 *
 * Server rendered on every request: the answer is "right now", so there is
 * nothing worth caching, and rendering on the server keeps the page indexable
 * with no client-side data fetching. It reads the same application layer as
 * GET /api/india/chess — Supabase only, no provider is ever contacted here — so
 * a provider outage cannot break or empty this page.
 *
 * Layout follows attention rather than the data model: what is happening now
 * first, then the tournaments behind it, with results alongside on a wide screen.
 *
 * Nothing on screen is invented: a missing date, entrant, round or result is
 * rendered as absent, and no provider name or link is shown to the reader.
 */

/** Never prerender or cache. */
export const dynamic = "force-dynamic";

const PAGE_PATH = "/india/chess";
const PAGE_TITLE = "India chess: live games and tournaments";
const PAGE_DESCRIPTION =
  "Live and recent games from Indian Grandmasters, with the tournaments they are playing now and the ones coming up next. Times in IST.";
/** Adjective used for the country in headings, e.g. "Indian Grandmasters". */
const COUNTRY_LABEL = "Indian";

const site = resolveSiteUrl();

export const metadata: Metadata = {
  title: PAGE_TITLE,
  description: PAGE_DESCRIPTION,
  robots: { index: true, follow: true },
  ...(site === null
    ? {}
    : { metadataBase: site, alternates: { canonical: PAGE_PATH } }),
  openGraph: {
    title: `${PAGE_TITLE} | 22scores`,
    description: PAGE_DESCRIPTION,
    siteName: "22scores",
    type: "website",
    ...(site === null ? {} : { url: new URL(PAGE_PATH, site).toString() }),
  },
};

/**
 * An absolute canonical URL needs a configured origin. Without one the canonical
 * is omitted rather than pointing at an invented domain or at localhost.
 */
function resolveSiteUrl(): URL | null {
  const raw = process.env.NEXT_PUBLIC_SITE_URL;
  if (raw === undefined || raw.trim() === "") return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

type LoadResult =
  | { ok: true; overview: ChessCountryOverview }
  | { ok: false };

async function loadOverview(): Promise<LoadResult> {
  try {
    return { ok: true, overview: await getIndiaChessOverview(getDb()) };
  } catch (error) {
    // Class of failure only: a driver error can carry the connection target.
    console.error(
      "[/india/chess] chess overview read failed:",
      error instanceof Error ? error.name : "UnknownError",
    );
    return { ok: false };
  }
}

export default async function IndiaChessPage() {
  const generatedAt = new Date();
  const result = await loadOverview();

  return (
    <main className="min-h-screen pb-16">
      <div className="border-b bg-card">
        <div className={cn(SHELL, "py-7 sm:py-10")}>
          <div className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="grid size-7 place-items-center rounded-md bg-foreground text-[0.625rem] font-bold tracking-[0.06em] text-background"
            >
              IN
            </span>
            <p className="text-[0.6875rem] font-bold uppercase tracking-[0.14em] text-muted-foreground">
              India · Chess
            </p>
          </div>
          <h1 className="mt-3 text-2xl font-bold leading-tight tracking-tight sm:text-4xl">
            Indian Grandmasters, playing around the world
          </h1>
          <p className="mt-2.5 max-w-2xl text-sm leading-relaxed text-muted-foreground sm:text-base">
            Games at the board right now, the latest results, and the tournaments
            Indian GMs are in this week and next — wherever in the world they are
            playing. All times in IST.
          </p>
          {result.ok && (
            <DataFreshness
              className="mt-5"
              fetchedAt={latestFetchedAt(result.overview)}
              generatedAt={generatedAt}
            />
          )}
        </div>
      </div>

      {result.ok ? (
        <Board overview={result.overview} generatedAt={generatedAt} />
      ) : (
        <div className={cn(SHELL, "py-8")}>
          <UnavailableState />
        </div>
      )}
    </main>
  );
}

/** The four sections, ordered by how urgent they are to a reader. */
function Board({
  overview,
  generatedAt,
}: {
  overview: ChessCountryOverview;
  generatedAt: Date;
}) {
  const { ongoingTournaments, upcomingTournaments, liveGames, recentGames } =
    overview;
  const links = [
    { id: "live-games", label: "Live", count: liveGames.length, live: true },
    {
      id: "ongoing-tournaments",
      label: "Ongoing",
      count: ongoingTournaments.length,
      live: false,
    },
    {
      id: "upcoming-tournaments",
      label: "Upcoming",
      count: upcomingTournaments.length,
      live: false,
    },
    {
      id: "recent-games",
      label: "Results",
      count: recentGames.length,
      live: false,
    },
  ];
  const total = links.reduce((sum, link) => sum + link.count, 0);

  if (total === 0) {
    return (
      <div className={cn(SHELL, "py-8")}>
        <NothingRecordedState />
      </div>
    );
  }

  return (
    <>
      <div className="sticky top-0 z-10 border-b bg-background/90 backdrop-blur">
        <div className={SHELL}>
          <nav
            aria-label="Sections on this page"
            className="-mx-1 flex gap-2 overflow-x-auto px-1 py-3"
          >
            {links.map((link) => (
              <SectionLink key={link.id} {...link} />
            ))}
          </nav>
        </div>
      </div>

      <div className={cn(SHELL, "py-6 sm:py-8")}>
        <Section
          id="live-games"
          tone="live"
          title="Live games"
          count={liveGames.length}
          emptyTitle="No game in progress"
          emptyMessage={`No ${COUNTRY_LABEL} Grandmaster is at the board right now. Games appear here while they are being played.`}
        >
          {/* A lone live game fills the row; two or more pair up on a tablet. */}
          <ul className={cn("grid gap-3", liveGames.length > 1 && "md:grid-cols-2")}>
            {liveGames.map((game) => (
              <GameCard
                key={game.id}
                game={game}
                countryIso2={overview.countryIso2}
              />
            ))}
          </ul>
        </Section>

        <div className="mt-8 grid gap-8 lg:mt-10 lg:grid-cols-3">
          <div className="space-y-8 lg:col-span-2">
            <Section
              id="ongoing-tournaments"
              title="Ongoing tournaments"
              count={ongoingTournaments.length}
              meta="Most recently started first"
              emptyTitle="No tournament under way"
              emptyMessage={`No ongoing tournament with ${COUNTRY_LABEL} Grandmasters is on record right now.`}
            >
              <ul className="grid gap-3">
                {ongoingTournaments.map((tournament) => (
                  <TournamentCard
                    key={tournament.id}
                    tournament={tournament}
                    countryLabel={COUNTRY_LABEL}
                    now={generatedAt}
                  />
                ))}
              </ul>
            </Section>

            <Section
              id="upcoming-tournaments"
              title="Upcoming tournaments"
              count={upcomingTournaments.length}
              meta="Soonest first"
              emptyTitle="Nothing scheduled yet"
              emptyMessage={`No upcoming tournament with ${COUNTRY_LABEL} Grandmasters is on record yet.`}
            >
              <ul className="grid gap-3">
                {upcomingTournaments.map((tournament) => (
                  <TournamentCard
                    key={tournament.id}
                    tournament={tournament}
                    countryLabel={COUNTRY_LABEL}
                    now={generatedAt}
                  />
                ))}
              </ul>
            </Section>
          </div>

          <div className="space-y-8">
            <Section
              id="recent-games"
              title="Recent results"
              count={recentGames.length}
              meta="Newest first"
              emptyTitle="No results yet"
              emptyMessage={`No finished ${COUNTRY_LABEL} Grandmaster game is on record yet.`}
            >
              <ul className="grid gap-3">
                {recentGames.map((game) => (
                  <GameCard
                    key={game.id}
                    game={game}
                    countryIso2={overview.countryIso2}
                  />
                ))}
              </ul>
            </Section>
          </div>
        </div>
      </div>
    </>
  );
}

/** Jump link with a live count. Horizontally scrollable on a phone. */
function SectionLink({
  id,
  label,
  count,
  live,
}: {
  id: string;
  label: string;
  count: number;
  live: boolean;
}) {
  const isLive = live && count > 0;
  return (
    <a
      href={`#${id}`}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        isLive
          ? "border-rose-200 bg-rose-50 text-rose-800"
          : "bg-card hover:bg-accent",
      )}
    >
      {isLive && (
        <span
          aria-hidden="true"
          className="size-1.5 rounded-full bg-rose-600"
        />
      )}
      {label}
      <span
        className={cn(
          "tabular-nums",
          isLive ? "text-rose-700/80" : "text-muted-foreground",
        )}
      >
        {count}
      </span>
    </a>
  );
}

/** The read failed. Says what happened without naming a provider or a driver. */
function UnavailableState() {
  return (
    <div
      role="alert"
      className="rounded-xl border border-dashed bg-muted/30 px-6 py-10 text-center"
    >
      <span
        aria-hidden="true"
        className="mx-auto grid size-10 place-items-center rounded-full border bg-background text-lg text-muted-foreground"
      >
        &#9888;
      </span>
      <p className="mt-3 font-semibold">
        Chess data is temporarily unavailable
      </p>
      <p className="mx-auto mt-1 max-w-prose text-sm text-muted-foreground">
        The latest games and tournaments could not be loaded just now. Nothing
        has been lost — try again in a moment.
      </p>
      <div className="mt-5 flex justify-center">
        <RetryButton />
      </div>
    </div>
  );
}

/** The read succeeded and every section is empty — a real state, not an error. */
function NothingRecordedState() {
  return (
    <div className="rounded-xl border border-dashed bg-muted/30 px-6 py-12 text-center">
      <span
        aria-hidden="true"
        className="mx-auto grid size-10 place-items-center rounded-full border bg-background text-lg text-muted-foreground"
      >
        &#9822;
      </span>
      <p className="mt-3 font-semibold">Nothing on record right now</p>
      <p className="mx-auto mt-1 max-w-prose text-sm text-muted-foreground">
        No games or tournaments involving {COUNTRY_LABEL} Grandmasters are
        recorded at the moment. This page shows confirmed data only, so it stays
        empty until the next update.
      </p>
      <div className="mt-5 flex justify-center">
        <RetryButton label="Check again" />
      </div>
    </div>
  );
}
