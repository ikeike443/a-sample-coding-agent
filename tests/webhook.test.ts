import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { DEFAULT_BLOCKED_GRACE_MS } from "../src/observability/index.js";
import { DEFAULT_DEDUPE_TTL_MS, TtlCache } from "../src/webhook/dedupe.js";
import { computeSignature } from "../src/webhook/signature.js";

const SECRET = "test-webhook-secret";

process.env.GITHUB_WEBHOOK_SECRET = SECRET;

const app = buildApp({ logLevel: "silent" });

beforeAll(async () => {
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

interface PostOptions {
  event?: string;
  deliveryId?: string;
  signature?: string | null;
  payload?: unknown;
}

let deliveryCounter = 0;

function post(options: PostOptions = {}) {
  const payload = JSON.stringify(options.payload ?? issuesLabeledPayload());
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-github-event": options.event ?? "issues",
    "x-github-delivery": options.deliveryId ?? `delivery-${++deliveryCounter}`,
  };

  if (options.signature !== null) {
    headers["x-hub-signature-256"] = options.signature ?? computeSignature(SECRET, payload);
  }

  return app.inject({ method: "POST", url: "/webhook/github", headers, payload });
}

// A distinct issue per actionable delivery: the intake is idempotent per
// (repository, issue, label), so reusing one issue makes the next one a
// duplicate trigger.
function issuesLabeledPayload(label = "devin-remediate", issueNumber = 42) {
  return {
    action: "labeled",
    label: { name: label },
    repository: { full_name: "ikeike443/a-sample-coding-agent" },
    issue: { number: issueNumber, labels: [{ name: label }] },
  };
}

describe("POST /webhook/github signature verification", () => {
  it("accepts a request with a valid signature", async () => {
    const response = await post();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "accepted" });
  });

  it("rejects a request with an invalid signature", async () => {
    const response = await post({ signature: "sha256=deadbeef" });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: "invalid_signature" });
  });

  it("rejects a request whose signature was computed with another secret", async () => {
    const payload = JSON.stringify(issuesLabeledPayload());
    const response = await post({ signature: computeSignature("wrong-secret", payload) });

    expect(response.statusCode).toBe(401);
  });

  it("rejects a request without the signature header", async () => {
    const response = await post({ signature: null });

    expect(response.statusCode).toBe(401);
  });
});

describe("POST /webhook/github event normalisation", () => {
  it("treats issues/labeled with the devin-remediate label as actionable", async () => {
    const response = await post({ payload: issuesLabeledPayload("devin-remediate", 101) });

    expect(response.json()).toMatchObject({ status: "accepted" });
  });

  it("ignores issues events carrying a different label", async () => {
    const response = await post({ payload: issuesLabeledPayload("bug") });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "ignored", reason: "label_not_matched" });
  });

  it("ignores issues events with a non-labeled action", async () => {
    const response = await post({
      payload: { ...issuesLabeledPayload(), action: "opened" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "ignored", reason: "action_not_actionable" });
  });

  it("closes out the runs of an issue GitHub reports as closed", async () => {
    const response = await post({
      payload: {
        action: "closed",
        repository: { full_name: "ikeike443/a-sample-coding-agent" },
        issue: { number: 42, labels: [] },
      },
    });

    expect(response.statusCode).toBe(200);
    // The number of affected runs depends on the shared store's history; the
    // closure itself is covered by tests/observability-store.test.ts.
    expect(response.json()).toMatchObject({ status: "issue_closed", issueNumber: 42 });
  });

  it("acknowledges supported but not-yet-actionable events", async () => {
    const response = await post({
      event: "issue_comment",
      payload: {
        action: "created",
        repository: { full_name: "ikeike443/a-sample-coding-agent" },
        issue: { number: 7, labels: [] },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "ignored",
      reason: "event_not_actionable_yet",
    });
  });

  it("acknowledges unsupported events with 200", async () => {
    const response = await post({ event: "push", payload: { ref: "refs/heads/main" } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "ignored", reason: "unsupported_event" });
  });
});

describe("POST /webhook/github deduplication", () => {
  it("skips a redelivery with the same delivery id", async () => {
    const deliveryId = "duplicate-delivery-id";

    const payload = issuesLabeledPayload("devin-remediate", 102);
    const first = await post({ deliveryId, payload });
    const second = await post({ deliveryId, payload });

    expect(first.json()).toMatchObject({ status: "accepted" });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ status: "duplicate", deliveryId });
  });

  it("processes distinct delivery ids for distinct triggers", async () => {
    const first = await post({
      deliveryId: "delivery-a",
      payload: issuesLabeledPayload("devin-remediate", 103),
    });
    const second = await post({
      deliveryId: "delivery-b",
      payload: issuesLabeledPayload("devin-remediate", 104),
    });

    expect(first.json()).toMatchObject({ status: "accepted" });
    expect(second.json()).toMatchObject({ status: "accepted" });
  });

  it("skips a redelivery of the same trigger under a different delivery id", async () => {
    const payload = issuesLabeledPayload("devin-remediate", 105);

    const first = await post({ deliveryId: "delivery-105-a", payload });
    const second = await post({ deliveryId: "delivery-105-b", payload });

    expect(first.json()).toMatchObject({ status: "accepted" });
    expect(second.json()).toMatchObject({ status: "duplicate_trigger" });
  });
});

describe("TtlCache", () => {
  it("forgets entries once the TTL has elapsed", () => {
    let now = 0;
    const cache = new TtlCache(1000, () => now);

    expect(cache.seen("id")).toBe(false);
    expect(cache.seen("id")).toBe(true);

    now = 1500;
    expect(cache.seen("id")).toBe(false);
    expect(cache.size).toBe(1);
  });

  it("evicts the oldest entries once the maximum size is reached", () => {
    const cache = new TtlCache(60_000, () => 0, 2);

    cache.seen("a");
    cache.seen("b");
    cache.seen("c");

    expect(cache.size).toBe(2);
    expect(cache.seen("a")).toBe(false);
    expect(cache.seen("c")).toBe(true);
  });
});

describe("loadConfig", () => {
  it("falls back to the default TTL for a malformed WEBHOOK_DEDUPE_TTL_MS", () => {
    for (const value of ["10m", "", "-1", "0"]) {
      expect(loadConfig({ WEBHOOK_DEDUPE_TTL_MS: value }).webhookDedupeTtlMs).toBe(
        DEFAULT_DEDUPE_TTL_MS,
      );
    }

    expect(loadConfig({ WEBHOOK_DEDUPE_TTL_MS: "1000" }).webhookDedupeTtlMs).toBe(1000);
  });

  it("reads BLOCKED_GRACE_MS, allowing 0 and rejecting malformed values", () => {
    expect(loadConfig({}).blockedGraceMs).toBe(DEFAULT_BLOCKED_GRACE_MS);
    expect(loadConfig({ BLOCKED_GRACE_MS: "60000" }).blockedGraceMs).toBe(60_000);
    expect(loadConfig({ BLOCKED_GRACE_MS: "0" }).blockedGraceMs).toBe(0);

    for (const value of ["10m", "", "-1"]) {
      expect(loadConfig({ BLOCKED_GRACE_MS: value }).blockedGraceMs).toBe(
        DEFAULT_BLOCKED_GRACE_MS,
      );
    }
  });
});
