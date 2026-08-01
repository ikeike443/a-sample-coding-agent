import type { FastifyInstance } from "fastify";

import { computeMetrics, type RunStore } from "../observability/index.js";

export interface DashboardRouteOptions {
  store: RunStore;
}

/**
 * Dashboard API. `GET /dashboard/metrics` serves the aggregated run metrics;
 * the HTML view consuming them lands in a follow-up session.
 */
export async function registerDashboardRoutes(
  app: FastifyInstance,
  options: DashboardRouteOptions,
): Promise<void> {
  app.get("/metrics", async () => computeMetrics(options.store.listRuns()));
}
