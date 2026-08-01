import Fastify, { type FastifyInstance } from "fastify";

import { loadConfig } from "./config.js";
import { registerDashboardRoutes } from "./dashboard/index.js";
import type { DevinClient } from "./devin-client/index.js";
import { registerWebhookRoutes } from "./webhook/index.js";

export interface BuildAppOptions {
  logLevel?: string;
  /** Injected in tests; built from the configuration otherwise. */
  devinClient?: DevinClient;
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const config = loadConfig();
  const app = Fastify({
    logger: { level: options.logLevel ?? config.logLevel },
    bodyLimit: config.bodyLimitBytes,
  });

  app.get("/health", async () => ({
    status: "ok",
    uptime: process.uptime(),
  }));

  app.register(registerWebhookRoutes, {
    prefix: "/webhook",
    config,
    devinClient: options.devinClient,
  });
  app.register(registerDashboardRoutes, { prefix: "/dashboard" });

  return app;
}
