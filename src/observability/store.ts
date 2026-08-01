import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

import Database from "better-sqlite3";

import type { RemediationOutcome } from "../devin-client/remediation.js";
import { isRemediationOutcome } from "../devin-client/remediation.js";

export type TriggerType = "webhook" | "schedule";

/**
 * Lifecycle of a remediation run.
 *
 * `dispatch_failed` covers failures that happen *before* a session exists (the
 * Devin API rejected or never answered `POST /sessions`), which is what makes a
 * broken dispatch path visible on the dashboard instead of log-only.
 *
 * `needs_human_attention` is a session that has been `blocked` past the grace
 * period without ever reporting a structured output, i.e. one that is most
 * likely waiting on a human rather than still working.
 */
export type RunStatus =
  | "pending"
  | "dispatch_failed"
  | "working"
  | "blocked"
  | "needs_human_attention"
  | "finished"
  | "failed";

export interface RunRecord {
  runId: string;
  issueRef: number | null;
  triggerType: TriggerType;
  sessionId: string | null;
  tags: string[];
  detectedAt: string;
  sessionStartedAt: string | null;
  sessionFinishedAt: string | null;
  status: RunStatus;
  prUrl: string | null;
  prUrlRecordedAt: string | null;
  prMergedAt: string | null;
  acuCost: number | null;
  errorMessage: string | null;
  /** Outcome reported by the session's structured output, if any. */
  outcome: RemediationOutcome | null;
  /** When the current `outcome` was first observed; reset whenever it changes. */
  outcomeReportedAt: string | null;
  /** When the run first entered a blocked state; cleared once it leaves it. */
  blockedSince: string | null;
  /** When the GitHub issue behind the run was observed closed. */
  issueClosedAt: string | null;
}

export interface RecordEventInput {
  issueRef?: number | null;
  triggerType: TriggerType;
  tags?: string[];
  runId?: string;
  detectedAt?: string;
}

export interface SessionUpdate {
  status: RunStatus;
  prUrl?: string | null;
  /** The Devin API reports the run's pull request as merged. */
  prMerged?: boolean;
  acuCost?: number | null;
  errorMessage?: string | null;
  sessionFinishedAt?: string | null;
  outcome?: RemediationOutcome | null;
}

export interface RunStore {
  recordEvent(input: RecordEventInput): RunRecord;
  markDispatchFailed(runId: string, errorMessage: string): RunRecord | undefined;
  markWorking(runId: string, sessionId: string): RunRecord | undefined;
  applySessionUpdate(runId: string, update: SessionUpdate): RunRecord | undefined;
  markIssueClosed(issueRef: number): RunRecord[];
  getRun(runId: string): RunRecord | undefined;
  listRuns(): RunRecord[];
  listActiveRuns(): RunRecord[];
  close(): void;
}

interface RunRow {
  run_id: string;
  issue_ref: number | null;
  trigger_type: string;
  session_id: string | null;
  tags: string;
  detected_at: string;
  session_started_at: string | null;
  session_finished_at: string | null;
  status: string;
  pr_url: string | null;
  pr_url_recorded_at: string | null;
  pr_merged_at: string | null;
  acu_cost: number | null;
  error_message: string | null;
  outcome: string | null;
  outcome_reported_at: string | null;
  blocked_since: string | null;
  issue_closed_at: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  run_id             TEXT PRIMARY KEY,
  issue_ref          INTEGER,
  trigger_type       TEXT NOT NULL,
  session_id         TEXT,
  tags               TEXT NOT NULL DEFAULT '[]',
  detected_at        TEXT NOT NULL,
  session_started_at TEXT,
  session_finished_at TEXT,
  status             TEXT NOT NULL,
  pr_url             TEXT,
  pr_url_recorded_at TEXT,
  pr_merged_at       TEXT,
  acu_cost           REAL,
  error_message      TEXT,
  outcome            TEXT,
  outcome_reported_at TEXT,
  blocked_since      TEXT,
  issue_closed_at    TEXT
);
CREATE INDEX IF NOT EXISTS runs_status_idx ON runs (status);
CREATE INDEX IF NOT EXISTS runs_detected_at_idx ON runs (detected_at);
`;

/**
 * Statuses the polling worker keeps asking the Devin API about.
 * `needs_human_attention` stays in the list: a human may answer the session and
 * it then has to be able to reach a terminal status.
 */
export const ACTIVE_STATUSES: RunStatus[] = ["working", "blocked", "needs_human_attention"];

/** Statuses in which a run counts as waiting rather than progressing. */
const BLOCKED_STATUSES: RunStatus[] = ["blocked", "needs_human_attention"];


function toRecord(row: RunRow): RunRecord {
  return {
    runId: row.run_id,
    issueRef: row.issue_ref,
    triggerType: row.trigger_type as TriggerType,
    sessionId: row.session_id,
    tags: parseTags(row.tags),
    detectedAt: row.detected_at,
    sessionStartedAt: row.session_started_at,
    sessionFinishedAt: row.session_finished_at,
    status: row.status as RunStatus,
    prUrl: row.pr_url,
    prUrlRecordedAt: row.pr_url_recorded_at,
    prMergedAt: row.pr_merged_at,
    acuCost: row.acu_cost,
    errorMessage: row.error_message,
    outcome: isRemediationOutcome(row.outcome) ? row.outcome : null,
    outcomeReportedAt: row.outcome_reported_at,
    blockedSince: row.blocked_since,
    issueClosedAt: row.issue_closed_at,
  };
}

function parseTags(tags: string): string[] {
  try {
    const parsed: unknown = JSON.parse(tags);
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === "string") : [];
  } catch {
    return [];
  }
}

export interface SqliteRunStoreOptions {
  /** File path, or `:memory:` for tests. */
  filename?: string;
  now?: () => Date;
}

/** SQLite-backed persistence of orchestrator runs. */
export class SqliteRunStore implements RunStore {
  private readonly db: Database.Database;
  private readonly now: () => Date;

  constructor(options: SqliteRunStoreOptions = {}) {
    const filename = options.filename ?? ":memory:";
    if (filename !== ":memory:") {
      mkdirSync(dirname(filename), { recursive: true });
    }

    this.db = new Database(filename);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
    this.migrate();
    this.now = options.now ?? (() => new Date());
  }

  /** Adds columns introduced after the first release to pre-existing databases. */
  private migrate(): void {
    const columns = new Set(
      (this.db.prepare(`PRAGMA table_info(runs)`).all() as { name: string }[]).map(
        (column) => column.name,
      ),
    );

    for (const column of [
      "outcome",
      "outcome_reported_at",
      "blocked_since",
      "issue_closed_at",
      "pr_merged_at",
    ]) {
      if (!columns.has(column)) {
        this.db.exec(`ALTER TABLE runs ADD COLUMN ${column} TEXT`);
      }
    }
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  recordEvent(input: RecordEventInput): RunRecord {
    const record: RunRecord = {
      runId: input.runId ?? randomUUID(),
      issueRef: input.issueRef ?? null,
      triggerType: input.triggerType,
      sessionId: null,
      tags: input.tags ?? [],
      detectedAt: input.detectedAt ?? this.timestamp(),
      sessionStartedAt: null,
      sessionFinishedAt: null,
      status: "pending",
      prUrl: null,
      prUrlRecordedAt: null,
      prMergedAt: null,
      acuCost: null,
      errorMessage: null,
      outcome: null,
      outcomeReportedAt: null,
      blockedSince: null,
      issueClosedAt: null,
    };

    this.db
      .prepare(
        `INSERT INTO runs (run_id, issue_ref, trigger_type, tags, detected_at, status)
         VALUES (@runId, @issueRef, @triggerType, @tags, @detectedAt, @status)`,
      )
      .run({
        runId: record.runId,
        issueRef: record.issueRef,
        triggerType: record.triggerType,
        tags: JSON.stringify(record.tags),
        detectedAt: record.detectedAt,
        status: record.status,
      });

    return record;
  }

  markDispatchFailed(runId: string, errorMessage: string): RunRecord | undefined {
    this.db
      .prepare(
        `UPDATE runs SET status = 'dispatch_failed', error_message = @errorMessage
         WHERE run_id = @runId`,
      )
      .run({ runId, errorMessage });

    return this.getRun(runId);
  }

  markWorking(runId: string, sessionId: string): RunRecord | undefined {
    this.db
      .prepare(
        `UPDATE runs
         SET status = 'working', session_id = @sessionId, session_started_at = @startedAt,
             error_message = NULL, blocked_since = NULL, outcome_reported_at = NULL
         WHERE run_id = @runId`,
      )
      .run({ runId, sessionId, startedAt: this.timestamp() });

    return this.getRun(runId);
  }

  /** Applies a status transition observed by the polling worker. */
  applySessionUpdate(runId: string, update: SessionUpdate): RunRecord | undefined {
    const current = this.getRun(runId);
    if (!current) {
      return undefined;
    }

    const prUrl = update.prUrl ?? current.prUrl;
    const outcome = update.outcome ?? current.outcome;
    const isTerminal = update.status === "finished" || update.status === "failed";
    const isBlocked = BLOCKED_STATUSES.includes(update.status);

    this.db
      .prepare(
        `UPDATE runs
         SET status = @status,
             pr_url = @prUrl,
             pr_url_recorded_at = @prUrlRecordedAt,
             pr_merged_at = @prMergedAt,
             acu_cost = @acuCost,
             error_message = @errorMessage,
             session_finished_at = @sessionFinishedAt,
             outcome = @outcome,
             outcome_reported_at = @outcomeReportedAt,
             blocked_since = @blockedSince
         WHERE run_id = @runId`,
      )
      .run({
        runId,
        status: update.status,
        prUrl,
        outcome,
        // Restarted whenever the reported outcome changes, so it measures how
        // long *this* outcome has been standing rather than the whole run.
        outcomeReportedAt:
          outcome === null
            ? null
            : outcome === current.outcome
              ? (current.outcomeReportedAt ?? this.timestamp())
              : this.timestamp(),
        // The blocked clock starts at the first blocked poll and survives
        // subsequent blocked polls, so the grace period measures the whole stall.
        blockedSince: isBlocked ? (current.blockedSince ?? this.timestamp()) : null,
        prUrlRecordedAt:
          current.prUrlRecordedAt ?? (prUrl !== null && prUrl !== undefined ? this.timestamp() : null),
        // First observation wins: the merge happened before this poll saw it.
        prMergedAt: current.prMergedAt ?? (update.prMerged === true ? this.timestamp() : null),
        acuCost: update.acuCost ?? current.acuCost,
        errorMessage: update.errorMessage ?? current.errorMessage,
        sessionFinishedAt:
          update.sessionFinishedAt ??
          current.sessionFinishedAt ??
          (isTerminal ? this.timestamp() : null),
      });

    return this.getRun(runId);
  }

  /**
   * Closes out the runs for an issue GitHub reports as closed. A closed issue
   * has been dealt with — by Devin, by a human, or by being dismissed — so an
   * active run for it has nothing left to wait for, even when it never produced
   * a pull request. Terminal runs are left untouched; only `issue_closed_at` is
   * recorded for them.
   */
  markIssueClosed(issueRef: number): RunRecord[] {
    const closedAt = this.timestamp();
    const placeholders = ACTIVE_STATUSES.map(() => "?").join(", ");
    const runIds = (
      this.db
        .prepare(`SELECT run_id FROM runs WHERE issue_ref = ?`)
        .all(issueRef) as { run_id: string }[]
    ).map((row) => row.run_id);

    this.db
      .prepare(
        `UPDATE runs
         SET issue_closed_at = COALESCE(issue_closed_at, ?),
             status = CASE WHEN status IN (${placeholders}) THEN 'finished' ELSE status END,
             session_finished_at = CASE
               WHEN status IN (${placeholders}) THEN COALESCE(session_finished_at, ?)
               ELSE session_finished_at END,
             blocked_since = CASE WHEN status IN (${placeholders}) THEN NULL ELSE blocked_since END
         WHERE issue_ref = ?`,
      )
      .run(
        closedAt,
        ...ACTIVE_STATUSES,
        ...ACTIVE_STATUSES,
        closedAt,
        ...ACTIVE_STATUSES,
        issueRef,
      );

    return runIds
      .map((runId) => this.getRun(runId))
      .filter((run): run is RunRecord => run !== undefined);
  }

  getRun(runId: string): RunRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM runs WHERE run_id = ?`).get(runId) as
      | RunRow
      | undefined;
    return row ? toRecord(row) : undefined;
  }

  listRuns(): RunRecord[] {
    // `rowid` breaks ties so runs recorded in the same millisecond keep a
    // stable, insertion-ordered sequence (the dashboard relies on this).
    const rows = this.db
      .prepare(`SELECT * FROM runs ORDER BY detected_at ASC, rowid ASC`)
      .all() as RunRow[];
    return rows.map(toRecord);
  }

  listActiveRuns(): RunRecord[] {
    const placeholders = ACTIVE_STATUSES.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT * FROM runs
         WHERE status IN (${placeholders}) AND session_id IS NOT NULL
         ORDER BY detected_at ASC`,
      )
      .all(...ACTIVE_STATUSES) as RunRow[];
    return rows.map(toRecord);
  }

  close(): void {
    this.db.close();
  }
}
