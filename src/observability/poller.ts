import type {
  DevinClient,
  RemediationOutcome,
  SessionDetail,
  SessionStatus,
} from "../devin-client/index.js";
import { parseRemediationOutcome } from "../devin-client/index.js";
import { TERMINAL_STATUSES } from "./store.js";
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
  /**
   * When the store first saw the outcome the session currently reports. It is
   * reset whenever the outcome changes, so it measures how long *this* outcome
   * has been standing — unlike `blockedSince`, which measures the whole stall.
   */
  outcomeReportedAt?: string | null;
  blockedGraceMs?: number;
  now?: Date;
  /** What the store currently holds for the run, used to detect resumption. */
  previousStatus?: RunStatus;
  previousOutcome?: RemediationOutcome | null;
  previousAcuCost?: number | null;
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

function apiPullRequest(detail: SessionDetail) {
  return detail.pull_requests?.find((pr) => typeof pr.pr_url === "string" && pr.pr_url);
}

/** Prefers the API's own pull request list, falling back to the structured output. */
export function extractPrUrl(detail: SessionDetail): string | null {
  return apiPullRequest(detail)?.pr_url ?? structuredOutputPrUrl(detail);
}

/** True once the API reports the session's pull request as merged. */
export function isPrMerged(detail: SessionDetail): boolean {
  return apiPullRequest(detail)?.pr_state === "merged";
}

/** True once the API reports the session's pull request as closed unmerged. */
export function isPrRejected(detail: SessionDetail): boolean {
  return apiPullRequest(detail)?.pr_state === "closed";
}

/**
 * A pull request that is merged or closed can no longer change, so the session
 * has nothing left to do on it.
 */
function prSettled(detail: SessionDetail): boolean {
  const state = apiPullRequest(detail)?.pr_state;
  return state === "merged" || state === "closed";
}

/** Session states in which the session may still do work. */
function sessionIsLive(status: SessionStatus | undefined): boolean {
  return status !== undefined && status !== "exit" && status !== "error";
}

/**
 * Terminal status of a session that reported an outcome. A run whose pull
 * request was closed unmerged did produce work, but the work was discarded, so
 * it settles as `pr_rejected` rather than as a completion.
 */
function statusForOutcome(outcome: RemediationOutcome, detail: SessionDetail): RunStatus {
  if (outcome === "blocked_on_question") {
    return "needs_human_attention";
  }
  return isPrRejected(detail) ? "pr_rejected" : "finished";
}

function olderThanGrace(since: string | null | undefined, now: Date, graceMs: number): boolean {
  if (!since) {
    return false;
  }

  const parsed = Date.parse(since);
  return !Number.isNaN(parsed) && now.getTime() - parsed >= graceMs;
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
  detail: SessionDetail,
  context: SessionUpdateContext,
): RunStatus {
  if (outcome !== null) {
    return statusForOutcome(outcome, detail);
  }

  return olderThanGrace(
    context.blockedSince,
    context.now ?? new Date(),
    context.blockedGraceMs ?? DEFAULT_BLOCKED_GRACE_MS,
  )
    ? "needs_human_attention"
    : "blocked";
}

/**
 * Resolves a session the API still calls `running` even though it already
 * reported a final outcome — which happens whenever the conversation continues
 * (a human replies, or the session keeps its turn open after reporting).
 *
 * Terminating on the outcome alone would be wrong: sessions are asked to update
 * their structured output as they go, so `pr_created` can be reported while the
 * session is still iterating (fixing CI on that very pull request, for
 * instance). Two conservative signals are required instead:
 *
 * - the pull request is merged or closed, so no further work on it is possible
 *   (a closed-unmerged one settling the run as `pr_rejected`);
 * - or the same outcome has been standing for longer than the grace period,
 *   measured from `outcomeReportedAt` (reset whenever the outcome changes, so a
 *   run that stalled earlier is not settled by the first poll that sees a
 *   result).
 *
 * `blocked_on_question` is a human hand-off and escalates immediately, exactly
 * as it does for a blocked session.
 */
function resolveReportedOutcomeStatus(
  outcome: RemediationOutcome,
  detail: SessionDetail,
  context: SessionUpdateContext,
): RunStatus {
  if (outcome === "blocked_on_question") {
    return "needs_human_attention";
  }

  if (prSettled(detail)) {
    return isPrRejected(detail) ? "pr_rejected" : "finished";
  }

  return olderThanGrace(
    context.outcomeReportedAt,
    context.now ?? new Date(),
    context.blockedGraceMs ?? DEFAULT_BLOCKED_GRACE_MS,
  )
    ? statusForOutcome(outcome, detail)
    : "working";
}

/**
 * A run the store had already closed out that is working again, because a human
 * replied to its session or the session resumed on its own.
 *
 * A live session alone does not prove this: sessions routinely stay `running`
 * after the run settled on their reported outcome, and reopening on that would
 * flip the run between `working` and its terminal status forever. Renewed work
 * is required — burnt ACUs or a changed outcome — so the run only reopens when
 * the session actually did something after being closed out.
 */
function hasResumed(
  detail: SessionDetail,
  outcome: RemediationOutcome | null,
  context: SessionUpdateContext,
): boolean {
  if (
    context.previousStatus === undefined ||
    !TERMINAL_STATUSES.includes(context.previousStatus) ||
    !sessionIsLive(detail.status)
  ) {
    return false;
  }

  const previousAcu = context.previousAcuCost;
  const acuGrew =
    typeof previousAcu === "number" &&
    typeof detail.acus_consumed === "number" &&
    detail.acus_consumed > previousAcu;

  return acuGrew || outcome !== (context.previousOutcome ?? null);
}

function resolveStatus(
  detail: SessionDetail,
  outcome: RemediationOutcome | null,
  context: SessionUpdateContext,
): RunStatus {
  const mapped = mapSessionStatus(detail.status);
  const previous = context.previousStatus;
  if (previous !== undefined && TERMINAL_STATUSES.includes(previous)) {
    if (hasResumed(detail, outcome, context)) {
      // The grace clocks restart with the new turn, so a stale outcome cannot
      // re-terminate the run on the very poll that saw it resume.
      return mapped === "blocked" ? "blocked" : "working";
    }

    // Nothing new happened; a session left running does not reopen the run.
    // Its pull request can still be rejected after the fact, though.
    return previous === "finished" && isPrRejected(detail) ? "pr_rejected" : previous;
  }
  if (mapped === "blocked") {
    return resolveBlockedStatus(outcome, detail, context);
  }
  if (mapped === "working" && outcome !== null) {
    return resolveReportedOutcomeStatus(outcome, detail, context);
  }
  if (mapped === "finished" && isPrRejected(detail)) {
    return "pr_rejected";
  }
  return mapped;
}

export function buildSessionUpdate(
  detail: SessionDetail,
  context: SessionUpdateContext = {},
): SessionUpdate {
  const outcome = parseRemediationOutcome(detail.structured_output);
  const status = resolveStatus(detail, outcome, context);

  return {
    status,
    outcome,
    prUrl: extractPrUrl(detail),
    prMerged: isPrMerged(detail),
    prClosed: isPrRejected(detail),
    acuCost: detail.acus_consumed ?? null,
    errorMessage: status === "failed" ? (detail.status_detail ?? "session ended in error") : null,
  };
}

/**
 * Background worker that refreshes the store's active runs — plus recently
 * terminated ones, whose session a human can still resume — from the Devin API.
 * Pull request state comes from the session's `pull_requests[].pr_state`, which
 * is what fills `pr_merged_at` and `pr_closed_at`.
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
      outcomeReportedAt: run.outcomeReportedAt,
      previousStatus: run.status,
      previousOutcome: run.outcome,
      previousAcuCost: run.acuCost,
      blockedGraceMs: this.blockedGraceMs,
      now: this.now(),
    });
  }
}
