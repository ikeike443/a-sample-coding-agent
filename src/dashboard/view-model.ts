import type { OrchestratorMetrics } from "../observability/index.js";
import { isSuccessful, type RunRecord, type RunStatus } from "../observability/index.js";

/** Colour bucket a status is rendered with; the CSS owns the actual colours. */
export type StatusTone = "success" | "progress" | "danger" | "neutral";

export interface SummaryCard {
  id: string;
  label: string;
  value: string;
  detail: string;
  tone: StatusTone;
}

export interface RunRow {
  runId: string;
  issueLabel: string;
  status: RunStatus;
  statusLabel: string;
  tone: StatusTone;
  triggerType: string;
  detectedAt: string;
  detectedAtLabel: string;
  prUrl: string | null;
  sessionUrl: string | null;
  elapsedLabel: string;
}

export interface TrendPoint {
  date: string;
  /** `null` on days without any run, so idle days are not drawn as 0%. */
  successRate: number | null;
  totalRuns: number;
}

export interface DashboardViewModel {
  generatedAt: string;
  generatedAtLabel: string;
  hasRuns: boolean;
  emptyMessage: string;
  cards: SummaryCard[];
  recentRuns: RunRow[];
  successRateTrend: TrendPoint[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const TREND_DAYS = 7;

export const RECENT_RUNS_LIMIT = 20;

const STATUS_TONES: Record<RunStatus, StatusTone> = {
  finished: "success",
  working: "progress",
  blocked: "progress",
  needs_human_attention: "danger",
  dispatch_failed: "danger",
  failed: "danger",
  pending: "neutral",
};

const STATUS_LABELS: Record<RunStatus, string> = {
  finished: "Finished",
  working: "Working",
  blocked: "Blocked",
  needs_human_attention: "Needs human attention",
  dispatch_failed: "Dispatch failed",
  failed: "Failed",
  pending: "Pending",
};

/** Colour bucket for a run status, shared by the table and the summary cards. */
export function statusTone(status: RunStatus): StatusTone {
  return STATUS_TONES[status] ?? "neutral";
}

export function statusLabel(status: RunStatus): string {
  return STATUS_LABELS[status] ?? status;
}

export function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

/** Compact human-readable duration, e.g. `2h 5m`. `null` renders as an em dash. */
export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) {
    return "—";
  }

  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function formatTimestamp(value: string): string {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? value : new Date(parsed).toISOString().replace("T", " ").slice(0, 19);
}

const DEVIN_SESSION_BASE_URL = "https://app.devin.ai/sessions";

/** Devin session page for a run, or `null` when the dispatch never produced one. */
export function sessionUrl(sessionId: string | null): string | null {
  return sessionId === null || sessionId === "" ? null : `${DEVIN_SESSION_BASE_URL}/${sessionId}`;
}

const TERMINAL_STATUSES: RunStatus[] = ["dispatch_failed", "finished", "failed"];

/**
 * Time the run has been alive. Terminal runs without a finish timestamp — a
 * `dispatch_failed` run never gets one — are not counted up against `now`,
 * which would make a dead run look like it is still working.
 */
function elapsed(run: RunRecord, now: Date): string {
  const start = Date.parse(run.detectedAt);
  if (Number.isNaN(start)) {
    return "—";
  }

  if (run.sessionFinishedAt === null) {
    return TERMINAL_STATUSES.includes(run.status) ? "—" : formatDuration(now.getTime() - start);
  }

  const end = Date.parse(run.sessionFinishedAt);
  return formatDuration((Number.isNaN(end) ? now.getTime() : end) - start);
}

function successTone(rate: number, totalRuns: number): StatusTone {
  if (totalRuns === 0) {
    return "neutral";
  }
  if (rate >= 0.8) {
    return "success";
  }
  return rate >= 0.5 ? "progress" : "danger";
}

/** Cards shown at the top of the dashboard, in display order. */
export function buildSummaryCards(metrics: OrchestratorMetrics): SummaryCard[] {
  const { failureBreakdown: failures, outcomes, cost } = metrics;

  return [
    {
      id: "success-rate",
      label: "Success rate",
      value: formatPercent(metrics.successRate),
      detail: `${metrics.successfulRuns} of ${metrics.totalRuns} run(s) completed by Devin (${outcomes.remediated} remediated + ${outcomes.noActionNeeded} no action needed)`,
      tone: successTone(metrics.successRate, metrics.totalRuns),
    },
    {
      id: "remediated",
      label: "Remediated",
      value: `${outcomes.remediated}`,
      detail: "Runs finished with a pull request",
      tone: "success",
    },
    {
      id: "no-action-needed",
      label: "No action needed",
      value: `${outcomes.noActionNeeded}`,
      detail: "Runs finished with nothing to fix — a valid completion, not a failure",
      tone: "success",
    },
    {
      id: "needs-human-attention",
      label: "Needs human attention",
      value: `${outcomes.needsHumanAttention}`,
      detail: "Runs stalled waiting for a human decision",
      tone: outcomes.needsHumanAttention > 0 ? "danger" : "success",
    },
    {
      id: "dispatch-failed",
      label: "Dispatch failures",
      value: `${failures.dispatchFailed}`,
      detail: `${formatPercent(failures.dispatchFailedRate)} of all runs — the Devin API never accepted the run`,
      tone: failures.dispatchFailed > 0 ? "danger" : "success",
    },
    {
      id: "session-failed",
      label: "Session failures",
      value: `${failures.failed}`,
      detail: `${formatPercent(failures.failedRate)} of all runs — the session started but ended in error`,
      tone: failures.failed > 0 ? "danger" : "success",
    },
    {
      id: "mttr",
      label: "MTTR",
      value: formatDuration(metrics.mttrMs),
      detail:
        metrics.mttrSampleSize === 0
          ? "No run has produced a pull request yet"
          : `Average detection → pull request over ${metrics.mttrSampleSize} run(s)`,
      tone: "neutral",
    },
    {
      id: "throughput",
      label: "Throughput (24h)",
      value: `${metrics.throughputLast24h}`,
      detail: "Runs finished in the last 24 hours",
      tone: "neutral",
    },
    {
      id: "cost",
      label: "Total ACU cost",
      value: cost.totalAcu.toFixed(2),
      detail: cost.note,
      tone: "neutral",
    },
  ];
}

/** Most recent runs first, capped at `limit`. */
export function buildRecentRuns(
  runs: RunRecord[],
  now: Date = new Date(),
  limit: number = RECENT_RUNS_LIMIT,
): RunRow[] {
  // Newest first, breaking `detectedAt` ties by input position so that runs
  // recorded in the same millisecond keep a deterministic, later-first order
  // (the store returns them oldest-first).
  return runs
    .map((run, index) => ({ run, index }))
    .sort((a, b) => Date.parse(b.run.detectedAt) - Date.parse(a.run.detectedAt) || b.index - a.index)
    .slice(0, limit)
    .map(({ run }) => ({
      runId: run.runId,
      issueLabel: run.issueRef === null ? "—" : `#${run.issueRef}`,
      status: run.status,
      statusLabel: statusLabel(run.status),
      tone: statusTone(run.status),
      triggerType: run.triggerType,
      detectedAt: run.detectedAt,
      detectedAtLabel: formatTimestamp(run.detectedAt),
      prUrl: run.prUrl,
      sessionUrl: sessionUrl(run.sessionId),
      elapsedLabel: elapsed(run, now),
    }));
}

/** Daily success rate over the last `TREND_DAYS` days, oldest first. */
export function buildSuccessRateTrend(runs: RunRecord[], now: Date = new Date()): TrendPoint[] {
  const points: TrendPoint[] = [];

  for (let offset = TREND_DAYS - 1; offset >= 0; offset -= 1) {
    const dayStart = new Date(now.getTime() - offset * DAY_MS);
    const date = dayStart.toISOString().slice(0, 10);
    const dayRuns = runs.filter((run) => run.detectedAt.slice(0, 10) === date);
    const successes = dayRuns.filter(isSuccessful).length;

    points.push({
      date,
      totalRuns: dayRuns.length,
      successRate: dayRuns.length === 0 ? null : successes / dayRuns.length,
    });
  }

  return points;
}

/**
 * Everything the dashboard page renders, derived server-side so the browser
 * script stays a thin DOM writer and this logic remains unit-testable.
 */
export function buildDashboardViewModel(
  metrics: OrchestratorMetrics,
  runs: RunRecord[],
  now: Date = new Date(),
): DashboardViewModel {
  return {
    generatedAt: metrics.generatedAt,
    generatedAtLabel: formatTimestamp(metrics.generatedAt),
    hasRuns: metrics.totalRuns > 0,
    emptyMessage: "まだ実行がありません / No runs recorded yet.",
    cards: buildSummaryCards(metrics),
    recentRuns: buildRecentRuns(runs, now),
    successRateTrend: buildSuccessRateTrend(runs, now),
  };
}
