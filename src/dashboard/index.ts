import type { FastifyInstance } from "fastify";

import { emptyMetrics } from "../observability/index.js";

/**
 * Dashboard UI showing orchestrator activity and metrics.
 *
 * Planned for a follow-up session:
 * - HTML/SPA view of sessions, events and metrics
 * - JSON API consumed by the UI
 */
export async function registerDashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get("/metrics", async () => emptyMetrics());
}
