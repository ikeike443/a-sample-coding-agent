import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type { DevinClient, SessionDetail } from "../src/devin-client/index.js";
import { SqliteRunStore } from "../src/observability/index.js";
import { computeSignature } from "../src/webhook/signature.js";

/**
 * End-to-end-ish flow across the real components (webhook intake → observability
 * store → dashboard metrics), with only the Devin client mocked. Exercises the
 * whole app wired by `buildApp`, on a temporary in-memory database.
 */

const SECRET = "integration-test-secret";
process.env.GITHUB_WEBHOOK_SECRET = SECRET;

let resolveCreate: () => void = () => {};
const sessionCreated = new Promise<void>((resolve) => {
  resolveCreate = resolve;
});

const createSession = vi.fn(async () => {
  resolveCreate();
  return { session_id: "devin-integration-1", url: "https://app.devin.ai/sessions/devin-integration-1" };
});
// Harmless if the background poller ever ticks: reports the session still running.
const getSession = vi.fn(
  async (): Promise<SessionDetail> => ({ session_id: "devin-integration-1", status: "running" }),
);
const devinClient = { createSession, getSession } as unknown as DevinClient;

const store = new SqliteRunStore({ filename: ":memory:" });
const app = buildApp({ logLevel: "silent", store, devinClient });

function signedWebhook(payload: unknown, deliveryId: string) {
  const body = JSON.stringify(payload);
  return app.inject({
    method: "POST",
    url: "/webhook/github",
    headers: {
      "content-type": "application/json",
      "x-github-event": "issues",
      "x-github-delivery": deliveryId,
      "x-hub-signature-256": computeSignature(SECRET, body),
    },
    payload: body,
  });
}

const actionablePayload = {
  action: "labeled",
  label: { name: "devin-remediate" },
  repository: { full_name: "ikeike443/a-sample-coding-agent" },
  issue: { number: 101, labels: [{ name: "devin-remediate" }] },
};

beforeAll(async () => {
  await app.ready();
});

afterAll(async () => {
  await app.close();
  store.close();
});

describe("webhook → observability → dashboard", () => {
  it("records a run for a signed actionable webhook and reflects it in the metrics", async () => {
    const response = await signedWebhook(actionablePayload, "integration-delivery-1");

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "accepted" });

    // The dispatch runs outside the request lifecycle: wait for the Devin
    // session to be created and the run to reach `working`.
    await sessionCreated;
    await vi.waitFor(() => {
      const working = store.listRuns().find((run) => run.status === "working");
      expect(working).toBeTruthy();
    });

    expect(createSession).toHaveBeenCalledTimes(1);

    const runs = store.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      issueRef: 101,
      triggerType: "webhook",
      status: "working",
      sessionId: "devin-integration-1",
      tags: ["remediation", "trigger-webhook", "issue-101"],
    });

    const metrics = await app.inject({ method: "GET", url: "/dashboard/metrics" });
    expect(metrics.statusCode).toBe(200);

    const body = metrics.json();
    expect(body.totalRuns).toBe(1);
    expect(body.view.hasRuns).toBe(true);
    expect(body.view.recentRuns[0]).toMatchObject({ issueLabel: "#101", status: "working" });
  });
});
