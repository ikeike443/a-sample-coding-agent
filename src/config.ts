import { DEFAULT_DEDUPE_TTL_MS } from "./webhook/dedupe.js";

export interface AppConfig {
  port: number;
  host: string;
  logLevel: string;
  githubWebhookSecret: string;
  webhookDedupeTtlMs: number;
  bodyLimitBytes: number;
}

/** GitHub delivers webhook payloads of up to 25 MB. */
export const DEFAULT_BODY_LIMIT_BYTES = 25 * 1024 * 1024;

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return value !== undefined && Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: Number(env.PORT ?? 3000),
    host: env.HOST ?? "0.0.0.0",
    logLevel: env.LOG_LEVEL ?? "info",
    githubWebhookSecret: env.GITHUB_WEBHOOK_SECRET ?? "",
    webhookDedupeTtlMs: positiveNumber(env.WEBHOOK_DEDUPE_TTL_MS, DEFAULT_DEDUPE_TTL_MS),
    bodyLimitBytes: positiveNumber(env.BODY_LIMIT_BYTES, DEFAULT_BODY_LIMIT_BYTES),
  };
}
