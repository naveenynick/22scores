/**
 * Outbound links to the provider page an event actually came from.
 *
 * Three rules, all deliberate:
 *  - the URL is never invented. It is read from the `sources` provenance already
 *    stored on the row, so a link either points at a page the data was read
 *    from, or it is not rendered at all;
 *  - it may be narrowed to the exact item, but only from stored provenance. A
 *    provider that publishes a page per item gets an `exactTarget` step, which
 *    is handed the already-validated stored URL and that row's own
 *    `providerRef`. Nothing is derived from player names, scores or guessed ids,
 *    and a step that cannot prove the two agree declines, leaving the stored URL;
 *  - the URL is never trusted. A stored string becomes a link only when its
 *    provider is one 22scores explicitly supports AND the host belongs to that
 *    same provider, over https — and a narrowed URL must pass the same checks
 *    again. Anything else is dropped silently: a missing button is a better
 *    outcome than an arbitrary outbound link.
 *
 * Sport-agnostic on purpose: the caller supplies the wording, so cricket cards
 * can reuse all of this with `CRICKET_MATCH_LINK_LABELS` once its ingestion
 * stores match URLs and its provider is added to `TRUSTED_PROVIDERS`.
 */

/** The provenance fields a link needs. `CanonicalSource` satisfies this. */
export interface LinkableSource {
  provider: string;
  /**
   * The provider's own id for this row, exactly as ingestion wrote it. Optional
   * so any provenance-shaped object can be linked; supplying it is what lets a
   * link reach the exact item rather than its container page.
   */
  providerRef?: string | null;
  url: string | null;
}

interface TrustedProvider {
  /** Provider id exactly as ingestion writes it into `sources[].provider`. */
  id: string;
  /** Provider name shown to a reader, e.g. "Watch now on Lichess". */
  label: string;
  /** Exact hostnames this provider may link to, lowercase. */
  hosts: readonly string[];
  /**
   * Narrows a validated provider URL to the one item this row came from, using
   * only `providerRef`. Returns null to keep the stored URL. Absent for a
   * provider with no page per item.
   */
  exactTarget?: (url: URL, providerRef: string) => URL | null;
}

/** Lichess ids are short url-safe tokens; anything else is not an id we stored. */
const LICHESS_ID = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * A single board inside a broadcast round.
 *
 * Chess ingestion writes a game's ref as `${round.id}/${game.id}` and stores the
 * round's page as the URL, so both halves of the exact board URL are already on
 * the row: Lichess addresses a board as the round page plus the game id as one
 * more path segment. A round's own ref carries no slash, so a round row keeps
 * pointing at the round.
 *
 * The round id must be the URL's last segment. That is what proves the stored
 * URL really is the page of the round this game belongs to — without it, a
 * different stored URL would turn into an appended-id guess.
 */
function lichessBroadcastBoard(url: URL, providerRef: string): URL | null {
  const parts = providerRef.split("/");
  if (parts.length !== 2) return null;
  const [roundId, gameId] = parts;
  if (roundId === undefined || gameId === undefined) return null;
  if (!LICHESS_ID.test(roundId) || !LICHESS_ID.test(gameId)) return null;

  const path = url.pathname.replace(/\/+$/, "");
  if (path.split("/").at(-1) !== roundId) return null;

  const exact = new URL(url.toString());
  exact.pathname = `${path}/${gameId}`;
  return exact;
}

/**
 * The allowlist. A provider must appear here before any of its URLs can be
 * rendered, and each is bound to its own hosts, so one provider's row can never
 * produce a link somewhere else. Hosts are matched exactly, never by suffix.
 */
const TRUSTED_PROVIDERS: readonly TrustedProvider[] = [
  {
    id: "lichess",
    label: "Lichess",
    hosts: ["lichess.org", "www.lichess.org"],
    exactTarget: lichessBroadcastBoard,
  },
  {
    id: "chesscom",
    label: "Chess.com",
    hosts: ["chess.com", "www.chess.com"],
  },
];

/** Wording for one kind of card; `live` is used while the event is in progress. */
export interface ExternalLinkLabels {
  live: string;
  default: string;
}

export const CHESS_GAME_LINK_LABELS: ExternalLinkLabels = {
  live: "Watch now",
  default: "View game",
};

/**
 * Reserved for the cricket cards. Wiring cricket up needs this pair and a
 * `TRUSTED_PROVIDERS` entry for its provider — no change to the logic below.
 */
export const CRICKET_MATCH_LINK_LABELS: ExternalLinkLabels = {
  live: "Live score",
  default: "View scorecard",
};

export interface ExternalEventLink {
  /** Validated, normalized https URL. */
  href: string;
  /** Visible button text, e.g. "Watch now". */
  label: string;
  /** Whole accessible name: what it does, where it goes, that it leaves here. */
  accessibleLabel: string;
  /** Trusted provider's display name, e.g. "Lichess". */
  providerLabel: string;
  isLive: boolean;
}

const NEW_TAB_HINT = "opens in a new tab";

function trustedProviderFor(provider: string): TrustedProvider | null {
  const id = provider.trim().toLowerCase();
  return TRUSTED_PROVIDERS.find((candidate) => candidate.id === id) ?? null;
}

/** Case-insensitive, tolerating one fully-qualified trailing dot. */
function hostAllowed(provider: TrustedProvider, hostname: string): boolean {
  return provider.hosts.includes(hostname.toLowerCase().replace(/\.$/, ""));
}

function safeHref(source: LinkableSource, provider: TrustedProvider): string | null {
  const { url } = source;
  if (url === null || url.trim() === "") return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  // https only: `http:` is downgradeable, and `javascript:`/`data:` in an href
  // are an injection vector. Both parse fine, so the protocol must be checked.
  if (parsed.protocol !== "https:") return null;
  // Ingestion never stores credentials, and they hide the real host from a
  // reader ("https://lichess.org@example.com/").
  if (parsed.username !== "" || parsed.password !== "") return null;
  if (!hostAllowed(provider, parsed.hostname)) return null;
  return (exactHref(parsed, source, provider) ?? parsed).toString();
}

/**
 * The exact item's URL, or null to keep the container page. Re-validated: a
 * narrowed URL is held to the same protocol and host rules as a stored one, so
 * this step can only ever move within the provider it belongs to.
 */
function exactHref(
  url: URL,
  source: LinkableSource,
  provider: TrustedProvider,
): URL | null {
  if (provider.exactTarget === undefined) return null;
  const ref = typeof source.providerRef === "string" ? source.providerRef.trim() : "";
  if (ref === "") return null;
  const exact = provider.exactTarget(url, ref);
  if (exact === null) return null;
  if (exact.protocol !== "https:") return null;
  if (exact.username !== "" || exact.password !== "") return null;
  if (!hostAllowed(provider, exact.hostname)) return null;
  return exact;
}

/**
 * The link a single source may be rendered as, or null. Exported for direct
 * testing of the trust rules.
 */
export function safeExternalUrl(source: LinkableSource): string | null {
  const provider = trustedProviderFor(source.provider);
  return provider === null ? null : safeHref(source, provider);
}

/**
 * First source that yields a trusted link, as an already-worded action. Returns
 * null when nothing on the row can be linked, which is the common case for a
 * provider that does not publish a page per event.
 */
export function resolveExternalEventLink(options: {
  sources: readonly LinkableSource[];
  /** Drives both the wording and the visual prominence of the action. */
  isLive: boolean;
  labels: ExternalLinkLabels;
  /** What the link leads to, e.g. "Gukesh D vs Carlsen at Tata Steel". */
  context?: string | null;
}): ExternalEventLink | null {
  const { sources, isLive, labels, context = null } = options;
  for (const source of sources) {
    const provider = trustedProviderFor(source.provider);
    if (provider === null) continue;
    const href = safeHref(source, provider);
    if (href === null) continue;

    const label = isLive ? labels.live : labels.default;
    const subject = context === null || context.trim() === "" ? null : context.trim();
    return {
      href,
      label,
      providerLabel: provider.label,
      isLive,
      accessibleLabel:
        subject === null
          ? `${label} on ${provider.label} (${NEW_TAB_HINT})`
          : `${label} on ${provider.label}: ${subject} (${NEW_TAB_HINT})`,
    };
  }
  return null;
}
