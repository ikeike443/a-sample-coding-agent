import { describe, expect, it } from "vitest";

import {
  RECENT_RUNS_LIMIT,
  buildDashboardViewModel,
  buildRecentRuns,
  buildSuccessRateTrend,
  buildSummaryCards,
  formatDuration,
  statusTone,
} from "../src/dashboard/view-model.js";
import { computeMetrics, type RunRecord, type RunStatus } from "../src/observability/index.js";

const NOW = new Date("2026-08-01T12:00:00.000Z");

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: "run-1",
    issueRef: 1,
    triggerType: "webhook",
    sessionId: "devin-1",
    tags: [],
    detectedAt: "2026-08-01T10:00:00.000Z",
    sessionStartedAt: "2026-08-01T10:00:05.000Z",
    sessionFinishedAt: null,
    status: "working",
    prUrl: null,
    prUrlRecordedAt: null,
    prMergedAt: null,
    acuCost: null,
    errorMessage: null,
    ...overrides,
  };
}

describe("statusTone", () => {
  it("maps every status to its colour bucket", () => {
    const expected: Record<RunStatus, string> = {
      finished: "success",
      working: "progress",
      blocked: "progress",
      dispatch_failed: "danger",
      failed: "danger",
      pending: "neutral",
    };

    for (const [status, tone] of Object.entries(expected)) {
      expect(statusTone(status as RunStatus)).toBe(tone);
    }
  });
});

describe("formatDuration", () => {
  it("renders compact durations and an em dash for missing values", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(-1)).toBe("—");
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(125_000)).toBe("2m 5s");
    expect(formatDuration(7_500_000)).toBe("2h 5m");
    expect(formatDuration(180_000_000)).toBe("2d 2h");
  });
});

describe("buildSummaryCards", () => {
  it("reports dispatch failures and session failures separately", () => {
    const runs = [
      run({ runId: "a", status: "dispatch_failed", sessionId: null, errorMessage: "Devin API down" }),
      run({ runId: "b", status: "failed", sessionFinishedAt: "2026-08-01T11:00:00.000Z" }),
      run({
        runId: "c",
        status: "finished",
        prUrl: "https://github.com/o/r/pull/1",
        prUrlRecordedAt: "2026-08-01T11:00:00.000Z",
        sessionFinishedAt: "2026-08-01T11:00:00.000Z",
        acuCost: 3,
      }),
      run({ runId: "d", status: "pending", sessionId: null }),
    ];

    const cards = buildSummaryCards(computeMetrics(runs, NOW));
    const byId = Object.fromEntries(cards.map((card) => [card.id, card]));

    expect(cards.map((card) => card.id)).toEqual([
      "success-rate",
      "dispatch-failed",
      "session-failed",
      "mttr",
      "throughput",
      "cost",
    ]);
    expect(byId["success-rate"]).toMatchObject({ value: "25.0%", tone: "danger" });
    expect(byId["dispatch-failed"]).toMatchObject({ value: "1", tone: "danger" });
    expect(byId["session-failed"]).toMatchObject({ value: "1", tone: "danger" });
    expect(byId["mttr"]?.value).toBe("1h 0m");
    expect(byId["throughput"]?.value).toBe("1");
    expect(byId["cost"]?.value).toBe("3.00");
    expect(byId["cost"]?.detail).toMatch(/Approximate/);
  });

  it("marks failure cards green when there are none", () => {
    const cards = buildSummaryCards(
      computeMetrics(
        [
          run({
            status: "finished",
            prUrl: "https://github.com/o/r/pull/1",
            prUrlRecordedAt: "2026-08-01T10:30:00.000Z",
            sessionFinishedAt: "2026-08-01T10:30:00.000Z",
            acuCost: 1,
          }),
        ],
        NOW,
      ),
    );
    const byId = Object.fromEntries(cards.map((card) => [card.id, card]));

    expect(byId["success-rate"]?.tone).toBe("success");
    expect(byId["dispatch-failed"]?.tone).toBe("success");
    expect(byId["session-failed"]?.tone).toBe("success");
    expect(byId["cost"]?.detail).toMatch(/Exact/);
  });
});

describe("buildRecentRuns", () => {
  it("sorts newest first and caps the list", () => {
    const runs = Array.from({ length: RECENT_RUNS_LIMIT + 5 }, (_, index) =>
      run({
        runId: `run-${index}`,
        issueRef: index,
        detectedAt: new Date(NOW.getTime() - index * 60_000).toISOString(),
      }),
    );

    const rows = buildRecentRuns(runs, NOW);

    expect(rows).toHaveLength(RECENT_RUNS_LIMIT);
    expect(rows[0]?.issueLabel).toBe("#0");
    expect(rows[1]?.issueLabel).toBe("#1");
  });

  it("formats issue, elapsed time and pull request per run", () => {
    const [ongoing, done, orphan] = buildRecentRuns(
      [
        run({ runId: "ongoing", issueRef: 7, detectedAt: "2026-08-01T11:00:00.000Z" }),
        run({
          runId: "done",
          issueRef: 8,
          detectedAt: "2026-08-01T09:00:00.000Z",
          sessionFinishedAt: "2026-08-01T09:30:00.000Z",
          status: "finished",
          prUrl: "https://github.com/o/r/pull/9",
        }),
        run({
          runId: "orphan",
          issueRef: null,
          detectedAt: "2026-08-01T08:00:00.000Z",
          status: "dispatch_failed",
          sessionId: null,
        }),
      ],
      NOW,
    );

    expect(ongoing).toMatchObject({ issueLabel: "#7", elapsedLabel: "1h 0m", prUrl: null });
    expect(ongoing?.detectedAtLabel).toBe("2026-08-01 11:00:00");
    expect(done).toMatchObject({
      elapsedLabel: "30m 0s",
      statusLabel: "Finished",
      tone: "success",
      prUrl: "https://github.com/o/r/pull/9",
    });
    expect(orphan).toMatchObject({ issueLabel: "—", statusLabel: "Dispatch failed", tone: "danger" });
  });
});

describe("buildSuccessRateTrend", () => {
  it("returns one point per day, oldest first", () => {
    const trend = buildSuccessRateTrend(
      [
        run({
          detectedAt: "2026-08-01T09:00:00.000Z",
          status: "finished",
          prUrl: "https://github.com/o/r/pull/1",
        }),
        run({ runId: "b", detectedAt: "2026-08-01T09:30:00.000Z", status: "failed" }),
      ],
      NOW,
    );

    expect(trend).toHaveLength(7);
    expect(trend[0]?.date).toBe("2026-07-26");
    expect(trend.at(-1)).toEqual({ date: "2026-08-01", totalRuns: 2, successRate: 0.5 });
    expect(trend[0]).toEqual({ date: "2026-07-26", totalRuns: 0, successRate: 0 });
  });
});

describe("buildDashboardViewModel", () => {
  it("renders an empty state without throwing when there is no history", () => {
    const view = buildDashboardViewModel(computeMetrics([], NOW), [], NOW);

    expect(view.hasRuns).toBe(false);
    expect(view.emptyMessage).toMatch(/まだ実行がありません/);
    expect(view.recentRuns).toEqual([]);
    expect(view.successRateTrend).toHaveLength(7);
    expect(view.cards.map((card) => card.value)).toEqual(["0.0%", "0", "0", "—", "0", "0.00"]);
    expect(view.cards.every((card) => typeof card.detail === "string")).toBe(true);
  });

  it("marks the view as populated once runs exist", () => {
    const runs = [run({ status: "working" })];
    const view = buildDashboardViewModel(computeMetrics(runs, NOW), runs, NOW);

    expect(view.hasRuns).toBe(true);
    expect(view.recentRuns).toHaveLength(1);
    expect(view.generatedAtLabel).toBe("2026-08-01 12:00:00");
  });
});
