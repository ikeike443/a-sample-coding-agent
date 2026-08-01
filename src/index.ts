import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { SessionPoller, SqliteRunStore } from "./observability/index.js";
import { createDevinClient } from "./webhook/dispatch.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new SqliteRunStore({ filename: config.databasePath });
  const app = buildApp({ store });

  const client = createDevinClient(config);
  const poller = client
    ? new SessionPoller({
        store,
        client,
        logger: app.log,
        intervalMs: config.pollIntervalMs,
      })
    : undefined;

  if (poller) {
    poller.start();
  } else {
    app.log.warn("devin client not configured; session polling disabled");
  }

  const shutdown = async (): Promise<void> => {
    try {
      poller?.stop();
      await app.close();
      store.close();
      process.exit(0);
    } catch (error) {
      console.error(error);
      process.exit(1);
    }
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());

  await app.listen({ port: config.port, host: config.host });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
