import { afterEach, describe, expect, it, vi } from "vitest";

import type { DevinClient, SessionDetail } from "../src/devin-client/index.js";
import {
  SessionPoller,
  SqliteRunStore,
  type PollerLogger,
} from "../src/observability/index.js";

const stores: SqliteRunStore[] = [];

function store(): SqliteRunStore {
  const created = new SqliteRunStore({ filename: ":memory:" });
  stores.push(created);
  return created;
}

afterEach(() => {
  while (stores.length > 0) {
    stores.pop()?.close();
  }
});

function fakeLogger(): PollerLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function fakeClient(getSession: ReturnType<typeof vi.fn>): DevinClient {
  return { getSession } as unknown as DevinClient;
}

function detail(overrides: Partial<SessionDetail> = {}): SessionDetail {
  return { session_id: "devin-1", status: "running", ...overrides };
}

describe("SessionPoller", () => {
  it("asks the Devin API about active runs only", async () => {
    const runs = store();
    const working = runs.recordEvent({ triggerType: "webhook", issueRef: 1 });
    runs.markWorking(working.runId, "devin-1");
    const dispatchFailed = runs.recordEvent({ triggerType: "webhook", issueRef: 2 });
    runs.markDispatchFailed(dispatchFailed.runId, "boom");

    const getSession = vi.fn(async () => detail());
    await new SessionPoller({
      store: runs,
      client: fakeClient(getSession),
      logger: fakeLogger(),
    }).pollOnce();

    expect(getSession).toHaveBeenCalledTimes(1);
    expect(getSession).toHaveBeenCalledWith("devin-1");
    expect(runs.getRun(dispatchFailed.runId)?.status).toBe("dispatch_failed");
  });

  it("records the pull request URL and ACU cost when the session finishes", async () => {
    const runs = store();
    const run = runs.recordEvent({ triggerType: "webhook", issueRef: 1 });
    runs.markWorking(run.runId, "devin-1");

    const getSession = vi.fn(async () =>
      detail({
        status: "exit",
        acus_consumed: 4.25,
        pull_requests: [{ pr_url: "https://github.com/o/r/pull/9", pr_state: "open" }],
      }),
    );
    await new SessionPoller({
      store: runs,
      client: fakeClient(getSession),
      logger: fakeLogger(),
    }).pollOnce();

    expect(runs.getRun(run.runId)).toMatchObject({
      status: "finished",
      prUrl: "https://github.com/o/r/pull/9",
      acuCost: 4.25,
      prMergedAt: null,
    });
  });

  it("falls back to the structured output for the pull request URL", async () => {
    const runs = store();
    const run = runs.recordEvent({ triggerType: "webhook", issueRef: 1 });
    runs.markWorking(run.runId, "devin-1");

    const getSession = vi.fn(async () =>
      detail({ status: "exit", structured_output: { pr_url: "https://github.com/o/r/pull/11" } }),
    );
    await new SessionPoller({
      store: runs,
      client: fakeClient(getSession),
      logger: fakeLogger(),
    }).pollOnce();

    expect(runs.getRun(run.runId)?.prUrl).toBe("https://github.com/o/r/pull/11");
  });

  it("maps suspended sessions to blocked and errored sessions to failed", async () => {
    const runs = store();
    const blocked = runs.recordEvent({ triggerType: "webhook", issueRef: 1 });
    runs.markWorking(blocked.runId, "devin-blocked");
    const failed = runs.recordEvent({ triggerType: "webhook", issueRef: 2 });
    runs.markWorking(failed.runId, "devin-failed");

    const getSession = vi.fn(async (sessionId: string) =>
      sessionId === "devin-blocked"
        ? detail({ session_id: sessionId, status: "suspended" })
        : detail({ session_id: sessionId, status: "error", status_detail: "ran out of ACUs" }),
    );
    await new SessionPoller({
      store: runs,
      client: fakeClient(getSession as unknown as ReturnType<typeof vi.fn>),
      logger: fakeLogger(),
    }).pollOnce();

    expect(runs.getRun(blocked.runId)?.status).toBe("blocked");
    expect(runs.getRun(failed.runId)).toMatchObject({
      status: "failed",
      errorMessage: "ran out of ACUs",
    });
  });

  it("finishes a blocked session that already reported an outcome", async () => {
    const runs = store();
    const remediated = runs.recordEvent({ triggerType: "webhook", issueRef: 1 });
    runs.markWorking(remediated.runId, "devin-pr");
    const noAction = runs.recordEvent({ triggerType: "webhook", issueRef: 2 });
    runs.markWorking(noAction.runId, "devin-no-action");

    const getSession = vi.fn(async (sessionId: string) =>
      sessionId === "devin-pr"
        ? detail({
            session_id: sessionId,
            status: "blocked",
            structured_output: {
              outcome: "pr_created",
              summary: "fixed the typo",
              pr_url: "https://github.com/o/r/pull/12",
            },
          })
        : detail({
            session_id: sessionId,
            status: "blocked",
            structured_output: {
              outcome: "no_action_needed",
              summary: "no typo found",
              pr_url: null,
            },
          }),
    );
    await new SessionPoller({
      store: runs,
      client: fakeClient(getSession as unknown as ReturnType<typeof vi.fn>),
      logger: fakeLogger(),
    }).pollOnce();

    expect(runs.getRun(remediated.runId)).toMatchObject({
      status: "finished",
      outcome: "pr_created",
      prUrl: "https://github.com/o/r/pull/12",
    });
    expect(runs.getRun(noAction.runId)).toMatchObject({
      status: "finished",
      outcome: "no_action_needed",
      prUrl: null,
    });
    expect(runs.getRun(noAction.runId)?.sessionFinishedAt).not.toBeNull();
  });

  it("flags a blocked session that asked a question as needing human attention", async () => {
    const runs = store();
    const run = runs.recordEvent({ triggerType: "webhook", issueRef: 1 });
    runs.markWorking(run.runId, "devin-1");

    const getSession = vi.fn(async () =>
      detail({
        status: "blocked",
        structured_output: { outcome: "blocked_on_question", summary: "which file?" },
      }),
    );
    await new SessionPoller({
      store: runs,
      client: fakeClient(getSession),
      logger: fakeLogger(),
    }).pollOnce();

    expect(runs.getRun(run.runId)).toMatchObject({
      status: "needs_human_attention",
      outcome: "blocked_on_question",
    });
  });

  it("keeps a briefly blocked session without structured output as blocked", async () => {
    const runs = store();
    const run = runs.recordEvent({ triggerType: "webhook", issueRef: 1 });
    runs.markWorking(run.runId, "devin-1");

    const getSession = vi.fn(async () => detail({ status: "blocked" }));
    await new SessionPoller({
      store: runs,
      client: fakeClient(getSession),
      logger: fakeLogger(),
      blockedGraceMs: 600_000,
    }).pollOnce();

    const blocked = runs.getRun(run.runId);
    expect(blocked).toMatchObject({ status: "blocked", outcome: null });
    expect(blocked?.blockedSince).not.toBeNull();
  });

  it("escalates to needs_human_attention once blocked outlasts the grace period", async () => {
    const clock = vi.fn(() => new Date("2026-01-01T00:00:00.000Z"));
    const runs = new SqliteRunStore({ filename: ":memory:", now: clock });
    stores.push(runs);
    const run = runs.recordEvent({ triggerType: "webhook", issueRef: 1 });
    runs.markWorking(run.runId, "devin-1");

    const getSession = vi.fn(async () => detail({ status: "blocked" }));
    const poller = new SessionPoller({
      store: runs,
      client: fakeClient(getSession),
      logger: fakeLogger(),
      blockedGraceMs: 600_000,
      now: () => clock(),
    });

    await poller.pollOnce();
    expect(runs.getRun(run.runId)?.status).toBe("blocked");

    // Ten minutes later the session is still blocked and still silent.
    clock.mockReturnValue(new Date("2026-01-01T00:10:00.000Z"));
    await poller.pollOnce();

    expect(runs.getRun(run.runId)).toMatchObject({
      status: "needs_human_attention",
      blockedSince: "2026-01-01T00:00:00.000Z",
    });
  });

  it("records pr_merged_at when the API reports the pull request as merged", async () => {
    const runs = store();
    const run = runs.recordEvent({ triggerType: "webhook", issueRef: 4 });
    runs.markWorking(run.runId, "devin-1");

    const getSession = vi.fn(async () =>
      detail({
        status: "running",
        structured_output: { outcome: "pr_created", summary: "translated the README" },
        pull_requests: [{ pr_url: "https://github.com/o/r/pull/5", pr_state: "merged" }],
      }),
    );
    await new SessionPoller({
      store: runs,
      client: fakeClient(getSession),
      logger: fakeLogger(),
    }).pollOnce();

    const merged = runs.getRun(run.runId);
    expect(merged).toMatchObject({
      status: "finished",
      outcome: "pr_created",
      prUrl: "https://github.com/o/r/pull/5",
    });
    expect(merged?.prMergedAt).not.toBeNull();
  });

  it("keeps the first pr_merged_at across later polls", async () => {
    const clock = vi.fn(() => new Date("2026-01-01T00:00:00.000Z"));
    const runs = new SqliteRunStore({ filename: ":memory:", now: clock });
    stores.push(runs);
    const run = runs.recordEvent({ triggerType: "webhook", issueRef: 4 });
    runs.markWorking(run.runId, "devin-1");

    const update = {
      status: "finished" as const,
      prUrl: "https://github.com/o/r/pull/5",
      prMerged: true,
    };
    runs.applySessionUpdate(run.runId, update);
    clock.mockReturnValue(new Date("2026-01-01T01:00:00.000Z"));
    runs.applySessionUpdate(run.runId, update);

    expect(runs.getRun(run.runId)?.prMergedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("keeps a running session that reported pr_created on an open PR as working", async () => {
    const runs = store();
    const run = runs.recordEvent({ triggerType: "webhook", issueRef: 4 });
    runs.markWorking(run.runId, "devin-1");

    const getSession = vi.fn(async () =>
      detail({
        status: "running",
        structured_output: { outcome: "pr_created", summary: "waiting for CI" },
        pull_requests: [{ pr_url: "https://github.com/o/r/pull/5", pr_state: "open" }],
      }),
    );
    await new SessionPoller({
      store: runs,
      client: fakeClient(getSession),
      logger: fakeLogger(),
      blockedGraceMs: 600_000,
    }).pollOnce();

    const working = runs.getRun(run.runId);
    // Still working, but the clock now runs so a stalled report can settle.
    expect(working).toMatchObject({ status: "working", outcome: "pr_created" });
    expect(working?.blockedSince).not.toBeNull();
  });

  it("finishes a running session whose reported outcome outlasts the grace period", async () => {
    const clock = vi.fn(() => new Date("2026-01-01T00:00:00.000Z"));
    const runs = new SqliteRunStore({ filename: ":memory:", now: clock });
    stores.push(runs);
    const run = runs.recordEvent({ triggerType: "webhook", issueRef: 4 });
    runs.markWorking(run.runId, "devin-1");

    const getSession = vi.fn(async () =>
      detail({
        status: "running",
        structured_output: { outcome: "no_action_needed", summary: "nothing to fix" },
      }),
    );
    const poller = new SessionPoller({
      store: runs,
      client: fakeClient(getSession),
      logger: fakeLogger(),
      blockedGraceMs: 600_000,
      now: () => clock(),
    });

    await poller.pollOnce();
    expect(runs.getRun(run.runId)?.status).toBe("working");

    clock.mockReturnValue(new Date("2026-01-01T00:10:00.000Z"));
    await poller.pollOnce();

    expect(runs.getRun(run.runId)).toMatchObject({
      status: "finished",
      outcome: "no_action_needed",
    });
  });

  it("escalates a running session that asked a question", async () => {
    const runs = store();
    const run = runs.recordEvent({ triggerType: "webhook", issueRef: 4 });
    runs.markWorking(run.runId, "devin-1");

    const getSession = vi.fn(async () =>
      detail({
        status: "running",
        structured_output: { outcome: "blocked_on_question", summary: "which file?" },
      }),
    );
    await new SessionPoller({
      store: runs,
      client: fakeClient(getSession),
      logger: fakeLogger(),
    }).pollOnce();

    expect(runs.getRun(run.runId)?.status).toBe("needs_human_attention");
  });

  it("keeps a running session without any reported outcome as working", async () => {
    const runs = store();
    const run = runs.recordEvent({ triggerType: "webhook", issueRef: 4 });
    runs.markWorking(run.runId, "devin-1");

    const getSession = vi.fn(async () => detail({ status: "running" }));
    await new SessionPoller({
      store: runs,
      client: fakeClient(getSession),
      logger: fakeLogger(),
    }).pollOnce();

    const working = runs.getRun(run.runId);
    expect(working).toMatchObject({ status: "working", outcome: null });
    expect(working?.blockedSince).toBeNull();
  });

  it("logs and keeps the run when the Devin API call fails", async () => {
    const runs = store();
    const run = runs.recordEvent({ triggerType: "webhook", issueRef: 1 });
    runs.markWorking(run.runId, "devin-1");
    const logger = fakeLogger();

    const getSession = vi.fn(async () => {
      throw new Error("network down");
    });
    await new SessionPoller({
      store: runs,
      client: fakeClient(getSession),
      logger,
    }).pollOnce();

    expect(runs.getRun(run.runId)?.status).toBe("working");
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ runId: run.runId }),
      "failed to refresh run status",
    );
  });

  it("keeps ticking when the store itself throws", async () => {
    vi.useFakeTimers();
    try {
      const runs = store();
      const listActiveRuns = vi.spyOn(runs, "listActiveRuns").mockImplementation(() => {
        throw new Error("database is locked");
      });
      const logger = fakeLogger();

      const poller = new SessionPoller({
        store: runs,
        client: fakeClient(vi.fn()),
        logger,
        intervalMs: 30_000,
      });
      poller.start();
      await vi.advanceTimersByTimeAsync(60_000);
      poller.stop();

      expect(listActiveRuns).toHaveBeenCalledTimes(2);
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        "session poll failed",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("stop() waits for the real in-flight poll even when a later tick is skipped", async () => {
    const runs = store();
    const run = runs.recordEvent({ triggerType: "webhook", issueRef: 1 });
    runs.markWorking(run.runId, "devin-1");

    let releaseSession: () => void = () => {};
    const getSession = vi.fn(
      () =>
        new Promise<SessionDetail>((resolve) => {
          releaseSession = () => resolve(detail());
        }),
    );
    const poller = new SessionPoller({
      store: runs,
      client: fakeClient(getSession),
      logger: fakeLogger(),
    });

    // Real poll starts and blocks inside getSession.
    const firstPoll = poller.pollOnce();
    await Promise.resolve();
    // A concurrent tick is skipped by the `running` guard; it must not clear
    // the tracking for the still-running first poll.
    await poller.pollOnce();
    expect(getSession).toHaveBeenCalledTimes(1);

    let stopped = false;
    const stopping = poller.stop().then(() => {
      stopped = true;
    });

    await Promise.resolve();
    expect(stopped).toBe(false); // still draining the in-flight poll

    releaseSession();
    await stopping;
    await firstPoll;
    expect(stopped).toBe(true);
  });

  it("polls on the configured interval once started", async () => {
    vi.useFakeTimers();
    try {
      const runs = store();
      const run = runs.recordEvent({ triggerType: "webhook", issueRef: 1 });
      runs.markWorking(run.runId, "devin-1");

      const getSession = vi.fn(async () => detail());
      const poller = new SessionPoller({
        store: runs,
        client: fakeClient(getSession),
        logger: fakeLogger(),
        intervalMs: 30_000,
      });
      poller.start();

      await vi.advanceTimersByTimeAsync(60_000);
      poller.stop();

      expect(getSession).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
