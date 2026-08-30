/**
 * Optional "featured Indian GMs" list (chess).
 *
 * NOT the inclusion filter. India relevance is decided per player from the data
 * itself — FIDE title "GM" AND federation "IND", as reported by the provider
 * (see lichess-mapper.ts). A missing title or federation is UNKNOWN, never
 * "not Indian", so nothing depends on this file being complete.
 *
 * It exists only for editorial use (highlighting well-known names) and for
 * provider-native handle lookups. We deliberately do NOT build a directory of
 * every Indian player.
 *
 * `fideFederation` is the intended official federation ("IND"); provider
 * usernames are how ingestion matches this GM inside tournament/game payloads.
 */
export interface IndianGm {
  /** Canonical display name. */
  name: string;
  /** Intended FIDE federation. Always "IND" for this list. */
  fideFederation: "IND";
  /** FIDE ID if known (for future authoritative matching). */
  fideId?: string;
  /** Provider-native handles used to match this player in payloads. */
  lichessUsername?: string;
  chesscomUsername?: string;
  /** Set false to keep an entry for reference without ingesting it. */
  active: boolean;
}

export const INDIAN_GMS: IndianGm[] = [
  {
    name: "Dommaraju Gukesh",
    fideFederation: "IND",
    lichessUsername: "gukeshdommaraju",
    chesscomUsername: "gukeshdommaraju",
    active: true,
  },
  {
    name: "Rameshbabu Praggnanandhaa",
    fideFederation: "IND",
    chesscomUsername: "rpragchess",
    active: true,
  },
  {
    name: "Arjun Erigaisi",
    fideFederation: "IND",
    chesscomUsername: "ghandeevam2003",
    active: true,
  },
  {
    name: "Viswanathan Anand",
    fideFederation: "IND",
    chesscomUsername: "thevishy",
    active: true,
  },
  {
    name: "Vidit Gujrathi",
    fideFederation: "IND",
    lichessUsername: "viditchess",
    chesscomUsername: "viditchess",
    active: true,
  },
];

/** Active GMs only. */
export function getActiveIndianGms(): IndianGm[] {
  return INDIAN_GMS.filter((g) => g.active);
}

/** Provider-native usernames for a given provider, lowercased for matching. */
export function getIndianGmHandles(provider: "lichess" | "chesscom"): string[] {
  const key = provider === "lichess" ? "lichessUsername" : "chesscomUsername";
  return getActiveIndianGms()
    .map((g) => g[key])
    .filter((u): u is string => Boolean(u))
    .map((u) => u.toLowerCase());
}
