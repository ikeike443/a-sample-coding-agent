import type { FastifyBaseLogger } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { DEFAULT_MAX_ACU_LIMIT, loadConfig } from "../src/config.js";
import { DevinApiError, type DevinClient } from "../src/devin-client/index.js";
import { buildPrompt, buildTags, dispatchToDevin } from "../src/webhook/dispatch.js";
import type { NormalisedEvent } from "../src/webhook/normalize.js";
import { computeSignature } from "../src/webhook/signature.js";

const SECRET = "test-webhook-secret";
const ACU_LIMIT = 5;

process.env.GITHUB_WEBHOOK_SECRET = SECRET;
process.env.DEVIN_MAX_ACU_LIMIT = String(ACU_LIMIT);

function event(overrides: Partial<NormalisedEvent> = {}): NormalisedEvent {
  return {
    deliveryId: "delivery-1",
    event: "issues",
    action: "labeled",
    repository: "ikeike443/a-sample-coding-agent",
    issueNumber: 42,
    labels: ["devin-remediate"],
    actionable: true,
    reason: "actionable",
    ...overrides,
  };
}

function fakeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as FastifyBaseLogger & {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
}

function fakeClient(createSession: ReturnType<typeof vi.fn>): DevinClient {
  return { createSession } as unknown as DevinClient;
}

describe("prompt and tags", () => {
  it("mentions the issue and repository in the prompt", () => {
    const prompt = buildPrompt(event());

    expect(prompt).toContain("issue #42");
    expect(prompt).toContain("ikeike443/a-sample-coding-agent");
    expect(prompt).toContain("devin-remediate");
  });

  it("tags the session with the issue number and the trigger", () => {
    expect(buildTags(event())).toEqual(["remediation", "trigger-webhook", "issue-42"]);
    expect(buildTags(event({ issueNumber: undefined }))).toEqual([
      "remediation",
      "trigger-webhook",
    ]);
  });
});

describe("dispatchToDevin", () => {
  it("creates a session with the prompt, tags and ACU limit, and logs the session id", async () => {
    const createSession = vi.fn(async () => ({ session_id: "devin-1", url: "https://x" }));
    const logger = fakeLogger();

    await dispatchToDevin(event(), logger, {
      client: fakeClient(createSession),
      maxAcuLimit: ACU_LIMIT,
    });

    expect(createSession).toHaveBeenCalledTimes(1);
    expect(createSession.mock.calls[0]?.[0]).toMatchObject({
      tags: ["remediation", "trigger-webhook", "issue-42"],
      maxAcuLimit: ACU_LIMIT,
      idempotent: true,
    });
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "devin-1" }),
      "devin session created",
    );
  });

  it("logs and swallows a final Devin API failure", async () => {
    const error = new DevinApiError(500, "boom", "POST", "/sessions");
    const createSession = vi.fn(async () => {
      throw error;
    });
    const logger = fakeLogger();

    await expect(
      dispatchToDevin(event(), logger, { client: fakeClient(createSession), maxAcuLimit: 1 }),
    ).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: error }),
      "devin session creation failed",
    );
  });

  it("skips dispatch when the Devin client is not configured", async () => {
    const logger = fakeLogger();

    await dispatchToDevin(event(), logger, undefined);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryId: "delivery-1" }),
      "devin client not configured; skipping session creation",
    );
  });
});

describe("config", () => {
  it("falls back to the default ACU limit", () => {
    expect(loadConfig({}).devinMaxAcuLimit).toBe(DEFAULT_MAX_ACU_LIMIT);
    expect(loadConfig({ DEVIN_MAX_ACU_LIMIT: "25" }).devinMaxAcuLimit).toBe(25);
    expect(loadConfig({ DEVIN_MAX_ACU_LIMIT: "not-a-number" }).devinMaxAcuLimit).toBe(
      DEFAULT_MAX_ACU_LIMIT,
    );
  });

  it("honours DEVIN_MAX_RETRIES=0 as 'no retries'", () => {
    expect(loadConfig({ DEVIN_MAX_RETRIES: "0" }).devinMaxRetries).toBe(0);
    expect(loadConfig({ DEVIN_MAX_RETRIES: "-1" }).devinMaxRetries).toBe(3);
  });
});

describe("POST /webhook/github -> devin client", () => {
  let resolveCall: () => void = () => {};
  const called = new Promise<void>((resolve) => {
    resolveCall = resolve;
  });
  const createSession = vi.fn(async () => {
    resolveCall();
    return { session_id: "devin-from-webhook" };
  });
  const app = buildApp({ logLevel: "silent", devinClient: fakeClient(createSession) });

  beforeAll(async () => {
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

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

  const actionablePayload = {
    action: "labeled",
    label: { name: "devin-remediate" },
    repository: { full_name: "ikeike443/a-sample-coding-agent" },
    issue: { number: 42, labels: [{ name: "devin-remediate" }] },
  };

  it("creates a Devin session for an actionable delivery", async () => {
    const response = await post(actionablePayload, "webhook-dispatch-1");
    expect(response.statusCode).toBe(200);

    await called;

    expect(createSession).toHaveBeenCalledTimes(1);
    const params = createSession.mock.calls[0]?.[0] as {
      prompt: string;
      tags: string[];
      maxAcuLimit: number;
    };
    expect(params.tags).toEqual(["remediation", "trigger-webhook", "issue-42"]);
    expect(params.maxAcuLimit).toBe(ACU_LIMIT);
    expect(params.prompt).toContain("issue #42");
  });

  it("still answers 200 when the Devin API call fails", async () => {
    createSession.mockRejectedValueOnce(new DevinApiError(500, "boom", "POST", "/sessions"));

    const response = await post(actionablePayload, "webhook-dispatch-2");

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "accepted" });
  });
});
