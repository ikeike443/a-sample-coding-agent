import type { FastifyBaseLogger } from "fastify";

import type { NormalisedEvent } from "./normalize.js";

/**
 * Hand-off point between the webhook intake and the Devin client.
 *
 * TODO(session-3): start a Devin session for the event via `src/devin-client`
 * and record the resulting session in the observability store. Until then the
 * event is only logged.
 */
export async function dispatchToDevin(
  event: NormalisedEvent,
  logger: FastifyBaseLogger,
): Promise<void> {
  logger.info(
    {
      deliveryId: event.deliveryId,
      event: event.event,
      repository: event.repository,
      issueNumber: event.issueNumber,
    },
    "webhook event queued for devin dispatch (stub)",
  );
}
