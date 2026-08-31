import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * One source of truth, checked structurally.
 *
 * `/india/chess` is a server component, so it cannot be rendered by a unit test
 * the way the API route can (`route.test.ts` covers that end to end). What can be
 * proved without rendering is the property that matters: neither surface decides
 * freshness for itself, and only one module in the repository defines the window.
 * A second copy of the rule is exactly the failure this guards against.
 */

const SRC = fileURLToPath(new URL("../../", import.meta.url));

function read(relativeToSrc: string): string {
  return readFileSync(`${SRC}${relativeToSrc}`, "utf8");
}

/** Every .ts/.tsx file under src/, recursively. */
function sourceFiles(dir = SRC, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = `${dir}${entry.name}`;
    if (entry.isDirectory()) sourceFiles(`${full}/`, found);
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".test.ts")) {
      found.push(full);
    }
  }
  return found;
}

const PAGE = read("app/india/chess/page.tsx");
const ROUTE = read("app/api/india/chess/route.ts");

describe("the freshness window is defined once", () => {
  it("is declared in exactly one module", () => {
    const declaring = sourceFiles()
      .filter((file) => /LIVE_FRESHNESS_WINDOW_MS\s*=/.test(readFileSync(file, "utf8")))
      .map((file) => file.slice(SRC.length).replace(/\\/g, "/"));

    expect(declaring).toEqual(["core/queries/freshness.ts"]);
  });
});

describe("the page and the API share the rule", () => {
  it("both read through the same query function", () => {
    expect(PAGE).toContain("getIndiaChessOverview");
    expect(ROUTE).toContain("getIndiaChessOverview");
  });

  it("both surface the unconfirmed feed instead of dropping it", () => {
    expect(PAGE).toContain("unconfirmedGames");
    expect(ROUTE).toContain("unconfirmedGames");
  });

  for (const [name, source] of [
    ["/india/chess", PAGE],
    ["/api/india/chess", ROUTE],
  ] as const) {
    it(`${name} does not decide freshness itself`, () => {
      // A window of its own, a hand-rolled timestamp comparison, or a direct
      // call into the rule's internals would all let the two surfaces disagree.
      expect(source).not.toContain("LIVE_FRESHNESS_WINDOW_MS");
      expect(source).not.toContain("classifyLiveClaim");
      expect(source).not.toContain("newestFetchedAt");
      expect(source).not.toContain("Date.parse");
      expect(source).not.toMatch(/fetchedAt\s*[<>]/);
      expect(source).not.toMatch(/status\s*===\s*["']live["']/);
    });
  }
});
