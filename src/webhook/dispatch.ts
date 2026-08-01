import type { FastifyBaseLogger } from "fastify";

import type { AppConfig } from "../config.js";
import { DevinClient } from "../devin-client/index.js";
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
 * and GitHub must not be asked to redeliver. Persisting the session id is the
 * observability store's job in a follow-up session.
 */
export async function dispatchToDevin(
  event: NormalisedEvent,
  logger: FastifyBaseLogger,
  deps?: DispatchDeps,
): Promise<void> {
  const context = {
    deliveryId: event.deliveryId,
    event: event.event,
    repository: event.repository,
    issueNumber: event.issueNumber,
  };

  if (!deps) {
    logger.warn(context, "devin client not configured; skipping session creation");
    return;
  }

  const tags = buildTags(event);

  try {
    const session = await deps.client.createSession({
      prompt: buildPrompt(event),
      tags,
      maxAcuLimit: deps.maxAcuLimit,
    });

    logger.info(
      { ...context, sessionId: session.session_id, sessionUrl: session.url, tags },
      "devin session created",
    );
  } catch (error) {
    logger.error({ ...context, err: error, tags }, "devin session creation failed");
  }
}
