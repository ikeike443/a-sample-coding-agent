import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { SqliteRunStore } from "../src/observability/index.js";

const store = new SqliteRunStore({ filename: ":memory:" });
const app = buildApp({ logLevel: "silent", store });

beforeAll(async () => {
  await app.ready();
});

afterAll(async () => {
  await app.close();
  store.close();
});

describe("GET /dashboard/metrics", () => {
  it("serves the metrics computed from the observability store", async () => {
    const success = store.recordEvent({ triggerType: "webhook", issueRef: 1 });
    store.markWorking(success.runId, "devin-1");
    store.applySessionUpdate(success.runId, {
      status: "finished",
      prUrl: "https://github.com/o/r/pull/1",
      acuCost: 2,
    });

    const dispatchFailed = store.recordEvent({ triggerType: "webhook", issueRef: 2 });
    store.markDispatchFailed(dispatchFailed.runId, "Devin API unreachable");

    const response = await app.inject({ method: "GET", url: "/dashboard/metrics" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      totalRuns: 2,
      successfulRuns: 1,
      successRate: 0.5,
      failureBreakdown: { dispatchFailed: 1, dispatchFailedRate: 0.5, failed: 0 },
      throughputLast24h: 1,
      cost: { totalAcu: 2, estimated: true },
    });
  });
});
