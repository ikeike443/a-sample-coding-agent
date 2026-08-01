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
    outcome: null,
    blockedSince: null,
    ...overrides,
  };
}

describe("statusTone", () => {
  it("maps every status to its colour bucket", () => {
    const expected: Record<RunStatus, string> = {
      finished: "success",
      working: "progress",
      blocked: "progress",
      needs_human_attention: "danger",
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
      "remediated",
      "no-action-needed",
      "needs-human-attention",
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

  it("breaks the completions down into remediated and no action needed", () => {
    const runs = [
      run({
        runId: "a",
        status: "finished",
        outcome: "pr_created",
        prUrl: "https://github.com/o/r/pull/1",
        prUrlRecordedAt: "2026-08-01T11:00:00.000Z",
        sessionFinishedAt: "2026-08-01T11:00:00.000Z",
      }),
      run({
        runId: "b",
        status: "finished",
        outcome: "no_action_needed",
        sessionFinishedAt: "2026-08-01T11:00:00.000Z",
      }),
      run({ runId: "c", status: "needs_human_attention", blockedSince: "2026-08-01T10:10:00.000Z" }),
    ];

    const byId = Object.fromEntries(
      buildSummaryCards(computeMetrics(runs, NOW)).map((card) => [card.id, card]),
    );

    expect(byId["remediated"]?.value).toBe("1");
    expect(byId["no-action-needed"]?.value).toBe("1");
    expect(byId["needs-human-attention"]).toMatchObject({ value: "1", tone: "danger" });
    expect(byId["success-rate"]?.value).toBe("66.7%");
    expect(byId["success-rate"]?.detail).toBe(
      "2 of 3 run(s) completed by Devin (1 remediated + 1 no action needed)",
    );
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
    expect(byId["needs-human-attention"]?.tone).toBe("success");
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
          sessionFinishedAt: null,
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
    // Terminal without a finish timestamp: the elapsed time must not keep counting up.
    expect(orphan?.elapsedLabel).toBe("—");
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
  });

  it("reports days without runs as no data rather than a 0% success rate", () => {
    const trend = buildSuccessRateTrend([], NOW);

    expect(trend.every((point) => point.successRate === null && point.totalRuns === 0)).toBe(true);
  });
});

describe("buildDashboardViewModel", () => {
  it("renders an empty state without throwing when there is no history", () => {
    const view = buildDashboardViewModel(computeMetrics([], NOW), [], NOW);

    expect(view.hasRuns).toBe(false);
    expect(view.emptyMessage).toMatch(/まだ実行がありません/);
    expect(view.recentRuns).toEqual([]);
    expect(view.successRateTrend).toHaveLength(7);
    expect(view.successRateTrend.every((point) => point.successRate === null)).toBe(true);
    expect(view.cards.map((card) => card.value)).toEqual([
      "0.0%",
      "0",
      "0",
      "0",
      "0",
      "0",
      "—",
      "0",
      "0.00",
    ]);
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
