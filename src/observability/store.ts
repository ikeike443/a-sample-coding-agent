import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

import Database from "better-sqlite3";

export type TriggerType = "webhook" | "schedule";

/**
 * Lifecycle of a remediation run.
 *
 * `dispatch_failed` covers failures that happen *before* a session exists (the
 * Devin API rejected or never answered `POST /sessions`), which is what makes a
 * broken dispatch path visible on the dashboard instead of log-only.
 */
export type RunStatus =
  | "pending"
  | "dispatch_failed"
  | "working"
  | "blocked"
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
  acuCost?: number | null;
  errorMessage?: string | null;
  sessionFinishedAt?: string | null;
}

export interface RunStore {
  recordEvent(input: RecordEventInput): RunRecord;
  markDispatchFailed(runId: string, errorMessage: string): RunRecord | undefined;
  markWorking(runId: string, sessionId: string): RunRecord | undefined;
  applySessionUpdate(runId: string, update: SessionUpdate): RunRecord | undefined;
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
  error_message      TEXT
);
CREATE INDEX IF NOT EXISTS runs_status_idx ON runs (status);
CREATE INDEX IF NOT EXISTS runs_detected_at_idx ON runs (detected_at);
`;

/** Statuses the polling worker keeps asking the Devin API about. */
export const ACTIVE_STATUSES: RunStatus[] = ["working", "blocked"];

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
    this.now = options.now ?? (() => new Date());
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
             error_message = NULL
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
    const isTerminal = update.status === "finished" || update.status === "failed";

    this.db
      .prepare(
        `UPDATE runs
         SET status = @status,
             pr_url = @prUrl,
             pr_url_recorded_at = @prUrlRecordedAt,
             acu_cost = @acuCost,
             error_message = @errorMessage,
             session_finished_at = @sessionFinishedAt
         WHERE run_id = @runId`,
      )
      .run({
        runId,
        status: update.status,
        prUrl,
        prUrlRecordedAt:
          current.prUrlRecordedAt ?? (prUrl !== null && prUrl !== undefined ? this.timestamp() : null),
        acuCost: update.acuCost ?? current.acuCost,
        errorMessage: update.errorMessage ?? current.errorMessage,
        sessionFinishedAt:
          update.sessionFinishedAt ??
          current.sessionFinishedAt ??
          (isTerminal ? this.timestamp() : null),
      });

    return this.getRun(runId);
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
