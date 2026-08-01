import { buildApp } from "./app.js";
import { loadConfig, validateConfig } from "./config.js";

/**
 * Aborts the process before the server binds when a required environment
 * variable is missing, so misconfiguration surfaces as a clear startup error
 * instead of a runtime failure later on.
 */
function ensureEnvironment(): void {
  const { missing, warnings } = validateConfig();

  for (const warning of warnings) {
    console.warn(`[config] ${warning}`);
  }

  if (missing.length > 0) {
    console.error(
      `Missing required environment variable(s): ${missing.join(", ")}.\n` +
        "Set them (see .env.example) and restart.",
    );
    process.exit(1);
  }
}

async function main(): Promise<void> {
  ensureEnvironment();

  const config = loadConfig();
  const app = buildApp();

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    app.log.info({ signal }, "shutting down");
    try {
      // Fastify's onClose hooks drain the poller and close the store.
      await app.close();
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, "error during shutdown");
      process.exit(1);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ port: config.port, host: config.host });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
