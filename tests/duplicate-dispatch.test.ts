import type { FastifyBaseLogger } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type { DevinClient, SessionDetail } from "../src/devin-client/index.js";
import { PENDING_STALE_MS, SqliteRunStore } from "../src/observability/index.js";
import { dispatchToDevin } from "../src/webhook/dispatch.js";
import { normaliseEvent, type NormalisedEvent } from "../src/webhook/normalize.js";
import { computeSignature } from "../src/webhook/signature.js";

/**
 * Regression coverage for duplicate Devin sessions: a single `devin-remediate`
 * labelling must start exactly one remediation run, even when GitHub sends the
 * trigger under several delivery ids or an unrelated label is added later.
 */

const SECRET = "duplicate-test-secret";
process.env.GITHUB_WEBHOOK_SECRET = SECRET;

let sessionCounter = 0;
const createSession = vi.fn(async () => {
  sessionCounter += 1;
  return { session_id: `devin-${sessionCounter}` };
});
const getSession = vi.fn(
  async (): Promise<SessionDetail> => ({ session_id: "devin-1", status: "running" }),
);
const devinClient = {
  createRemediationSession: createSession,
  getSession,
} as unknown as DevinClient;

const store = new SqliteRunStore({ filename: ":memory:" });
const app = buildApp({ logLevel: "silent", store, devinClient });

beforeAll(async () => {
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

function labelledPayload(issueNumber: number, addedLabel: string, labels = [addedLabel]) {
  return {
    action: "labeled",
    label: { name: addedLabel },
    repository: { full_name: "ikeike443/superset" },
    issue: { number: issueNumber, labels: labels.map((name) => ({ name })) },
  };
}

function post(payload: unknown, deliveryId: string) {
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

/** Lets the fire-and-forget dispatch settle before asserting on it. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

function fakeLogger(): FastifyBaseLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as FastifyBaseLogger;
}

function event(overrides: Partial<NormalisedEvent> = {}): NormalisedEvent {
  return {
    deliveryId: "delivery-x",
    event: "issues",
    action: "labeled",
    repository: "ikeike443/superset",
    issueNumber: 900,
    labels: ["devin-remediate"],
    actionable: true,
    issueClosed: false,
    reason: "actionable",
    ...overrides,
  };
}

describe("duplicate trigger idempotency", () => {
  it("creates a single session when the same labelling arrives under two delivery ids", async () => {
    createSession.mockClear();

    const first = await post(labelledPayload(6, "devin-remediate"), "delivery-6-a");
    const second = await post(labelledPayload(6, "devin-remediate"), "delivery-6-b");
    await settle();

    expect(first.json()).toMatchObject({ status: "accepted" });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ status: "duplicate_trigger" });
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it("ignores a later unrelated label on an issue that already carries devin-remediate", async () => {
    createSession.mockClear();

    const response = await post(
      labelledPayload(7, "bug", ["devin-remediate", "bug"]),
      "delivery-7-a",
    );
    await settle();

    expect(response.json()).toMatchObject({ status: "ignored", reason: "label_not_matched" });
    expect(createSession).not.toHaveBeenCalled();
  });
});

describe("normaliseEvent trigger keys", () => {
  it("keys the trigger on repository, issue and label rather than the delivery id", () => {
    const payload = labelledPayload(6, "devin-remediate");

    expect(normaliseEvent("a", "issues", payload).triggerKey).toBe(
      normaliseEvent("b", "issues", payload).triggerKey,
    );
    expect(normaliseEvent("a", "issues", payload).triggerKey).toBe(
      "ikeike443/superset#6:labeled:devin-remediate",
    );
  });
});

function guardDeps(client: ReturnType<typeof vi.fn>) {
  return {
    client: { createRemediationSession: client } as unknown as DevinClient,
    maxAcuLimit: 5,
  };
}

describe("dispatch guard on unfinished runs", () => {
  it("skips dispatch while an unfinished run exists for the issue", async () => {
    const guardStore = new SqliteRunStore({ filename: ":memory:" });
    const client = vi.fn(async () => ({ session_id: "devin-guard" }));
    const deps = guardDeps(client);

    await dispatchToDevin(event(), fakeLogger(), deps, guardStore);
    await dispatchToDevin(event({ deliveryId: "delivery-y" }), fakeLogger(), deps, guardStore);

    expect(client).toHaveBeenCalledTimes(1);
    expect(guardStore.listRuns()).toHaveLength(1);

    guardStore.close();
  });

  it("dispatches again once the previous run reached a terminal status", async () => {
    const guardStore = new SqliteRunStore({ filename: ":memory:" });
    const client = vi.fn(async () => ({ session_id: "devin-guard" }));
    const deps = guardDeps(client);

    await dispatchToDevin(event(), fakeLogger(), deps, guardStore);
    const [run] = guardStore.listRuns();
    guardStore.applySessionUpdate(run.runId, { status: "finished" });

    await dispatchToDevin(event({ deliveryId: "delivery-z" }), fakeLogger(), deps, guardStore);

    expect(client).toHaveBeenCalledTimes(2);

    guardStore.close();
  });

  it("does not let one repository's run block the same issue number elsewhere", async () => {
    const guardStore = new SqliteRunStore({ filename: ":memory:" });
    const client = vi.fn(async () => ({ session_id: "devin-guard" }));
    const deps = guardDeps(client);

    await dispatchToDevin(event({ repository: "orgA/repoA" }), fakeLogger(), deps, guardStore);
    await dispatchToDevin(event({ repository: "orgB/repoB" }), fakeLogger(), deps, guardStore);

    expect(client).toHaveBeenCalledTimes(2);

    guardStore.close();
  });

  it("stops letting an orphaned pending run block the issue once it is stale", async () => {
    let now = new Date("2026-08-01T12:00:00.000Z");
    const guardStore = new SqliteRunStore({ filename: ":memory:", now: () => now });
    const client = vi.fn(async () => ({ session_id: "devin-guard" }));
    const deps = guardDeps(client);

    // A run orphaned in `pending`: nothing will ever advance it.
    guardStore.recordEvent({ issueRef: 900, repository: "ikeike443/superset", triggerType: "webhook" });

    await dispatchToDevin(event(), fakeLogger(), deps, guardStore);
    expect(client).not.toHaveBeenCalled();

    now = new Date(now.getTime() + PENDING_STALE_MS + 1000);
    await dispatchToDevin(event(), fakeLogger(), deps, guardStore);
    expect(client).toHaveBeenCalledTimes(1);

    guardStore.close();
  });
});
