import type { FastifyInstance, FastifyRequest } from "fastify";

import { loadConfig, type AppConfig } from "../config.js";
import { TtlCache } from "./dedupe.js";
import { dispatchToDevin } from "./dispatch.js";
import { normaliseEvent } from "./normalize.js";
import { SIGNATURE_HEADER, verifySignature } from "./signature.js";

export interface WebhookRouteOptions {
  config?: AppConfig;
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

    if (!event.actionable) {
      return reply.code(200).send({ status: "ignored", reason: event.reason });
    }

    // Respond immediately; the dispatch runs outside the request lifecycle.
    void dispatchToDevin(event, app.log).catch((error: unknown) => {
      app.log.error({ err: error, deliveryId }, "devin dispatch failed");
    });

    return reply.code(200).send({ status: "accepted", deliveryId });
  });
}
