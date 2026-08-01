/**
 * Persistence of orchestrator state and computation of metrics.
 *
 * Planned for a follow-up session:
 * - SQLite-backed store for events, sessions and their outcomes
 * - metrics such as success rate, time-to-first-response and ACU usage
 * - export of metrics for the dashboard
 */
export interface OrchestratorMetrics {
  totalEvents: number;
  totalSessions: number;
}

export function emptyMetrics(): OrchestratorMetrics {
  return { totalEvents: 0, totalSessions: 0 };
}
