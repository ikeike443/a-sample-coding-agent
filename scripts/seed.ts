/**
 * Seeds the dashboard with fake runs spread over the last N days (7 by default),
 * so the summary cards, the recent-runs table and the 7-day success-rate trend
 * all have realistic data to render on a fresh database.
 *
 * The data is inserted through the real `SqliteRunStore` API rather than raw
 * SQL: every run flows through `recordEvent -> markWorking -> applySessionUpdate`
 * (or `markDispatchFailed` / `markIssueClosed`), so the derived timestamps
 * (`blocked_since`, `pr_url_recorded_at`, `outcome_reported_at`, ...) stay
 * internally consistent with production. Time is backdated by handing the store
 * a mutable clock that this script advances per event.
 *
 * Usage:
 *   npm run seed                 # 7 days into ./data/orchestrator.sqlite (or $DATABASE_URL)
 *   SEED_DAYS=14 npm run seed    # a different window
 *   SEED_SEED=42 npm run seed    # a different but reproducible dataset
 *
 * Re-running is safe: rows previously inserted by this script (run ids prefixed
 * `seed-`) are removed first, and real runs are never touched.
 */
import Database from "better-sqlite3";

import { databasePathFromUrl, DEFAULT_DATABASE_URL } from "../src/config.js";
import { SEED_RUN_PREFIX } from "../src/dashboard/view-model.js";
import { SqliteRunStore, type TriggerType } from "../src/observability/index.js";
import type { RemediationOutcome } from "../src/devin-client/remediation.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;


/**
 * Issue numbers for seeded runs start well above any real GitHub issue number so
 * the `issue_closed` scenario (which finishes every run sharing an `issue_ref`,
 * see `SqliteRunStore.markIssueClosed`) can only ever touch its own seeded row —
 * never a genuine run in the target database.
 */
const SEED_ISSUE_BASE = 900_000;

/** Deterministic PRNG so a given `SEED_SEED` always produces the same dataset. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Scenario =
  | "remediated"
  | "remediated_merged"
  | "no_action_needed"
  | "issue_closed"
  | "needs_human_attention"
  | "dispatch_failed"
  | "failed"
  | "working"
  | "blocked";

interface GeneratedRun {
  runId: string;
  issueRef: number;
  triggerType: TriggerType;
  sessionId: string;
  detectedAt: Date;
  /** When the session finishes / stalls; clamped so it never lands in the future. */
  finishedAt: Date;
  scenario: Scenario;
  acuCost: number;
}

/**
 * Scenario weights per day, oldest day first. Earlier days lean healthier and
 * fully terminal; the most recent day keeps some runs in-flight so the table
 * and the "needs human attention" card have live-looking entries.
 */
const TERMINAL_SCENARIOS: { scenario: Scenario; weight: number }[] = [
  { scenario: "remediated", weight: 5 },
  { scenario: "remediated_merged", weight: 4 },
  { scenario: "no_action_needed", weight: 3 },
  { scenario: "issue_closed", weight: 2 },
  { scenario: "needs_human_attention", weight: 2 },
  { scenario: "failed", weight: 2 },
  { scenario: "dispatch_failed", weight: 1 },
];

const TODAY_EXTRA_SCENARIOS: { scenario: Scenario; weight: number }[] = [
  { scenario: "working", weight: 3 },
  { scenario: "blocked", weight: 2 },
];

function pickWeighted<T>(items: { scenario: T; weight: number }[], rand: () => number): T {
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  let threshold = rand() * total;
  for (const item of items) {
    threshold -= item.weight;
    if (threshold < 0) {
      return item.scenario;
    }
  }
  return items[items.length - 1]!.scenario;
}

function intBetween(rand: () => number, min: number, max: number): number {
  return Math.floor(rand() * (max - min + 1)) + min;
}

function generateRuns(days: number, now: Date, rand: () => number): GeneratedRun[] {
  const runs: GeneratedRun[] = [];
  let issueRef = SEED_ISSUE_BASE;
  let sessionSeq = 1;
  // A few minutes before "now", so no seeded timestamp is in the future.
  const cutoffMs = now.getTime() - 5 * MINUTE_MS;

  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const isToday = offset === 0;
    // Anchor to the UTC midnight of the target day: the dashboard buckets runs
    // by the UTC date prefix of `detectedAt`, so a detection generated for this
    // day has to stay within its own calendar day to land in the right bucket.
    const target = new Date(now.getTime() - offset * DAY_MS);
    const dayStartMs = Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), target.getUTCDate());
    // The current day is only partly elapsed; past days span the whole 24h.
    const maxMinuteOfDay = isToday
      ? Math.max(1, Math.floor((cutoffMs - dayStartMs) / MINUTE_MS))
      : 24 * 60 - 1;
    const runsThisDay = intBetween(rand, 3, 7);

    for (let i = 0; i < runsThisDay; i += 1) {
      const detectedMs = dayStartMs + intBetween(rand, 0, maxMinuteOfDay) * MINUTE_MS;
      const durationMin = intBetween(rand, 4, 55);
      const finishedMs = Math.min(detectedMs + durationMin * MINUTE_MS, cutoffMs);

      const scenarioPool =
        isToday && rand() < 0.5 ? TODAY_EXTRA_SCENARIOS : TERMINAL_SCENARIOS;
      const scenario = pickWeighted(scenarioPool, rand);

      runs.push({
        runId: `${SEED_RUN_PREFIX}${offset}-${i}`,
        issueRef: (issueRef += intBetween(rand, 1, 3)),
        triggerType: rand() < 0.8 ? "webhook" : "schedule",
        sessionId: `devin-seed-${sessionSeq++}`,
        detectedAt: new Date(detectedMs),
        finishedAt: new Date(finishedMs),
        scenario,
        acuCost: Number((rand() * 7 + 0.5).toFixed(2)),
      });
    }
  }

  return runs;
}

const OUTCOME_BY_SCENARIO: Partial<Record<Scenario, RemediationOutcome>> = {
  remediated: "pr_created",
  remediated_merged: "pr_created",
  no_action_needed: "no_action_needed",
  needs_human_attention: "blocked_on_question",
  blocked: "blocked_on_question",
};

function applyScenario(store: SqliteRunStore, run: GeneratedRun, setClock: (at: Date) => void): void {
  const detectedAt = run.detectedAt;
  const startedAt = new Date(detectedAt.getTime() + 10 * 1000);
  const finishedAt = run.finishedAt;

  setClock(detectedAt);
  store.recordEvent({
    runId: run.runId,
    issueRef: run.issueRef,
    triggerType: run.triggerType,
    detectedAt: detectedAt.toISOString(),
    tags: run.triggerType === "webhook" ? ["devin-remediate"] : ["scheduled"],
  });

  if (run.scenario === "dispatch_failed") {
    setClock(startedAt);
    store.markDispatchFailed(run.runId, "Devin API rejected POST /sessions (seeded)");
    return;
  }

  setClock(startedAt);
  store.markWorking(run.runId, run.sessionId);

  const outcome = OUTCOME_BY_SCENARIO[run.scenario] ?? null;
  const prUrl =
    run.scenario === "remediated" || run.scenario === "remediated_merged"
      ? `https://github.com/ikeike443/a-sample-coding-agent/pull/${run.issueRef}`
      : null;

  switch (run.scenario) {
    case "working":
      // Left in-flight: no further transition.
      return;

    case "blocked":
      setClock(finishedAt);
      store.applySessionUpdate(run.runId, { status: "blocked", outcome });
      return;

    case "needs_human_attention":
      setClock(finishedAt);
      store.applySessionUpdate(run.runId, { status: "needs_human_attention", outcome });
      return;

    case "failed":
      setClock(finishedAt);
      store.applySessionUpdate(run.runId, {
        status: "failed",
        errorMessage: "Session ended in error (seeded)",
        acuCost: run.acuCost,
        sessionFinishedAt: finishedAt.toISOString(),
      });
      return;

    case "issue_closed":
      // Resolved by the issue closing while the run was still working.
      setClock(finishedAt);
      store.markIssueClosed(run.issueRef);
      return;

    case "remediated":
    case "remediated_merged":
    case "no_action_needed":
      setClock(finishedAt);
      store.applySessionUpdate(run.runId, {
        status: "finished",
        outcome,
        prUrl,
        prMerged: run.scenario === "remediated_merged",
        acuCost: run.acuCost,
        sessionFinishedAt: finishedAt.toISOString(),
      });
      return;

    default:
      return;
  }
}

function main(): void {
  const days = Number(process.env.SEED_DAYS ?? 7);
  const seed = Number(process.env.SEED_SEED ?? 1);
  const databasePath = databasePathFromUrl(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);

  if (!Number.isInteger(days) || days < 1) {
    throw new Error(`SEED_DAYS must be a positive integer, got ${process.env.SEED_DAYS}`);
  }

  const now = new Date();
  const rand = mulberry32(seed);
  const runs = generateRuns(days, now, rand);

  let clock = now;
  const store = new SqliteRunStore({ filename: databasePath, now: () => clock });

  // Remove anything a previous run of this script inserted; never touch real runs.
  const cleaner = new Database(databasePath);
  const { changes } = cleaner
    .prepare(`DELETE FROM runs WHERE run_id LIKE ?`)
    .run(`${SEED_RUN_PREFIX}%`);
  cleaner.close();

  for (const run of runs) {
    applyScenario(store, run, (at) => {
      clock = at;
    });
  }

  store.close();

  const byScenario = runs.reduce<Record<string, number>>((acc, run) => {
    acc[run.scenario] = (acc[run.scenario] ?? 0) + 1;
    return acc;
  }, {});

  console.log(`Seeded ${runs.length} run(s) across ${days} day(s) into ${databasePath}`);
  if (changes > 0) {
    console.log(`Replaced ${changes} previously seeded run(s).`);
  }
  console.log("Breakdown:", byScenario);
}

main();
