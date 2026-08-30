import { BaseSportProvider } from "@/core/providers/types";
import type { ProviderCapabilities } from "@/core/providers/types";
import type { SportKey } from "@/core/models/canonical";

/**
 * Chess.com — supplementary chess provider (stub).
 *
 * No network calls yet. IMPORTANT: Chess.com has NO global tournament/event
 * discovery feed, so `tournamentDiscovery` is deliberately false. It is only
 * ever a supplementary source for player profiles and per-player game history;
 * discovery must come from Lichess.
 */
export class ChessComChessProvider extends BaseSportProvider {
  readonly id = "chesscom";
  readonly sport: SportKey = "chess";
  readonly capabilities: ProviderCapabilities = {
    liveEvents: false,
    upcomingEvents: false,
    recentEvents: true,
    tournamentDiscovery: false, // Chess.com cannot discover events.
    participants: true,
  };
}
