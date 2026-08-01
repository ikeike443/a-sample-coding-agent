import { describe, expect, it, vi } from "vitest";

import { DevinApiError, DevinClient } from "../src/devin-client/index.js";

const API_KEY = "test-api-key";
const ORG_ID = "org-test";
const BASE_URL = "https://api.devin.test/v3";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface ClientHarness {
  client: DevinClient;
  fetchImpl: ReturnType<typeof vi.fn>;
  delays: number[];
}

function harness(responses: Array<Response | Error>, maxRetries = 3): ClientHarness {
  const queue = [...responses];
  const fetchImpl = vi.fn(async () => {
    const next = queue.shift();
    if (next === undefined) {
      throw new Error("unexpected extra fetch call");
    }
    if (next instanceof Error) {
      throw next;
    }
    return next;
  });
  const delays: number[] = [];

  const client = new DevinClient({
    apiKey: API_KEY,
    orgId: ORG_ID,
    baseUrl: BASE_URL,
    maxRetries,
    initialRetryDelayMs: 1000,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    sleep: async (ms: number) => {
      delays.push(ms);
    },
  });

  return { client, fetchImpl, delays };
}

function callArgs(fetchImpl: ReturnType<typeof vi.fn>, index = 0): [string, RequestInit] {
  return fetchImpl.mock.calls[index] as unknown as [string, RequestInit];
}

describe("DevinClient.createSession", () => {
  it("posts the session payload and returns the created session", async () => {
    const { client, fetchImpl } = harness([
      jsonResponse(200, { session_id: "devin-1", url: "https://app.devin.ai/sessions/1" }),
    ]);

    const result = await client.createSession({
      prompt: "fix issue #42",
      tags: ["remediation", "issue-42"],
      playbookId: "playbook-1",
      maxAcuLimit: 7,
      structuredOutputSchema: { type: "object" },
    });

    expect(result).toMatchObject({ session_id: "devin-1" });

    const [url, init] = callArgs(fetchImpl);
    expect(url).toBe(`${BASE_URL}/organizations/${ORG_ID}/sessions`);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${API_KEY}`);
    expect(JSON.parse(init.body as string)).toEqual({
      prompt: "fix issue #42",
      tags: ["remediation", "issue-42"],
      playbook_id: "playbook-1",
      max_acu_limit: 7,
      structured_output_schema: { type: "object" },
    });
  });

  it("omits optional fields that were not provided", async () => {
    const { client, fetchImpl } = harness([jsonResponse(200, { session_id: "devin-1" })]);

    await client.createSession({ prompt: "hello" });

    expect(JSON.parse(callArgs(fetchImpl)[1].body as string)).toEqual({ prompt: "hello" });
  });
});

describe("DevinClient.getSession", () => {
  it("returns the session detail", async () => {
    const detail = {
      session_id: "devin-1",
      status: "exit",
      structured_output: { pr_url: "https://github.com/o/r/pull/1" },
      pull_requests: [{ pr_url: "https://github.com/o/r/pull/1", pr_state: "open" }],
    };
    const { client, fetchImpl } = harness([jsonResponse(200, detail)]);

    await expect(client.getSession("devin-1")).resolves.toEqual(detail);

    const [url, init] = callArgs(fetchImpl);
    expect(url).toBe(`${BASE_URL}/organizations/${ORG_ID}/sessions/devin-1`);
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
  });
});

describe("DevinClient.sendMessage", () => {
  it("posts the message to the session", async () => {
    const { client, fetchImpl } = harness([
      jsonResponse(200, { session_id: "devin-1", status: "running" }),
    ]);

    await expect(client.sendMessage("devin-1", "any update?")).resolves.toMatchObject({
      status: "running",
    });

    const [url, init] = callArgs(fetchImpl);
    expect(url).toBe(`${BASE_URL}/organizations/${ORG_ID}/sessions/devin-1/messages`);
    expect(JSON.parse(init.body as string)).toEqual({ message: "any update?" });
  });
});

describe("DevinClient retries", () => {
  it("retries 5xx responses with an exponential backoff and succeeds", async () => {
    const { client, fetchImpl, delays } = harness([
      jsonResponse(503, { error: "unavailable" }),
      jsonResponse(500, { error: "boom" }),
      jsonResponse(200, { session_id: "devin-1" }),
    ]);

    await expect(client.createSession({ prompt: "hi" })).resolves.toMatchObject({
      session_id: "devin-1",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([1000, 2000]);
  });

  it("stops after the configured number of retries", async () => {
    const { client, fetchImpl, delays } = harness([
      jsonResponse(500, { error: "boom" }),
      jsonResponse(500, { error: "boom" }),
      jsonResponse(500, { error: "boom" }),
      jsonResponse(500, { error: "boom" }),
    ]);

    await expect(client.createSession({ prompt: "hi" })).rejects.toBeInstanceOf(DevinApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(delays).toEqual([1000, 2000, 4000]);
  });

  it("retries network errors", async () => {
    const { client, fetchImpl } = harness([
      new TypeError("fetch failed"),
      jsonResponse(200, { session_id: "devin-1" }),
    ]);

    await expect(client.getSession("devin-1")).resolves.toMatchObject({ session_id: "devin-1" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not retry 4xx responses", async () => {
    const { client, fetchImpl, delays } = harness([jsonResponse(401, { error: "unauthorized" })]);

    await expect(client.createSession({ prompt: "hi" })).rejects.toMatchObject({
      name: "DevinApiError",
      status: 401,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it("does not retry validation errors", async () => {
    const { client, fetchImpl } = harness([jsonResponse(422, { detail: "invalid" })]);

    await expect(client.sendMessage("devin-1", "hi")).rejects.toMatchObject({ status: 422 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("DevinClient construction", () => {
  it("requires credentials", () => {
    expect(() => new DevinClient({ apiKey: "", orgId: ORG_ID })).toThrow(/apiKey/);
    expect(() => new DevinClient({ apiKey: API_KEY, orgId: "" })).toThrow(/orgId/);
  });

  it("scopes the base url to the organisation", () => {
    const client = new DevinClient({ apiKey: API_KEY, orgId: ORG_ID });
    expect(client.baseUrl).toBe(`https://api.devin.ai/v3/organizations/${ORG_ID}`);
  });
});
