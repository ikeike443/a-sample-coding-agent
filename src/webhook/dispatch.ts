import type { FastifyBaseLogger } from "fastify";

import type { AppConfig } from "../config.js";
import { DevinClient, type CreateSessionResult } from "../devin-client/index.js";
import type { RunStore } from "../observability/index.js";
import { REMEDIATE_LABEL, type NormalisedEvent } from "./normalize.js";

export interface DispatchDeps {
  client: DevinClient;
  maxAcuLimit: number;
}

/**
 * Builds the Devin client the webhook dispatcher uses, or `undefined` when the
 * Devin credentials are not configured.
 */
export function createDevinClient(config: AppConfig): DevinClient | undefined {
  if (!config.devinApiKey || !config.devinOrgId) {
    return undefined;
  }

  return new DevinClient({
    apiKey: config.devinApiKey,
    orgId: config.devinOrgId,
    baseUrl: config.devinApiBaseUrl,
    maxRetries: config.devinMaxRetries,
    initialRetryDelayMs: config.devinInitialRetryDelayMs,
    requestTimeoutMs: config.devinRequestTimeoutMs,
  });
}

/**
 * Placeholder prompt template; a dedicated prompt design lands in a later
 * session.
 */
export function buildPrompt(event: NormalisedEvent): string {
  const repository = event.repository ?? "unknown repository";
  const issueRef = event.issueNumber === undefined ? "an issue" : `issue #${event.issueNumber}`;
  const labels = event.labels.length > 0 ? event.labels.join(", ") : "none";

  return [
    `Investigate and remediate ${issueRef} in the GitHub repository ${repository}.`,
    `The issue was labelled \`${REMEDIATE_LABEL}\`, which is the signal to work on it.`,
    `Labels on the issue: ${labels}.`,
    "Read the issue description and comments, reproduce the problem, implement a fix and open a pull request that references the issue.",
  ].join("\n");
}

export function buildTags(event: NormalisedEvent): string[] {
  const tags = ["remediation", "trigger-webhook"];

  if (event.issueNumber !== undefined) {
    tags.push(`issue-${event.issueNumber}`);
  }

  return tags;
}

/**
 * Hand-off point between the webhook intake and the Devin client: starts a
 * remediation session for the event.
 *
 * Failures are swallowed on purpose — the webhook has already answered `200`
 * and GitHub must not be asked to redeliver. They are recorded in the
 * observability store as `dispatch_failed` so that a Devin API outage is
 * visible on the dashboard instead of only in the logs.
 */
export async function dispatchToDevin(
  event: NormalisedEvent,
  logger: FastifyBaseLogger,
  deps?: DispatchDeps,
  store?: RunStore,
): Promise<void> {
  const context = {
    deliveryId: event.deliveryId,
    event: event.event,
    repository: event.repository,
    issueNumber: event.issueNumber,
  };
  const tags = buildTags(event);
  const run = store?.recordEvent({
    issueRef: event.issueNumber ?? null,
    triggerType: "webhook",
    tags,
  });

  if (!deps) {
    const reason = "devin client not configured; skipping session creation";
    if (run) {
      store?.markDispatchFailed(run.runId, reason);
    }
    logger.warn({ ...context, runId: run?.runId }, reason);
    return;
  }

  // Only the session creation belongs in the dispatch-failure path: a store or
  // logging error afterwards must not label a running session as never dispatched.
  let session: CreateSessionResult;
  try {
    session = await deps.client.createSession({
      prompt: buildPrompt(event),
      tags,
      maxAcuLimit: deps.maxAcuLimit,
      // A retried POST /sessions must not start a second remediation run.
      idempotent: true,
    });
  } catch (error) {
    if (run) {
      store?.markDispatchFailed(run.runId, errorMessage(error));
    }
    logger.error(
      { ...context, runId: run?.runId, err: error, tags },
      "devin session creation failed",
    );
    return;
  }

  if (run) {
    store?.markWorking(run.runId, session.session_id);
  }

  logger.info(
    {
      ...context,
      runId: run?.runId,
      sessionId: session.session_id,
      sessionUrl: session.url,
      tags,
    },
    "devin session created",
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
