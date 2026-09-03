import type { SportKey } from "@/core/models/canonical";
import type { SportProvider } from "@/core/providers/types";
import { CricketDataProvider } from "@/core/providers/cricket/cricketdata";
import { TheSportsDbCricketProvider } from "@/core/providers/cricket/thesportsdb";
import { LichessChessProvider } from "@/core/providers/chess/lichess";
import { ChessComChessProvider } from "@/core/providers/chess/chesscom";

/**
 * Provider registry.
 *
 * Maps each sport to an ORDERED list of providers. Order encodes precedence:
 * the first entry is the primary source, later entries add fallback/extra
 * coverage. The aggregator reads from here; the app never references concrete
 * providers directly, satisfying "never depend on one provider".
 *
 * Chess: Lichess (discovery) → Chess.com (supplementary player/game data).
 * Cricket: CricketData (live/fixtures/series) → TheSportsDB (fallback).
 *
 * CricketData needs a key. Without one its `health()` fails without opening a
 * connection and the aggregator skips it, leaving TheSportsDB to answer — which is
 * exactly what the ordering is for.
 */
const registry: Record<SportKey, SportProvider[]> = {
  cricket: [new CricketDataProvider(), new TheSportsDbCricketProvider()],
  chess: [new LichessChessProvider(), new ChessComChessProvider()],
};

/** All providers for a sport, in precedence order. */
export function getProviders(sport: SportKey): SportProvider[] {
  return registry[sport];
}

/** Every registered provider across all sports. */
export function getAllProviders(): SportProvider[] {
  return Object.values(registry).flat();
}

/** Providers for a sport that support a given capability. */
export function getProvidersWithCapability(
  sport: SportKey,
  capability: keyof SportProvider["capabilities"],
): SportProvider[] {
  return getProviders(sport).filter((p) => p.capabilities[capability]);
}
