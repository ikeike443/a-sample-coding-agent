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

export interface OrchestratorMetrics {
  generatedAt: string;
  totalRuns: number;
  statusCounts: Record<RunStatus, number>;
  successRate: number;
  successfulRuns: number;
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

/** A run counts as successful when it finished *and* produced a pull request. */
export function isSuccessful(run: RunRecord): boolean {
  return run.status === "finished" && run.prUrl !== null;
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
  let successfulRuns = 0;
  let mttrTotalMs = 0;
  let mttrSampleSize = 0;
  let throughputLast24h = 0;
  let totalAcu = 0;
  let runsWithCost = 0;

  for (const run of runs) {
    statusCounts[run.status] += 1;

    if (isSuccessful(run)) {
      successfulRuns += 1;
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

  return {
    generatedAt: now.toISOString(),
    totalRuns,
    statusCounts,
    successRate: ratio(successfulRuns, totalRuns),
    successfulRuns,
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
