import { BaseSportProvider } from "@/core/providers/types";
import type { ProviderCapabilities } from "@/core/providers/types";
import type { SportKey } from "@/core/models/canonical";

/**
 * Lichess — primary chess tournament-discovery provider (stub).
 *
 * No network calls yet. Declared as the source of truth for chess tournament
 * discovery (broadcasts + arena/swiss listings), which Chess.com cannot
 * provide. Real fetching is added when ingestion is built.
 */
export class LichessChessProvider extends BaseSportProvider {
  readonly id = "lichess";
  readonly sport: SportKey = "chess";
  readonly capabilities: ProviderCapabilities = {
    liveEvents: true,
    upcomingEvents: true,
    recentEvents: true,
    tournamentDiscovery: true,
    participants: true,
  };
}
