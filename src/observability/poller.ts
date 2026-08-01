import type { DevinClient, SessionDetail, SessionStatus } from "../devin-client/index.js";
import type { RunStatus, RunStore, SessionUpdate } from "./store.js";

export const DEFAULT_POLL_INTERVAL_MS = 30_000;

export interface PollerLogger {
  info: (details: Record<string, unknown>, message: string) => void;
  warn: (details: Record<string, unknown>, message: string) => void;
  error: (details: Record<string, unknown>, message: string) => void;
}

export interface SessionPollerOptions {
  store: RunStore;
  client: DevinClient;
  logger: PollerLogger;
  intervalMs?: number;
}

/** Maps the Devin session status onto the orchestrator run status. */
export function mapSessionStatus(status: SessionStatus | undefined): RunStatus {
  switch (status) {
    case "exit":
      return "finished";
    case "error":
      return "failed";
    case "suspended":
      return "blocked";
    default:
      return "working";
  }
}

function structuredOutputPrUrl(detail: SessionDetail): string | null {
  const output = detail.structured_output;
  if (!output) {
    return null;
  }

  const candidate = output.pr_url ?? output.pull_request_url;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}

/** Prefers the API's own pull request list, falling back to the structured output. */
export function extractPrUrl(detail: SessionDetail): string | null {
  const fromApi = detail.pull_requests?.find((pr) => typeof pr.pr_url === "string" && pr.pr_url);
  return fromApi?.pr_url ?? structuredOutputPrUrl(detail);
}

export function buildSessionUpdate(detail: SessionDetail): SessionUpdate {
  const status = mapSessionStatus(detail.status);

  return {
    status,
    prUrl: extractPrUrl(detail),
    acuCost: detail.acus_consumed ?? null,
    errorMessage: status === "failed" ? (detail.status_detail ?? "session ended in error") : null,
  };
}

/**
 * Background worker that refreshes `working` / `blocked` runs from the Devin
 * API. PR merge state is out of scope: the Devin API does not report it, so
 * `pr_merged_at` stays null until a GitHub-side integration is added.
 */
export class SessionPoller {
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(private readonly options: SessionPollerOptions) {
    this.intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  start(): void {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      void this.pollOnce();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Polls every active run once; overlapping ticks are skipped. */
  async pollOnce(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;

    try {
      for (const run of this.options.store.listActiveRuns()) {
        if (!run.sessionId) {
          continue;
        }

        try {
          const detail = await this.options.client.getSession(run.sessionId);
          const update = buildSessionUpdate(detail);
          this.options.store.applySessionUpdate(run.runId, update);
          this.options.logger.info(
            {
              runId: run.runId,
              sessionId: run.sessionId,
              status: update.status,
              prUrl: update.prUrl,
            },
            "run status refreshed",
          );
        } catch (error) {
          this.options.logger.error(
            { runId: run.runId, sessionId: run.sessionId, err: error },
            "failed to refresh run status",
          );
        }
      }
    } finally {
      this.running = false;
    }
  }
}
