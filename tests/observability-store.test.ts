import { afterEach, describe, expect, it, vi } from "vitest";

import { SqliteRunStore } from "../src/observability/index.js";

const stores: SqliteRunStore[] = [];

function store(now?: () => Date): SqliteRunStore {
  const created = new SqliteRunStore({ filename: ":memory:", now });
  stores.push(created);
  return created;
}

afterEach(() => {
  while (stores.length > 0) {
    stores.pop()?.close();
  }
});

describe("SqliteRunStore issue closure", () => {
  it("finishes the active runs of a closed issue and leaves terminal ones alone", () => {
    const runs = store(() => new Date("2026-01-01T00:00:00.000Z"));
    const active = runs.recordEvent({ issueRef: 42, triggerType: "webhook" });
    runs.markWorking(active.runId, "devin-1");
    const failed = runs.recordEvent({ issueRef: 42, triggerType: "webhook" });
    runs.markDispatchFailed(failed.runId, "boom");
    const otherIssue = runs.recordEvent({ issueRef: 7, triggerType: "webhook" });
    runs.markWorking(otherIssue.runId, "devin-2");

    const closed = runs.markIssueClosed(42);

    expect(closed).toHaveLength(2);
    expect(runs.getRun(active.runId)).toMatchObject({
      status: "finished",
      issueClosedAt: "2026-01-01T00:00:00.000Z",
      sessionFinishedAt: "2026-01-01T00:00:00.000Z",
    });
    // Already terminal: only the issue closure is recorded.
    expect(runs.getRun(failed.runId)).toMatchObject({
      status: "dispatch_failed",
      issueClosedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(runs.getRun(otherIssue.runId)).toMatchObject({ status: "working", issueClosedAt: null });
  });

  it("does nothing for an issue without runs", () => {
    const runs = store();

    expect(runs.markIssueClosed(999)).toEqual([]);
  });
});

describe("SqliteRunStore state transitions", () => {
  it("records a webhook event as pending", () => {
    const runs = store(() => new Date("2026-01-01T00:00:00.000Z"));

    const run = runs.recordEvent({
      issueRef: 42,
      triggerType: "webhook",
      tags: ["remediation", "issue-42"],
    });

    expect(run).toMatchObject({
      issueRef: 42,
      triggerType: "webhook",
      status: "pending",
      sessionId: null,
      detectedAt: "2026-01-01T00:00:00.000Z",
      prUrl: null,
      prMergedAt: null,
      errorMessage: null,
    });
    expect(runs.getRun(run.runId)).toEqual({ ...run, tags: ["remediation", "issue-42"] });
  });

  it("moves pending -> dispatch_failed and keeps the error message without a session id", () => {
    const runs = store();
    const run = runs.recordEvent({ triggerType: "webhook", issueRef: 7 });

    const updated = runs.markDispatchFailed(run.runId, "Devin API POST /sessions failed: 500");

    expect(updated).toMatchObject({
      status: "dispatch_failed",
      sessionId: null,
      errorMessage: "Devin API POST /sessions failed: 500",
    });
  });

  it("moves pending -> working when the session is created", () => {
    const runs = store(() => new Date("2026-01-01T00:05:00.000Z"));
    const run = runs.recordEvent({ triggerType: "webhook", issueRef: 7 });

    const updated = runs.markWorking(run.runId, "devin-123");

    expect(updated).toMatchObject({
      status: "working",
      sessionId: "devin-123",
      sessionStartedAt: "2026-01-01T00:05:00.000Z",
    });
    expect(runs.listActiveRuns().map((r) => r.runId)).toEqual([run.runId]);
  });

  it("moves working -> finished and stamps the pull request URL", () => {
    const now = vi.fn(() => new Date("2026-01-01T00:00:00.000Z"));
    const runs = store(now);
    const run = runs.recordEvent({ triggerType: "webhook", issueRef: 7 });
    runs.markWorking(run.runId, "devin-123");
    now.mockReturnValue(new Date("2026-01-01T01:00:00.000Z"));

    const updated = runs.applySessionUpdate(run.runId, {
      status: "finished",
      prUrl: "https://github.com/o/r/pull/9",
      acuCost: 3.5,
    });

    expect(updated).toMatchObject({
      status: "finished",
      prUrl: "https://github.com/o/r/pull/9",
      prUrlRecordedAt: "2026-01-01T01:00:00.000Z",
      sessionFinishedAt: "2026-01-01T01:00:00.000Z",
      acuCost: 3.5,
      prMergedAt: null,
    });
    // Still watched: the session can be resumed by a human for a while yet.
    expect(runs.listActiveRuns().map((r) => r.runId)).toEqual([run.runId]);

    now.mockReturnValue(new Date("2026-01-03T01:00:00.000Z"));
    expect(runs.listActiveRuns()).toEqual([]);
  });

  it("reopens a finished run whose session went back to work", () => {
    const now = vi.fn(() => new Date("2026-01-01T00:00:00.000Z"));
    const runs = store(now);
    const run = runs.recordEvent({ triggerType: "webhook", issueRef: 7 });
    runs.markWorking(run.runId, "devin-123");
    now.mockReturnValue(new Date("2026-01-01T01:00:00.000Z"));
    runs.applySessionUpdate(run.runId, { status: "finished", outcome: "pr_created" });

    now.mockReturnValue(new Date("2026-01-01T02:00:00.000Z"));
    const reopened = runs.applySessionUpdate(run.runId, {
      status: "working",
      outcome: "pr_created",
    });

    expect(reopened).toMatchObject({
      status: "working",
      sessionFinishedAt: null,
      // The outcome clock restarts with the new turn.
      outcomeReportedAt: "2026-01-01T02:00:00.000Z",
    });
  });

  it("settles a run on its pull request being closed, merged or not", () => {
    const now = vi.fn(() => new Date("2026-01-01T00:00:00.000Z"));
    const runs = store(now);
    const prUrl = "https://github.com/o/r/pull/9";
    const rejected = runs.recordEvent({ triggerType: "webhook", issueRef: 7 });
    runs.markWorking(rejected.runId, "devin-123");
    runs.applySessionUpdate(rejected.runId, { status: "working", prUrl });

    now.mockReturnValue(new Date("2026-01-01T03:00:00.000Z"));
    const settled = runs.markPullRequestClosed(prUrl, false);

    expect(settled).toHaveLength(1);
    expect(runs.getRun(rejected.runId)).toMatchObject({
      status: "pr_rejected",
      prClosedAt: "2026-01-01T03:00:00.000Z",
      prMergedAt: null,
      sessionFinishedAt: "2026-01-01T03:00:00.000Z",
    });

    const merged = runs.recordEvent({ triggerType: "webhook", issueRef: 8 });
    runs.markWorking(merged.runId, "devin-456");
    runs.applySessionUpdate(merged.runId, {
      status: "working",
      prUrl: "https://github.com/o/r/pull/10",
    });
    runs.markPullRequestClosed("https://github.com/o/r/pull/10", true);

    expect(runs.getRun(merged.runId)).toMatchObject({
      status: "finished",
      prMergedAt: "2026-01-01T03:00:00.000Z",
      prClosedAt: null,
    });
  });

  it("leaves a failed run's status alone when its pull request is closed", () => {
    const runs = store(() => new Date("2026-01-01T00:00:00.000Z"));
    const prUrl = "https://github.com/o/r/pull/9";
    const run = runs.recordEvent({ triggerType: "webhook", issueRef: 7 });
    runs.markWorking(run.runId, "devin-123");
    runs.applySessionUpdate(run.runId, { status: "failed", prUrl });

    runs.markPullRequestClosed(prUrl, false);

    expect(runs.getRun(run.runId)).toMatchObject({
      status: "failed",
      prClosedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("keeps a session that failed after creation distinguishable from a failed dispatch", () => {
    const runs = store();
    const run = runs.recordEvent({ triggerType: "webhook", issueRef: 7 });
    runs.markWorking(run.runId, "devin-123");

    const updated = runs.applySessionUpdate(run.runId, {
      status: "failed",
      errorMessage: "session ended in error",
    });

    expect(updated).toMatchObject({
      status: "failed",
      sessionId: "devin-123",
      errorMessage: "session ended in error",
    });
  });

  it("polls blocked runs and keeps an already recorded pr_url", () => {
    const runs = store();
    const run = runs.recordEvent({ triggerType: "schedule", issueRef: null });
    runs.markWorking(run.runId, "devin-123");
    runs.applySessionUpdate(run.runId, {
      status: "blocked",
      prUrl: "https://github.com/o/r/pull/9",
    });

    expect(runs.listActiveRuns().map((r) => r.status)).toEqual(["blocked"]);
    expect(runs.getRun(run.runId)?.blockedSince).not.toBeNull();
    expect(runs.applySessionUpdate(run.runId, { status: "finished" })).toMatchObject({
      status: "finished",
      prUrl: "https://github.com/o/r/pull/9",
      blockedSince: null,
    });
  });

  it("keeps the blocked clock across blocked polls and stores the reported outcome", () => {
    const now = vi.fn(() => new Date("2026-01-01T00:00:00.000Z"));
    const runs = store(now);
    const run = runs.recordEvent({ triggerType: "webhook", issueRef: 7 });
    runs.markWorking(run.runId, "devin-123");

    runs.applySessionUpdate(run.runId, { status: "blocked" });
    now.mockReturnValue(new Date("2026-01-01T00:10:00.000Z"));
    const stillBlocked = runs.applySessionUpdate(run.runId, { status: "needs_human_attention" });

    expect(stillBlocked).toMatchObject({
      status: "needs_human_attention",
      blockedSince: "2026-01-01T00:00:00.000Z",
      sessionFinishedAt: null,
    });
    expect(runs.listActiveRuns().map((r) => r.runId)).toEqual([run.runId]);

    expect(
      runs.applySessionUpdate(run.runId, { status: "finished", outcome: "no_action_needed" }),
    ).toMatchObject({ status: "finished", outcome: "no_action_needed", blockedSince: null });
  });
});
