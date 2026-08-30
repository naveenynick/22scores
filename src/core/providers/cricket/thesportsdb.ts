import { BaseSportProvider } from "@/core/providers/types";
import type { ProviderCapabilities } from "@/core/providers/types";
import type { SportKey } from "@/core/models/canonical";

/**
 * TheSportsDB — initial cricket provider (stub).
 *
 * No network calls yet. Capabilities reflect the FREE tier findings: schedules
 * and results are available (though free-tier limited), but live scores require
 * the premium v2 feed, so `liveEvents` is declared false until we upgrade.
 * A future cricket provider can be registered alongside this one for fallback.
 */
export class TheSportsDbCricketProvider extends BaseSportProvider {
  readonly id = "thesportsdb";
  readonly sport: SportKey = "cricket";
  readonly capabilities: ProviderCapabilities = {
    liveEvents: false,
    upcomingEvents: true,
    recentEvents: true,
    tournamentDiscovery: true,
    participants: true,
  };

  // getCompetitions / getEvents / getParticipants inherited (return []).
  // Real implementations will be added when ingestion is built.
}
