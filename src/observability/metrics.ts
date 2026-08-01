import type { RunRecord, RunStatus } from "./store.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface FailureBreakdown {
  /** Devin API call failed before a session existed. */
  dispatchFailed: number;
  dispatchFailedRate: number;
  /** Session was created but ended in an error state. */
  failed: number;
  failedRate: number;
}

export interface CostSummary {
  totalAcu: number;
  runsWithCost: number;
  runsWithoutCost: number;
  /** True when at least one run has no reported ACU cost, making the total a lower bound. */
  estimated: boolean;
  note: string;
}

/**
 * Split of the runs Devin completed on its own, plus the ones it stopped on.
 *
 * `noActionNeeded` used to be counted as a failure because the old success rate
 * only looked for a pull request URL. `issueClosed` covers runs resolved by the
 * issue being closed without the run producing a pull request itself.
 */
export interface OutcomeBreakdown {
  /** Finished with a pull request. */
  remediated: number;
  /** Finished after concluding no change was required. */
  noActionNeeded: number;
  /** Finished because the issue was closed, without a pull request of its own. */
  issueClosed: number;
  /** Stopped waiting for a human decision. */
  needsHumanAttention: number;
}

export interface OrchestratorMetrics {
  generatedAt: string;
  totalRuns: number;
  statusCounts: Record<RunStatus, number>;
  /** (remediated + noActionNeeded) / totalRuns — did Devin complete normally? */
  successRate: number;
  successfulRuns: number;
  outcomes: OutcomeBreakdown;
  failureBreakdown: FailureBreakdown;
  mttrMs: number | null;
  mttrSampleSize: number;
  throughputLast24h: number;
  cost: CostSummary;
}

const STATUSES: RunStatus[] = [
  "pending",
  "dispatch_failed",
  "working",
  "blocked",
  "needs_human_attention",
  "finished",
  "failed",
];

function emptyStatusCounts(): Record<RunStatus, number> {
  return Object.fromEntries(STATUSES.map((status) => [status, 0])) as Record<RunStatus, number>;
}

function ratio(part: number, total: number): number {
  return total === 0 ? 0 : part / total;
}

function timestamp(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Finished with a pull request. Runs recorded before sessions reported an
 * outcome are classified by their pull request URL alone.
 */
export function isRemediated(run: RunRecord): boolean {
  if (run.status !== "finished") {
    return false;
  }

  return run.outcome === null ? run.prUrl !== null : run.outcome === "pr_created";
}

/** Finished after Devin concluded that no change was required. */
export function isNoActionNeeded(run: RunRecord): boolean {
  return run.status === "finished" && run.outcome === "no_action_needed";
}

/** Waiting on a human rather than progressing. */
export function needsHumanAttention(run: RunRecord): boolean {
  return run.status === "needs_human_attention";
}

/**
 * Finished because GitHub reported the issue closed, without the run producing
 * a pull request or a "nothing to fix" conclusion of its own. The issue was
 * still resolved, so this is a completion rather than a failure.
 */
export function isClosedWithIssue(run: RunRecord): boolean {
  return (
    run.status === "finished" &&
    run.issueClosedAt !== null &&
    !isRemediated(run) &&
    !isNoActionNeeded(run)
  );
}

/**
 * A run counts as successful when the issue it was opened for was dealt with —
 * with a pull request, with a deliberate "nothing to fix" conclusion, or by the
 * issue being closed.
 */
export function isSuccessful(run: RunRecord): boolean {
  return isRemediated(run) || isNoActionNeeded(run) || isClosedWithIssue(run);
}

/**
 * Metrics over the whole run history.
 *
 * Failures are reported split by stage — `dispatch_failed` (the Devin API never
 * accepted the run) versus `failed` (the session itself failed) — so a
 * persistently broken dispatch path is distinguishable from failing sessions.
 */
export function computeMetrics(runs: RunRecord[], now: Date = new Date()): OrchestratorMetrics {
  const statusCounts = emptyStatusCounts();
  let remediated = 0;
  let noActionNeeded = 0;
  let issueClosed = 0;
  let mttrTotalMs = 0;
  let mttrSampleSize = 0;
  let throughputLast24h = 0;
  let totalAcu = 0;
  let runsWithCost = 0;

  for (const run of runs) {
    statusCounts[run.status] += 1;

    if (isRemediated(run)) {
      remediated += 1;
    } else if (isNoActionNeeded(run)) {
      noActionNeeded += 1;
    } else if (isClosedWithIssue(run)) {
      issueClosed += 1;
    }

    const detectedAt = timestamp(run.detectedAt);
    const prRecordedAt = timestamp(run.prUrlRecordedAt);
    if (detectedAt !== null && prRecordedAt !== null && prRecordedAt >= detectedAt) {
      mttrTotalMs += prRecordedAt - detectedAt;
      mttrSampleSize += 1;
    }

    const finishedAt = timestamp(run.sessionFinishedAt);
    if (run.status === "finished" && finishedAt !== null && now.getTime() - finishedAt <= DAY_MS) {
      throughputLast24h += 1;
    }

    if (run.acuCost !== null) {
      totalAcu += run.acuCost;
      runsWithCost += 1;
    }
  }

  const totalRuns = runs.length;
  const runsWithoutCost = totalRuns - runsWithCost;
  const successfulRuns = remediated + noActionNeeded + issueClosed;

  return {
    generatedAt: now.toISOString(),
    totalRuns,
    statusCounts,
    successRate: ratio(successfulRuns, totalRuns),
    successfulRuns,
    outcomes: {
      remediated,
      noActionNeeded,
      issueClosed,
      needsHumanAttention: statusCounts.needs_human_attention,
    },
    failureBreakdown: {
      dispatchFailed: statusCounts.dispatch_failed,
      dispatchFailedRate: ratio(statusCounts.dispatch_failed, totalRuns),
      failed: statusCounts.failed,
      failedRate: ratio(statusCounts.failed, totalRuns),
    },
    mttrMs: mttrSampleSize === 0 ? null : mttrTotalMs / mttrSampleSize,
    mttrSampleSize,
    throughputLast24h,
    cost: {
      totalAcu,
      runsWithCost,
      runsWithoutCost,
      estimated: runsWithoutCost > 0,
      note:
        runsWithoutCost > 0
          ? `Approximate: ${runsWithoutCost} of ${totalRuns} run(s) have no ACU cost reported by the Devin API yet, so the total is a lower bound.`
          : "Exact: every run has an ACU cost reported by the Devin API.",
    },
  };
}
