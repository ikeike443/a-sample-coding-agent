import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { FastifyInstance } from "fastify";

import { computeMetrics, type RunStore } from "../observability/index.js";
import { buildDashboardViewModel } from "./view-model.js";

export interface DashboardRouteOptions {
  store: RunStore;
}

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "public");

const ASSETS: Record<string, { file: string; contentType: string }> = {
  "/": { file: "index.html", contentType: "text/html; charset=utf-8" },
  "/dashboard.css": { file: "dashboard.css", contentType: "text/css; charset=utf-8" },
  "/dashboard.js": { file: "dashboard.js", contentType: "text/javascript; charset=utf-8" },
};

/**
 * Dashboard. `GET /dashboard/metrics` serves the aggregated metrics plus the
 * view model the page renders; `GET /dashboard` serves the page itself, which
 * polls that endpoint.
 */
export async function registerDashboardRoutes(
  app: FastifyInstance,
  options: DashboardRouteOptions,
): Promise<void> {
  app.get("/metrics", async () => {
    const runs = options.store.listRuns();
    const metrics = computeMetrics(runs);
    return { ...metrics, view: buildDashboardViewModel(metrics, runs) };
  });

  for (const [route, asset] of Object.entries(ASSETS)) {
    app.get(route, async (_request, reply) => {
      const body = await readFile(join(PUBLIC_DIR, asset.file), "utf8");
      return reply.type(asset.contentType).send(body);
    });
  }
}
