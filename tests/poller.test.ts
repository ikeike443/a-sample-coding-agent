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
