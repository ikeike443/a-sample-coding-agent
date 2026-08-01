import Fastify, { type FastifyInstance } from "fastify";

import { loadConfig, type AppConfig } from "./config.js";
import { registerDashboardRoutes } from "./dashboard/index.js";
import type { DevinClient } from "./devin-client/index.js";
import { SessionPoller, SqliteRunStore, type RunStore } from "./observability/index.js";
import { createDevinClient } from "./webhook/dispatch.js";
import { registerWebhookRoutes } from "./webhook/index.js";

export interface BuildAppOptions {
  logLevel?: string;
  /** Injected in tests; loaded from the environment otherwise. */
  config?: AppConfig;
  /** Injected in tests; built from the configuration otherwise. */
  devinClient?: DevinClient;
  /** Injected by tests; opened from the configuration otherwise. */
  store?: RunStore;
}

/**
 * Builds the fully wired Fastify application: the health check, the webhook and
 * dashboard routes, and the observability polling worker. The poller starts
 * automatically once the server is ready and is stopped, together with the
 * store, when the server closes — so shutting the app down (e.g. from a
 * SIGTERM handler) drains any in-flight poll before the process exits.
 */
export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const config = options.config ?? loadConfig();
  const app = Fastify({
    logger: { level: options.logLevel ?? config.logLevel },
    bodyLimit: config.bodyLimitBytes,
  });

  app.get("/health", async () => ({
    status: "ok",
    uptime: process.uptime(),
  }));

  const store = options.store ?? new SqliteRunStore({ filename: config.databasePath });
  const ownsStore = !options.store;

  // A single Devin client is shared by the webhook dispatcher and the poller;
  // it is undefined when the Devin credentials are not configured, in which
  // case the webhook still runs and the poller is disabled.
  const devinClient = options.devinClient ?? createDevinClient(config);
  const poller = devinClient
    ? new SessionPoller({
        store,
        client: devinClient,
        logger: app.log,
        intervalMs: config.pollIntervalMs,
      })
    : undefined;

  if (poller) {
    app.addHook("onReady", async () => {
      poller.start();
      app.log.info({ intervalMs: config.pollIntervalMs }, "session poller started");
    });
  } else {
    app.addHook("onReady", async () => {
      app.log.warn("devin client not configured; session polling disabled");
    });
  }

  app.addHook("onClose", async () => {
    await poller?.stop();
    if (ownsStore) {
      store.close();
    }
  });

  app.register(registerWebhookRoutes, {
    prefix: "/webhook",
    config,
    devinClient,
    store,
  });
  app.register(registerDashboardRoutes, { prefix: "/dashboard", store });

  return app;
}
