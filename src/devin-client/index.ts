/**
 * Thin wrapper around the Devin V3 API.
 *
 * Endpoints (relative to `https://api.devin.ai/v3/organizations/{org_id}`):
 * - `POST /sessions`                      create a session
 * - `GET  /sessions/{devin_id}`           session detail
 * - `POST /sessions/{devin_id}/messages`  message an existing session
 */

import {
  REMEDIATION_STRUCTURED_OUTPUT_SCHEMA,
} from "./remediation.js";

export {
  REMEDIATION_OUTCOMES,
  REMEDIATION_STRUCTURED_OUTPUT_SCHEMA,
  isRemediationOutcome,
  parseRemediationOutcome,
  type RemediationOutcome,
} from "./remediation.js";

export const DEFAULT_DEVIN_API_BASE_URL = "https://api.devin.ai/v3";
export const DEFAULT_MAX_RETRIES = 3;
export const DEFAULT_INITIAL_RETRY_DELAY_MS = 1000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** Backoff delays are spread by ±20% so retries of concurrent calls do not align. */
export const RETRY_JITTER_RATIO = 0.2;

/** Upstream error bodies are echoed into logs, so only a prefix is kept. */
const MAX_ERROR_BODY_LENGTH = 500;
const TOO_MANY_REQUESTS = 429;

export type SessionStatus =
  | "new"
  | "claimed"
  | "running"
  | "exit"
  | "error"
  | "suspended"
  | "blocked"
  | "resuming";

export interface SessionPullRequest {
  pr_url: string;
  pr_state: string | null;
}

export interface CreateSessionParams {
  prompt: string;
  tags?: string[];
  playbookId?: string;
  maxAcuLimit?: number;
  structuredOutputSchema?: Record<string, unknown>;
  /** Makes the session end its turn with `provide_structured_output`. */
  structuredOutputRequired?: boolean;
  title?: string;
  idempotent?: boolean;
}

/** `createRemediationSession` owns the structured output contract itself. */
export type CreateRemediationSessionParams = Omit<
  CreateSessionParams,
  "structuredOutputSchema" | "structuredOutputRequired"
>;

export interface CreateSessionResult {
  session_id: string;
  url?: string;
  is_new_session?: boolean;
}

export interface SessionDetail {
  session_id: string;
  status?: SessionStatus;
  status_detail?: string | null;
  url?: string;
  tags?: string[];
  acus_consumed?: number;
  structured_output?: Record<string, unknown> | null;
  pull_requests?: SessionPullRequest[];
}

export interface SendMessageResult {
  session_id?: string;
  status?: SessionStatus;
}

export interface DevinClientOptions {
  apiKey: string;
  orgId: string;
  /** Base URL up to and including `/v3`. */
  baseUrl?: string;
  maxRetries?: number;
  initialRetryDelayMs?: number;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Injected in tests; `Math.random` otherwise. */
  random?: () => number;
}

/** Error raised when the Devin API answers with a non-2xx status. */
export class DevinApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly method: string,
    readonly path: string,
  ) {
    super(`Devin API ${method} ${path} failed with status ${status}: ${body}`);
    this.name = "DevinApiError";
  }

  /** 4xx responses are caller mistakes; rate limiting is the exception. */
  get retryable(): boolean {
    return this.status >= 500 || this.status === TOO_MANY_REQUESTS;
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Exponential backoff with full ±`RETRY_JITTER_RATIO` jitter: without it every
 * client retrying a failing Devin API hits it again at the same instant.
 */
export function backoffDelay(
  initialDelayMs: number,
  attempt: number,
  random: () => number = Math.random,
): number {
  const base = initialDelayMs * 2 ** attempt;
  return Math.round(base * (1 + (random() * 2 - 1) * RETRY_JITTER_RATIO));
}

function isRetryable(error: unknown): boolean {
  return error instanceof DevinApiError ? error.retryable : true;
}

export class DevinClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(private readonly options: DevinClientOptions) {
    if (!options.apiKey) {
      throw new Error("DevinClient requires an apiKey (DEVIN_API_KEY)");
    }
    if (!options.orgId) {
      throw new Error("DevinClient requires an orgId (DEVIN_ORG_ID)");
    }

    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
  }

  /** Organisation-scoped base URL, e.g. `https://api.devin.ai/v3/organizations/org-x`. */
  get baseUrl(): string {
    const root = (this.options.baseUrl ?? DEFAULT_DEVIN_API_BASE_URL).replace(/\/+$/, "");
    return `${root}/organizations/${this.options.orgId}`;
  }

  async createSession(params: CreateSessionParams): Promise<CreateSessionResult> {
    return this.request<CreateSessionResult>("POST", "/sessions", {
      prompt: params.prompt,
      tags: params.tags,
      playbook_id: params.playbookId,
      max_acu_limit: params.maxAcuLimit,
      structured_output_schema: params.structuredOutputSchema,
      structured_output_required: params.structuredOutputRequired,
      title: params.title,
      idempotent: params.idempotent,
    });
  }

  /**
   * Creates a remediation session. The structured output is always required so
   * the session explicitly ends its turn — including when it concludes that no
   * change is needed and would otherwise idle as `blocked`.
   */
  async createRemediationSession(
    params: CreateRemediationSessionParams,
  ): Promise<CreateSessionResult> {
    return this.createSession({
      ...params,
      structuredOutputSchema: REMEDIATION_STRUCTURED_OUTPUT_SCHEMA,
      structuredOutputRequired: true,
    });
  }

  async getSession(sessionId: string): Promise<SessionDetail> {
    return this.request<SessionDetail>("GET", `/sessions/${encodeURIComponent(sessionId)}`);
  }

  async sendMessage(sessionId: string, message: string): Promise<SendMessageResult> {
    return this.request<SendMessageResult>(
      "POST",
      `/sessions/${encodeURIComponent(sessionId)}/messages`,
      { message },
    );
  }

  /**
   * Performs the HTTP call, retrying network failures, 5xx responses and 429
   * with a jittered exponential backoff. Other 4xx responses are surfaced
   * immediately.
   */
  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const maxRetries = this.options.maxRetries ?? DEFAULT_MAX_RETRIES;
    const initialDelay = this.options.initialRetryDelayMs ?? DEFAULT_INITIAL_RETRY_DELAY_MS;
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        return await this.send<T>(method, path, body);
      } catch (error) {
        lastError = error;

        if (!isRetryable(error) || attempt === maxRetries) {
          throw error;
        }

        await this.sleep(backoffDelay(initialDelay, attempt, this.random));
      }
    }

    throw lastError;
  }

  private async send<T>(method: string, path: string, body?: Record<string, unknown>): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      signal: AbortSignal.timeout(this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(stripUndefined(body)),
    });

    if (!response.ok) {
      throw new DevinApiError(response.status, await errorBody(response), method, path);
    }

    return (await safeJson(response)) as T;
  }
}

function stripUndefined(body: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined));
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

async function errorBody(response: Response): Promise<string> {
  return (await safeText(response)).slice(0, MAX_ERROR_BODY_LENGTH);
}

async function safeJson(response: Response): Promise<unknown> {
  const text = await safeText(response);
  if (text.length === 0) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
