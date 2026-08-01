import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Keeps stores built from the configuration off the filesystem.
    env: { DATABASE_URL: ":memory:" },
  },
});
