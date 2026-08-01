/**
 * Persistence of orchestrator state and computation of metrics.
 *
 * - `store.ts`: SQLite-backed `runs` table tracking every detected event, the
 *   Devin session it created (if any) and its outcome.
 * - `metrics.ts`: success rate, failure breakdown, MTTR, throughput and cost.
 * - `poller.ts`: background worker refreshing active runs from the Devin API.
 */
export {
  ACTIVE_STATUSES,
  SqliteRunStore,
  type RecordEventInput,
  type RunRecord,
  type RunStatus,
  type RunStore,
  type SessionUpdate,
  type SqliteRunStoreOptions,
  type TriggerType,
} from "./store.js";

export {
  computeMetrics,
  isSuccessful,
  type CostSummary,
  type FailureBreakdown,
  type OrchestratorMetrics,
} from "./metrics.js";

export {
  DEFAULT_POLL_INTERVAL_MS,
  SessionPoller,
  buildSessionUpdate,
  extractPrUrl,
  mapSessionStatus,
  type PollerLogger,
  type SessionPollerOptions,
} from "./poller.js";
