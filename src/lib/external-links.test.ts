import { describe, expect, it } from "vitest";

import {
  CHESS_GAME_LINK_LABELS,
  CRICKET_MATCH_LINK_LABELS,
  resolveExternalEventLink,
  safeExternalUrl,
  type LinkableSource,
} from "@/lib/external-links";

const LICHESS_ROUND = "https://lichess.org/broadcast/linares-2026/round-4/abc123";

function source(url: string | null, provider = "lichess"): LinkableSource {
  return { provider, url };
}

/** Provenance as chess ingestion writes it for one board: `roundId/gameId`. */
function gameSource(
  gameId: string,
  url: string | null = LICHESS_ROUND,
  roundId = "abc123",
): LinkableSource {
  return { provider: "lichess", providerRef: `${roundId}/${gameId}`, url };
}

describe("safeExternalUrl", () => {
  it("accepts an https URL on a trusted provider's own host", () => {
    expect(safeExternalUrl(source(LICHESS_ROUND))).toBe(LICHESS_ROUND);
    expect(safeExternalUrl(source("https://www.chess.com/events/x", "chesscom"))).toBe(
      "https://www.chess.com/events/x",
    );
  });

  it("tolerates provider id casing and padding as stored", () => {
    expect(safeExternalUrl(source(LICHESS_ROUND, " Lichess "))).toBe(LICHESS_ROUND);
  });

  it("rejects a missing or blank URL", () => {
    expect(safeExternalUrl(source(null))).toBeNull();
    expect(safeExternalUrl(source("   "))).toBeNull();
  });

  it("rejects anything that is not https", () => {
    expect(safeExternalUrl(source("http://lichess.org/broadcast/x"))).toBeNull();
    // Parses as a URL with protocol "javascript:", so the scheme check is what
    // stops it reaching an href.
    expect(safeExternalUrl(source("javascript:alert(1)"))).toBeNull();
    expect(safeExternalUrl(source("data:text/html,<script>x</script>"))).toBeNull();
  });

  it("rejects an unparseable URL", () => {
    expect(safeExternalUrl(source("lichess.org/broadcast/x"))).toBeNull();
    expect(safeExternalUrl(source("https://"))).toBeNull();
  });

  it("rejects look-alike hosts", () => {
    for (const host of [
      "evil-lichess.org",
      "lichess.org.attacker.example",
      "notlichess.org",
      "lichess.org.co",
      "broadcast.lichess.org.evil.test",
    ]) {
      expect(safeExternalUrl(source(`https://${host}/broadcast/x`))).toBeNull();
    }
  });

  it("rejects credentials that disguise the real host", () => {
    // Host here is example.com, not lichess.org.
    expect(safeExternalUrl(source("https://lichess.org@example.com/x"))).toBeNull();
    expect(safeExternalUrl(source("https://user:pw@lichess.org/x"))).toBeNull();
  });

  it("rejects a provider that is not on the allowlist", () => {
    expect(safeExternalUrl(source(LICHESS_ROUND, "scraper"))).toBeNull();
    expect(safeExternalUrl(source(LICHESS_ROUND, ""))).toBeNull();
  });

  it("binds each provider to its own hosts", () => {
    // A lichess row may not link to chess.com, and vice versa.
    expect(safeExternalUrl(source("https://www.chess.com/events/x"))).toBeNull();
    expect(safeExternalUrl(source(LICHESS_ROUND, "chesscom"))).toBeNull();
  });

  it("normalizes the host and keeps the path", () => {
    expect(safeExternalUrl(source("https://LICHESS.ORG/broadcast/Round-4"))).toBe(
      "https://lichess.org/broadcast/Round-4",
    );
  });
});

/**
 * The whole point of storing `providerRef`: a round page shows every board, so a
 * link that stops there is the wrong game as often as not. The game id already on
 * the row is what makes the link exact — nothing is derived from player names,
 * and an id that is not on the row is never guessed at.
 */
describe("exact Lichess board URLs", () => {
  it("sends two games from the same round to two different URLs", () => {
    const first = safeExternalUrl(gameSource("gAAAAAAA"));
    const second = safeExternalUrl(gameSource("gBBBBBBB"));

    expect(first).toBe(`${LICHESS_ROUND}/gAAAAAAA`);
    expect(second).toBe(`${LICHESS_ROUND}/gBBBBBBB`);
    expect(first).not.toBe(second);
    // And neither is the round page they share.
    expect(first).not.toBe(LICHESS_ROUND);
    expect(second).not.toBe(LICHESS_ROUND);
  });

  it("keeps a round row on the round page", () => {
    // A round's own ref has no game half, so there is nothing to narrow to.
    expect(
      safeExternalUrl({
        provider: "lichess",
        providerRef: "abc123",
        url: LICHESS_ROUND,
      }),
    ).toBe(LICHESS_ROUND);
  });

  it("appends nothing when the stored URL is not that round's page", () => {
    // Without this the id would be appended to whatever happened to be stored,
    // which is a guess dressed up as provenance.
    expect(safeExternalUrl(gameSource("gAAAAAAA", "https://lichess.org/broadcast"))).toBe(
      "https://lichess.org/broadcast",
    );
    const otherRound = "https://lichess.org/broadcast/linares-2026/round-5/zzz999";
    expect(safeExternalUrl(gameSource("gAAAAAAA", otherRound))).toBe(otherRound);
  });

  it("tolerates a trailing slash on the stored round page", () => {
    expect(safeExternalUrl(gameSource("gAAAAAAA", `${LICHESS_ROUND}/`))).toBe(
      `${LICHESS_ROUND}/gAAAAAAA`,
    );
  });

  it("refuses a ref that is not a pair of plain ids", () => {
    for (const ref of [
      "abc123/",
      "/gAAAAAAA",
      "abc123/g1/extra",
      "abc123/../../admin",
      "abc123/g 1",
      "abc123/g?x=1",
      "abc123/g#frag",
      "abc123/%2e%2e",
      "",
      "   ",
    ]) {
      expect(safeExternalUrl({ provider: "lichess", providerRef: ref, url: LICHESS_ROUND })).toBe(
        LICHESS_ROUND,
      );
    }
  });

  it("still enforces the trust rules on the narrowed URL", () => {
    // The exact step runs only after the stored URL passes, and cannot move off
    // the provider's own hosts.
    expect(
      safeExternalUrl(gameSource("gAAAAAAA", "https://evil.example/broadcast/x/y/abc123")),
    ).toBeNull();
    expect(
      safeExternalUrl(gameSource("gAAAAAAA", "http://lichess.org/broadcast/x/y/abc123")),
    ).toBeNull();
    expect(safeExternalUrl(gameSource("gAAAAAAA", null))).toBeNull();
    // Host casing is normalized before the round id is matched.
    expect(
      safeExternalUrl(gameSource("gAAAAAAA", "https://WWW.LICHESS.ORG/broadcast/l/r/abc123")),
    ).toBe("https://www.lichess.org/broadcast/l/r/abc123/gAAAAAAA");
  });

  it("leaves a provider with no per-item page alone", () => {
    // chess.com has no exact-target rule, so its stored URL is used as is.
    expect(
      safeExternalUrl({
        provider: "chesscom",
        providerRef: "evt/gAAAAAAA",
        url: "https://www.chess.com/events/x",
      }),
    ).toBe("https://www.chess.com/events/x");
  });

  it("links each board of a round from its own card wording", () => {
    const watch = resolveExternalEventLink({
      sources: [gameSource("gAAAAAAA")],
      isLive: true,
      labels: CHESS_GAME_LINK_LABELS,
      context: "Gukesh D vs Carlsen",
    });
    const view = resolveExternalEventLink({
      sources: [gameSource("gBBBBBBB")],
      isLive: false,
      labels: CHESS_GAME_LINK_LABELS,
    });

    expect(watch).toMatchObject({
      href: `${LICHESS_ROUND}/gAAAAAAA`,
      label: "Watch now",
      accessibleLabel:
        "Watch now on Lichess: Gukesh D vs Carlsen (opens in a new tab)",
    });
    expect(view).toMatchObject({
      href: `${LICHESS_ROUND}/gBBBBBBB`,
      label: "View game",
    });
    expect(watch?.href).not.toBe(view?.href);
  });
});

describe("resolveExternalEventLink", () => {
  const labels = CHESS_GAME_LINK_LABELS;

  it("words a live game as the live label and a finished one as the default", () => {
    const live = resolveExternalEventLink({
      sources: [source(LICHESS_ROUND)],
      isLive: true,
      labels,
    });
    expect(live).toMatchObject({
      href: LICHESS_ROUND,
      label: "Watch now",
      providerLabel: "Lichess",
      isLive: true,
      accessibleLabel: "Watch now on Lichess (opens in a new tab)",
    });

    expect(
      resolveExternalEventLink({
        sources: [source(LICHESS_ROUND)],
        isLive: false,
        labels,
      })?.label,
    ).toBe("View game");
  });

  it("names the subject in the accessible label when one is given", () => {
    const link = resolveExternalEventLink({
      sources: [source(LICHESS_ROUND)],
      isLive: false,
      labels,
      context: "  Gukesh D vs Carlsen at Tata Steel  ",
    });
    expect(link?.accessibleLabel).toBe(
      "View game on Lichess: Gukesh D vs Carlsen at Tata Steel (opens in a new tab)",
    );
  });

  it("skips untrusted or unusable sources and uses the first valid one", () => {
    const link = resolveExternalEventLink({
      sources: [
        source(null),
        source("https://evil.example/lichess", "lichess"),
        source(LICHESS_ROUND, "scraper"),
        source(LICHESS_ROUND),
        source("https://www.chess.com/events/y", "chesscom"),
      ],
      isLive: true,
      labels,
    });
    expect(link?.href).toBe(LICHESS_ROUND);
  });

  it("returns null when nothing on the row can be linked", () => {
    expect(
      resolveExternalEventLink({ sources: [], isLive: true, labels }),
    ).toBeNull();
    expect(
      resolveExternalEventLink({
        sources: [source(null), source("http://lichess.org/x")],
        isLive: false,
        labels,
      }),
    ).toBeNull();
  });

  it("carries another sport's wording unchanged", () => {
    const link = resolveExternalEventLink({
      sources: [source(LICHESS_ROUND)],
      isLive: true,
      labels: CRICKET_MATCH_LINK_LABELS,
    });
    expect(link?.label).toBe("Live score");
  });
});
