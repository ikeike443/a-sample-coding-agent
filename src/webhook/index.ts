import type { FastifyInstance } from "fastify";

/**
 * Receives GitHub Issue / Pull Request webhook events and turns them into
 * orchestrator jobs.
 *
 * Planned for a follow-up session:
 * - HMAC signature verification with GITHUB_WEBHOOK_SECRET
 * - event parsing/normalisation (issues, issue_comment, pull_request, ...)
 * - dispatching normalised events to the Devin client
 */
export async function registerWebhookRoutes(app: FastifyInstance): Promise<void> {
  app.post("/github", async (_request, reply) => {
    return reply.code(501).send({ error: "not_implemented" });
  });
}
