import type {
  DevinClient,
  RemediationOutcome,
  SessionDetail,
  SessionStatus,
} from "../devin-client/index.js";
import { parseRemediationOutcome } from "../devin-client/index.js";
import type { RunRecord, RunStatus, RunStore, SessionUpdate } from "./store.js";

export const DEFAULT_POLL_INTERVAL_MS = 30_000;

/**
 * How long a session may stay blocked without a structured output before it is
 * treated as waiting for a human instead of working.
 */
export const DEFAULT_BLOCKED_GRACE_MS = 10 * 60 * 1000;

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
  blockedGraceMs?: number;
  now?: () => Date;
}

export interface SessionUpdateContext {
  /** When the run first went blocked, as recorded by the store. */
  blockedSince?: string | null;
  blockedGraceMs?: number;
  now?: Date;
}

/** Maps the Devin session status onto the orchestrator run status. */
export function mapSessionStatus(status: SessionStatus | undefined): RunStatus {
  switch (status) {
    case "exit":
      return "finished";
    case "error":
      return "failed";
    case "suspended":
    case "blocked":
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

/** Status a blocked session with a reported outcome is really in. */
function statusForOutcome(outcome: RemediationOutcome): RunStatus {
  return outcome === "blocked_on_question" ? "needs_human_attention" : "finished";
}

function blockedTooLong(blockedSince: string | null | undefined, now: Date, graceMs: number): boolean {
  if (!blockedSince) {
    return false;
  }

  const since = Date.parse(blockedSince);
  return !Number.isNaN(since) && now.getTime() - since >= graceMs;
}

/**
 * Resolves a blocked session.
 *
 * A session that already reported its structured output has finished its work
 * even though the API still calls it blocked — `no_action_needed` is a
 * legitimate completion without a pull request, not a stalled run. Without a
 * structured output the run only becomes `needs_human_attention` once it has
 * been blocked for longer than the grace period, since short blocked windows
 * happen while a session is genuinely working.
 */
function resolveBlockedStatus(
  outcome: RemediationOutcome | null,
  context: SessionUpdateContext,
): RunStatus {
  if (outcome !== null) {
    return statusForOutcome(outcome);
  }

  return blockedTooLong(
    context.blockedSince,
    context.now ?? new Date(),
    context.blockedGraceMs ?? DEFAULT_BLOCKED_GRACE_MS,
  )
    ? "needs_human_attention"
    : "blocked";
}

export function buildSessionUpdate(
  detail: SessionDetail,
  context: SessionUpdateContext = {},
): SessionUpdate {
  const outcome = parseRemediationOutcome(detail.structured_output);
  const mapped = mapSessionStatus(detail.status);
  const status = mapped === "blocked" ? resolveBlockedStatus(outcome, context) : mapped;

  return {
    status,
    outcome,
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
  private readonly blockedGraceMs: number;
  private readonly now: () => Date;
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  /** The in-flight poll, tracked so `stop()` can await it before the store closes. */
  private activePoll: Promise<void> | undefined;

  constructor(private readonly options: SessionPollerOptions) {
    this.intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.blockedGraceMs = options.blockedGraceMs ?? DEFAULT_BLOCKED_GRACE_MS;
    this.now = options.now ?? (() => new Date());
  }

  start(): void {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      void this.pollOnce().catch((error: unknown) => {
        this.options.logger.error({ err: error }, "session poll failed");
      });
    }, this.intervalMs);
    this.timer.unref?.();
  }

  /**
   * Stops the interval and waits for any in-flight poll to finish, so a
   * graceful shutdown never tears the store down mid-poll.
   */
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.activePoll;
  }

  /** Polls every active run once; overlapping ticks are skipped. */
  async pollOnce(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    // Track the poll that actually started so `stop()` awaits real in-flight
    // work; skipped (overlapping) ticks return early without touching this.
    // The tracked promise swallows errors so `stop()` drains without rejecting;
    // the error still propagates to the caller below (the timer logs it).
    const poll = this.runPoll();
    const tracked: Promise<void> = poll
      .catch(() => {})
      .finally(() => {
        if (this.activePoll === tracked) {
          this.activePoll = undefined;
        }
      });
    this.activePoll = tracked;
    await poll;
  }

  private async runPoll(): Promise<void> {
    try {
      for (const run of this.options.store.listActiveRuns()) {
        if (!run.sessionId) {
          continue;
        }

        try {
          const detail = await this.options.client.getSession(run.sessionId);
          const update = this.updateFor(run, detail);
          this.options.store.applySessionUpdate(run.runId, update);
          this.options.logger.info(
            {
              runId: run.runId,
              sessionId: run.sessionId,
              status: update.status,
              outcome: update.outcome,
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

  private updateFor(run: RunRecord, detail: SessionDetail): SessionUpdate {
    return buildSessionUpdate(detail, {
      blockedSince: run.blockedSince,
      blockedGraceMs: this.blockedGraceMs,
      now: this.now(),
    });
  }
}
