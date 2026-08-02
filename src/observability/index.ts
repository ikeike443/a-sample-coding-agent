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
  UNFINISHED_STATUSES,
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
  isClosedWithIssue,
  isNoActionNeeded,
  isRemediated,
  isSuccessful,
  needsHumanAttention,
  type CostSummary,
  type FailureBreakdown,
  type OrchestratorMetrics,
  type OutcomeBreakdown,
} from "./metrics.js";

export {
  DEFAULT_BLOCKED_GRACE_MS,
  DEFAULT_POLL_INTERVAL_MS,
  SessionPoller,
  buildSessionUpdate,
  extractPrUrl,
  isPrMerged,
  mapSessionStatus,
  type PollerLogger,
  type SessionPollerOptions,
  type SessionUpdateContext,
} from "./poller.js";
