---
name: testing-dashboard
description: How to bring up the orchestrator dashboard (http://localhost:3000/dashboard) with realistic data — seeded demo runs plus real runs — and how to assert on its rendering.
---

# Testing the dashboard UI

Node v22 is required for `better-sqlite3`: `export PATH=~/.nvm/versions/node/v22.12.0/bin:$PATH`.

## Bring up a dashboard with data

Use a **throwaway** database so real/seeded data from other sessions does not interfere:

```bash
rm -f data/demo.sqlite data/demo.sqlite-wal data/demo.sqlite-shm   # the store runs in WAL mode
DATABASE_URL=file:./data/demo.sqlite npm run seed          # ~37 backdated fake runs, run ids `seed-*`, issues #900xxx
GITHUB_WEBHOOK_SECRET=test-secret DATABASE_URL=file:./data/demo.sqlite LOG_LEVEL=info PORT=3000 \
  setsid nohup npm run dev > /tmp/server.log 2>&1 < /dev/null &
sleep 12 && curl -s localhost:3000/health
```

**Gotcha:** a dev server started by another session may already own port 3000 with a *different* `DATABASE_URL`, so
the dashboard will not show your data. Always check `ss -ltnp | grep ':3000'` and the served payload
(`curl -s localhost:3000/dashboard/metrics`) before concluding anything. Kill an old server by port from a script
file (never `pkill -f 'tsx watch'` inline — the pattern matches your own shell wrapper):

```bash
pids=$(ss -ltnp | grep ':3000' | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u); [ -n "$pids" ] && kill $pids
```

## Adding a *real* (non-seeded) run for comparison

The dashboard treats any run whose `run_id` starts with `seed-` as demo data (`isDemoRun()` in
`src/dashboard/view-model.ts`). To get a normal row, insert one with any other run id; give it the newest
`detected_at` so it sorts to the top of "Recent runs":

```bash
node -e "const D=require('better-sqlite3');const db=new D('./data/demo.sqlite');const t=new Date().toISOString();
db.prepare(\"INSERT OR REPLACE INTO runs (run_id,issue_ref,trigger_type,session_id,tags,detected_at,session_started_at,session_finished_at,status,pr_url,pr_url_recorded_at,acu_cost,outcome,outcome_reported_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)\")
 .run('run-real-001',4242,'issue_labeled','devin-real-session-001','[]',t,t,t,'finished','https://github.com/ikeike443/a-sample-coding-agent/pull/17',t,1.5,'remediated',t);"
```

## Asserting on the UI

- The page polls `/dashboard/metrics` every 5 s and re-renders from scratch, so **any row written to the DB shows up
  within ~5 s without reloading**. This is the strongest test for render-path changes: insert a row live and watch it
  appear already styled correctly, which proves the logic runs on every refresh and not just first paint.
- Verifying "this text is not a link" from the UI: hover it — a real `<a>` puts its target URL in the Chrome status
  bar bottom-left, an inert `<span>` shows nothing — then click it and confirm the URL bar and tab count are unchanged.
  Screen recordings hide the mouse cursor, so `cursor: default` cannot be proven from pixels; use the hover/click
  evidence instead.
- Handy sanity check of the server-side view model without the browser:
  `curl -s localhost:3000/dashboard/metrics | python3 -c "import sys,json;[print(r['runId'],r['issueLabel'],r['isDemo']) for r in json.load(sys.stdin)['view']['recentRuns']]"`
- **"Recent runs" is capped at 20 rows** (`RECENT_RUNS_LIMIT` in `src/dashboard/view-model.ts`), sorted by
  `detected_at` desc. Seeded runs are backdated over ~7 days, so a rare seeded scenario (e.g. the single
  `pr_rejected` run) is often counted in the summary cards yet **not rendered in the table at all**. Do not
  conclude the row rendering is broken — check the DB
  (`node -e "...SELECT run_id,status,detected_at FROM runs WHERE status='<status>'..."`) and prove row/badge
  rendering with a freshly created run instead, which sorts to the top.
- Summary-card arithmetic is the cheapest way to prove a status is excluded from success: read the Success
  rate card's detail line ("N of M run(s) resolved (…)") before and after the state change. A status that is
  correctly excluded raises M without raising N, so the percentage drops.

## End-to-end: webhook → poller → dashboard row, with no Devin credentials

The most convincing dashboard test drives a *real* run through the whole pipeline instead of inserting rows.
Point the orchestrator at a local fake Devin API (see the `testing-webhook` skill) whose session state lives in
a JSON file you can edit live, then:

```bash
# 1. boot with a short poll interval so state changes land in seconds
GITHUB_WEBHOOK_SECRET=test-secret DATABASE_URL=file:./data/demo.sqlite POLL_INTERVAL_MS=3000 \
  BLOCKED_GRACE_MS=1000 DEVIN_API_KEY=fake-key DEVIN_ORG_ID=org-test \
  DEVIN_API_BASE_URL=http://localhost:4010/v3 setsid nohup npm run dev > /tmp/server.log 2>&1 < /dev/null &
# 2. signed issues.labeled delivery -> {"status":"accepted"} and a session id from the fake API
# 3. edit the fake session: acus_consumed, structured_output.outcome, pull_requests[0].pr_url/pr_state
#    -> within ~2 poll intervals the row shows the PR link and settles (BLOCKED_GRACE_MS=1000 keeps it quick)
# 4. send further signed deliveries (e.g. pull_request.closed) and watch the row change without reloading
```

`BLOCKED_GRACE_MS` is what makes step 3 fast: with the default grace the poller refuses to settle a reported
outcome for minutes, which looks like a broken feature if you only wait a few seconds.

## Devin Secrets Needed

None — everything runs locally against SQLite.
