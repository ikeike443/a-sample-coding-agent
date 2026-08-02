import type { FastifyInstance, FastifyRequest } from "fastify";

import { loadConfig, type AppConfig } from "../config.js";
import type { DevinClient } from "../devin-client/index.js";
import type { RunStore } from "../observability/index.js";
import { TtlCache } from "./dedupe.js";
import { createDevinClient, dispatchToDevin, type DispatchDeps } from "./dispatch.js";
import { normaliseEvent } from "./normalize.js";
import { SIGNATURE_HEADER, verifySignature } from "./signature.js";

export interface WebhookRouteOptions {
  config?: AppConfig;
  /** Injected in tests; built from the configuration otherwise. */
  devinClient?: DevinClient;
  store?: RunStore;
}

const DELIVERY_HEADER = "x-github-delivery";
const EVENT_HEADER = "x-github-event";

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Receives GitHub Issue / Pull Request webhook events, verifies their
 * signature, normalises them and hands the actionable ones to the Devin
 * dispatcher without blocking the response.
 */
export async function registerWebhookRoutes(
  app: FastifyInstance,
  options: WebhookRouteOptions = {},
): Promise<void> {
  const config = options.config ?? loadConfig();
  const deliveries = new TtlCache(config.webhookDedupeTtlMs);
  // Second line of defence: GitHub can send the same logical trigger under
  // several delivery ids (redelivery, retries, `labeled` plus a follow-up
  // edit), which slips past the delivery-id cache and starts a duplicate run.
  const triggers = new TtlCache(config.webhookTriggerIdempotencyTtlMs);
  const client = options.devinClient ?? createDevinClient(config);
  const dispatchDeps: DispatchDeps | undefined = client
    ? { client, maxAcuLimit: config.devinMaxAcuLimit }
    : undefined;

  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (_request, body: Buffer, done) => {
      done(null, body);
    },
  );

  app.post("/github", async (request, reply) => {
    const rawBody = Buffer.isBuffer(request.body) ? request.body : Buffer.from("");
    const signature = header(request, SIGNATURE_HEADER);

    if (!verifySignature(config.githubWebhookSecret, rawBody, signature)) {
      request.log.warn({ signaturePresent: signature !== undefined }, "invalid webhook signature");
      return reply.code(401).send({ error: "invalid_signature" });
    }

    const deliveryId = header(request, DELIVERY_HEADER) ?? "";
    const eventName = header(request, EVENT_HEADER) ?? "unknown";

    if (deliveryId && deliveries.seen(deliveryId)) {
      request.log.info({ deliveryId, event: eventName }, "duplicate delivery skipped");
      return reply.code(200).send({ status: "duplicate", deliveryId });
    }

    let payload: unknown;
    try {
      payload = rawBody.length > 0 ? JSON.parse(rawBody.toString("utf8")) : {};
    } catch {
      return reply.code(400).send({ error: "invalid_json" });
    }

    const event = normaliseEvent(deliveryId, eventName, payload);
    request.log.info(
      {
        deliveryId,
        event: event.event,
        action: event.action,
        repository: event.repository,
        issueNumber: event.issueNumber,
        actionable: event.actionable,
        reason: event.reason,
      },
      "github webhook received",
    );

    if (event.issueClosed && event.issueNumber !== undefined) {
      const closed = options.store?.markIssueClosed(event.issueNumber) ?? [];
      request.log.info(
        { deliveryId, issueNumber: event.issueNumber, runs: closed.map((run) => run.runId) },
        "issue closed; runs closed out",
      );
      return reply
        .code(200)
        .send({ status: "issue_closed", issueNumber: event.issueNumber, runs: closed.length });
    }

    if (event.pullRequestClosed && event.pullRequestUrl !== undefined) {
      const affected =
        options.store?.markPullRequestClosed(event.pullRequestUrl, event.pullRequestMerged) ?? [];
      request.log.info(
        {
          deliveryId,
          prUrl: event.pullRequestUrl,
          merged: event.pullRequestMerged,
          runs: affected.map((run) => run.runId),
        },
        "pull request closed; runs settled",
      );
      return reply.code(200).send({
        status: event.pullRequestMerged ? "pull_request_merged" : "pull_request_rejected",
        prUrl: event.pullRequestUrl,
        runs: affected.length,
      });
    }

    if (!event.actionable) {
      return reply.code(200).send({ status: "ignored", reason: event.reason });
    }

    if (event.triggerKey !== undefined && triggers.seen(event.triggerKey)) {
      request.log.info(
        { deliveryId, event: eventName, triggerKey: event.triggerKey },
        "duplicate trigger skipped",
      );
      return reply
        .code(200)
        .send({ status: "duplicate_trigger", deliveryId, triggerKey: event.triggerKey });
    }

    // Respond immediately; the dispatch runs outside the request lifecycle.
    void dispatchToDevin(event, app.log, dispatchDeps, options.store).catch((error: unknown) => {
      app.log.error({ err: error, deliveryId }, "devin dispatch failed");
    });

    return reply.code(200).send({ status: "accepted", deliveryId });
  });
}
