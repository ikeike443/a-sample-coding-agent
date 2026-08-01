import { describe, expect, it } from "vitest";

import { computeMetrics, type RunRecord } from "../src/observability/index.js";

const NOW = new Date("2026-01-02T00:00:00.000Z");

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: Math.random().toString(36).slice(2),
    issueRef: 1,
    triggerType: "webhook",
    sessionId: "devin-1",
    tags: [],
    detectedAt: "2026-01-01T00:00:00.000Z",
    sessionStartedAt: "2026-01-01T00:00:10.000Z",
    sessionFinishedAt: null,
    status: "working",
    prUrl: null,
    prUrlRecordedAt: null,
    prMergedAt: null,
    acuCost: null,
    errorMessage: null,
    outcome: null,
    outcomeReportedAt: null,
    blockedSince: null,
    issueClosedAt: null,
    ...overrides,
  };
}

function finished(overrides: Partial<RunRecord> = {}): RunRecord {
  return run({
    status: "finished",
    prUrl: "https://github.com/o/r/pull/1",
    prUrlRecordedAt: "2026-01-01T01:00:00.000Z",
    sessionFinishedAt: "2026-01-01T01:00:00.000Z",
    acuCost: 2,
    ...overrides,
  });
}

describe("computeMetrics", () => {
  it("reports zeroed metrics for an empty store", () => {
    const metrics = computeMetrics([], NOW);

    expect(metrics).toMatchObject({
      totalRuns: 0,
      successRate: 0,
      mttrMs: null,
      throughputLast24h: 0,
    });
    expect(metrics.cost.totalAcu).toBe(0);
  });

  it("counts a run as successful only when it finished with a pull request", () => {
    const metrics = computeMetrics(
      [
        finished(),
        finished({ prUrl: null, prUrlRecordedAt: null }),
        run({ status: "dispatch_failed", sessionId: null }),
        run(),
      ],
      NOW,
    );

    expect(metrics.totalRuns).toBe(4);
    expect(metrics.successfulRuns).toBe(1);
    expect(metrics.successRate).toBe(0.25);
  });

  it("counts a no_action_needed completion as a success, not a failure", () => {
    const metrics = computeMetrics(
      [
        finished({ outcome: "pr_created" }),
        finished({ outcome: "no_action_needed", prUrl: null, prUrlRecordedAt: null }),
        run({ status: "needs_human_attention", blockedSince: "2026-01-01T00:00:00.000Z" }),
        run({ status: "failed" }),
      ],
      NOW,
    );

    expect(metrics.outcomes).toEqual({
      remediated: 1,
      noActionNeeded: 1,
      issueClosed: 0,
      needsHumanAttention: 1,
    });
    // (remediated + noActionNeeded) / totalRuns — the old definition scored 0.25.
    expect(metrics.successfulRuns).toBe(2);
    expect(metrics.successRate).toBe(0.5);
    expect(metrics.statusCounts.needs_human_attention).toBe(1);
  });

  it("counts a run finished by its issue being closed as a success", () => {
    const metrics = computeMetrics(
      [
        finished({
          prUrl: null,
          prUrlRecordedAt: null,
          issueClosedAt: "2026-01-01T02:00:00.000Z",
        }),
        // Already remediated: the issue closure must not double count it.
        finished({ outcome: "pr_created", issueClosedAt: "2026-01-01T02:00:00.000Z" }),
        run({ status: "failed" }),
      ],
      NOW,
    );

    expect(metrics.outcomes).toMatchObject({ remediated: 1, issueClosed: 1, noActionNeeded: 0 });
    expect(metrics.successfulRuns).toBe(2);
  });

  it("keeps a blocked_on_question completion out of the success rate", () => {
    const metrics = computeMetrics(
      [finished({ outcome: "pr_created" }), run({ status: "needs_human_attention" })],
      NOW,
    );

    expect(metrics.successRate).toBe(0.5);
    expect(metrics.outcomes.needsHumanAttention).toBe(1);
  });

  it("splits the failures into dispatch failures and session failures", () => {
    const metrics = computeMetrics(
      [
        run({ status: "dispatch_failed", sessionId: null, errorMessage: "500" }),
        run({ status: "dispatch_failed", sessionId: null, errorMessage: "timeout" }),
        run({ status: "failed" }),
        finished(),
      ],
      NOW,
    );

    expect(metrics.failureBreakdown).toEqual({
      dispatchFailed: 2,
      dispatchFailedRate: 0.5,
      failed: 1,
      failedRate: 0.25,
    });
    expect(metrics.statusCounts.dispatch_failed).toBe(2);
  });

  it("averages the time between detection and the recorded pull request for MTTR", () => {
    const metrics = computeMetrics(
      [
        finished(),
        finished({ prUrlRecordedAt: "2026-01-01T03:00:00.000Z" }),
        run({ status: "dispatch_failed", sessionId: null }),
      ],
      NOW,
    );

    expect(metrics.mttrSampleSize).toBe(2);
    expect(metrics.mttrMs).toBe(2 * 60 * 60 * 1000);
  });

  it("counts only the last 24 hours of finished runs in the throughput", () => {
    const metrics = computeMetrics(
      [
        finished({
          sessionFinishedAt: "2026-01-01T23:00:00.000Z",
          prUrlRecordedAt: "2026-01-01T23:00:00.000Z",
        }),
        finished({
          detectedAt: "2025-12-29T00:00:00.000Z",
          sessionFinishedAt: "2025-12-30T00:00:00.000Z",
          prUrlRecordedAt: "2025-12-30T00:00:00.000Z",
        }),
      ],
      NOW,
    );

    expect(metrics.throughputLast24h).toBe(1);
  });

  it("sums the ACU cost and flags it as approximate while runs lack a cost", () => {
    const exact = computeMetrics([finished({ acuCost: 2 }), finished({ acuCost: 1.5 })], NOW);
    expect(exact.cost).toMatchObject({ totalAcu: 3.5, runsWithoutCost: 0, estimated: false });

    const approximate = computeMetrics([finished({ acuCost: 2 }), run()], NOW);
    expect(approximate.cost).toMatchObject({ totalAcu: 2, runsWithoutCost: 1, estimated: true });
    expect(approximate.cost.note).toContain("Approximate");
  });
});
