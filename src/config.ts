import {
  DEFAULT_DEVIN_API_BASE_URL,
  DEFAULT_INITIAL_RETRY_DELAY_MS,
  DEFAULT_MAX_RETRIES,
  DEFAULT_REQUEST_TIMEOUT_MS,
} from "./devin-client/index.js";
import { DEFAULT_POLL_INTERVAL_MS } from "./observability/index.js";
import { DEFAULT_DEDUPE_TTL_MS } from "./webhook/dedupe.js";

export interface AppConfig {
  port: number;
  host: string;
  logLevel: string;
  githubWebhookSecret: string;
  webhookDedupeTtlMs: number;
  bodyLimitBytes: number;
  devinApiKey: string;
  devinOrgId: string;
  devinApiBaseUrl: string;
  devinMaxAcuLimit: number;
  devinMaxRetries: number;
  devinInitialRetryDelayMs: number;
  devinRequestTimeoutMs: number;
  databasePath: string;
  pollIntervalMs: number;
}

/** GitHub delivers webhook payloads of up to 25 MB. */
export const DEFAULT_BODY_LIMIT_BYTES = 25 * 1024 * 1024;

/** Cap for a single remediation session, overridable via `DEVIN_MAX_ACU_LIMIT`. */
export const DEFAULT_MAX_ACU_LIMIT = 10;

export const DEFAULT_DATABASE_URL = "file:./data/orchestrator.sqlite";

/** `DATABASE_URL` accepts both `file:/path/db.sqlite` and a bare path. */
export function databasePathFromUrl(url: string): string {
  return url.startsWith("file:") ? url.slice("file:".length) : url;
}

function boundedNumber(value: string | undefined, fallback: number, minimum: number): number {
  const parsed = Number(value);
  return value !== undefined && Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
}

function positiveNumber(value: string | undefined, fallback: number): number {
  return boundedNumber(value, fallback, Number.MIN_VALUE);
}

/** `DEVIN_MAX_RETRIES=0` is a valid way to ask for a single attempt. */
function nonNegativeNumber(value: string | undefined, fallback: number): number {
  return boundedNumber(value, fallback, 0);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: Number(env.PORT ?? 3000),
    host: env.HOST ?? "0.0.0.0",
    logLevel: env.LOG_LEVEL ?? "info",
    githubWebhookSecret: env.GITHUB_WEBHOOK_SECRET ?? "",
    webhookDedupeTtlMs: positiveNumber(env.WEBHOOK_DEDUPE_TTL_MS, DEFAULT_DEDUPE_TTL_MS),
    bodyLimitBytes: positiveNumber(env.BODY_LIMIT_BYTES, DEFAULT_BODY_LIMIT_BYTES),
    devinApiKey: env.DEVIN_API_KEY ?? "",
    devinOrgId: env.DEVIN_ORG_ID ?? "",
    devinApiBaseUrl: env.DEVIN_API_BASE_URL ?? DEFAULT_DEVIN_API_BASE_URL,
    devinMaxAcuLimit: positiveNumber(env.DEVIN_MAX_ACU_LIMIT, DEFAULT_MAX_ACU_LIMIT),
    devinMaxRetries: nonNegativeNumber(env.DEVIN_MAX_RETRIES, DEFAULT_MAX_RETRIES),
    devinInitialRetryDelayMs: positiveNumber(
      env.DEVIN_RETRY_INITIAL_DELAY_MS,
      DEFAULT_INITIAL_RETRY_DELAY_MS,
    ),
    devinRequestTimeoutMs: positiveNumber(env.DEVIN_REQUEST_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS),
    databasePath: databasePathFromUrl(env.DATABASE_URL ?? DEFAULT_DATABASE_URL),
    pollIntervalMs: positiveNumber(env.POLL_INTERVAL_MS, DEFAULT_POLL_INTERVAL_MS),
  };
}
