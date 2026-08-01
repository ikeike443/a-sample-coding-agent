---
name: testing-webhook
description: How to run and exercise the local Fastify orchestrator (a-sample-coding-agent) end-to-end, especially the signed POST /webhook/github intake endpoint.
---

# Testing the local orchestrator / GitHub webhook intake

## Starting the server

```bash
cd /path/to/a-sample-coding-agent
GITHUB_WEBHOOK_SECRET=test-secret LOG_LEVEL=info PORT=3000 \
  setsid nohup npm run dev > /tmp/server.log 2>&1 < /dev/null &
sleep 8 && curl -s localhost:3000/health   # -> {"status":"ok","uptime":...}
```

`npm run dev` is `tsx watch src/index.ts`; logs are pino JSON on stdout, so redirect to a file and `grep` it for assertions
(e.g. `grep 'devin dispatch' /tmp/server.log`, `grep -c '"statusCode":5' /tmp/server.log` to prove no 5xx).

**Gotcha:** do NOT stop the server with `pkill -f "tsx watch"` / `pkill -f "src/index.ts"` from the exec tool — the pattern
matches the `bash -c` wrapper of your own command and kills your shell. Kill by port instead, from a script file:

```bash
pids=$(ss -ltnp | grep ':3000' | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u); [ -n "$pids" ] && kill $pids
```

Server restarts take ~8 s before `/health` answers; config env vars (`GITHUB_WEBHOOK_SECRET`, `WEBHOOK_DEDUPE_TTL_MS`,
`PORT`, `LOG_LEVEL`) are read once at boot, so changing them requires a restart, not just a tsx-watch reload.

## Sending signed webhook requests

The signature is `sha256=` + HMAC-SHA256 of the **exact raw request bytes**, so always sign a file and send it with
`--data-binary @file` (never `-d`, which can mangle whitespace/newlines):

```bash
SIG="sha256=$(openssl dgst -sha256 -hmac "$SECRET" -hex < body.json | awk '{print $NF}')"
curl -s -X POST localhost:3000/webhook/github \
  -H 'Content-Type: application/json' \
  -H 'X-GitHub-Event: issues' \
  -H "X-GitHub-Delivery: $(uuidgen)" \
  -H "X-Hub-Signature-256: $SIG" \
  --data-binary @body.json
```

`Content-Type: application/json` is required: a custom content-type parser hands the raw Buffer to the route, and other
content types leave `request.body` unparsed so the signature check fails with 401 rather than a parse error.

## Behaviour worth asserting

- Actionable = `X-GitHub-Event: issues` + `action=labeled` + label `devin-remediate` (either `label.name` or in
  `issue.labels[]`) -> `200 {"status":"accepted","deliveryId":...}` plus a `devin session created` log line carrying
  `sessionId`/`tags` (or `devin session creation failed` / `devin client not configured; skipping session creation`).
- Bad/missing/tampered signature -> `401 {"error":"invalid_signature"}`; malformed JSON with a valid signature -> `400 {"error":"invalid_json"}`.
- Everything else -> `200 {"status":"ignored","reason":...}` (`unsupported_event`, `event_not_actionable_yet`,
  `action_not_actionable`, `label_not_matched`). Never an error status.
- Dedupe is keyed on `X-GitHub-Delivery` in an in-memory TTL cache: repeat -> `200 {"status":"duplicate"}`. Use
  `WEBHOOK_DEDUPE_TTL_MS=1000` to test expiry in ~1.5 s instead of the 10-minute default. Invalid values
  (non-numeric or <= 0) fall back to the default. The cache is capped (~10k entries) with oldest-first eviction — to test
  it, flood >10k unique delivery ids over a keep-alive `http.Agent` from a small Node script (curl-per-request is too slow),
  then re-send the oldest id (should be `accepted`) and the newest (should be `duplicate`).

## Testing the outbound Devin dispatch without calling the real API

Never point the orchestrator at `https://api.devin.ai`. Stand up a fake HTTP server on another port that appends every
received request (method, url, headers, body, `Date.now()`) to a log file and can be switched between `200` / `500` /
`401` responses via a small `/__control?mode=...&reset=1` endpoint, then boot the server with:

```bash
DEVIN_API_BASE_URL=http://localhost:4010 DEVIN_API_KEY=fake-key-123 DEVIN_ORG_ID=org-fake-1 \
  DEVIN_MAX_ACU_LIMIT=7 DEVIN_MAX_RETRIES=2 DEVIN_RETRY_INITIAL_DELAY_MS=200 ...
```

Use **non-default** ACU/retry values (defaults are 10 / 3 / 1000 ms) so a hard-coded implementation cannot pass, and a
small initial delay so a full retry sequence finishes in <1 s. Expectations:

- One actionable delivery -> exactly one `POST /organizations/<org>/sessions` with `authorization: Bearer <key>`,
  body `{prompt, tags:["remediation","trigger-webhook","issue-<N>"], max_acu_limit}`.
- `500` -> `1 + DEVIN_MAX_RETRIES` upstream requests with gaps roughly doubling from the initial delay (±20% jitter,
  see below); `4xx` -> exactly one.
- Dispatch is fire-and-forget (`void dispatchToDevin(...)`), so the webhook answers `200` **before** retries finish —
  always `sleep` a second or two before counting upstream requests or grepping for the outcome log line.
- Unset `DEVIN_API_KEY`/`DEVIN_ORG_ID` (use `env -u VAR` — they may already be exported in the shell) -> still `200`,
  zero upstream requests, and a `devin client not configured` warning.

## Observability store, poller and `/dashboard/metrics`

Runs are persisted in SQLite (`DATABASE_URL`, default `file:./data/orchestrator.sqlite`, `:memory:` supported) and
aggregated by `GET /dashboard/metrics` (JSON only — there is no HTML dashboard, so "UI" evidence means the JSON in a
browser tab; tick Chrome's *Pretty-print* box, it resets on every reload).

```bash
DATABASE_URL=file:/tmp/obs-test/data/orchestrator.sqlite POLL_INTERVAL_MS=2000 ...   # boot flags
# dump the table (better-sqlite3 is already in node_modules; the sqlite3 CLI may not be installed)
node -e 'const D=require("./node_modules/better-sqlite3");const db=new D(process.argv[1],{readonly:true});
console.log(db.prepare("select run_id,issue_ref,status,session_id,pr_url,acu_cost,error_message from runs").all())' \
  /tmp/obs-test/data/orchestrator.sqlite
```

- Every actionable delivery writes a `pending` row, then `working` (+`session_id`) or `dispatch_failed`
  (`session_id` NULL, `error_message` set) — including when `DEVIN_API_KEY`/`DEVIN_ORG_ID` are unset. Row count is the
  best oracle for "no run was created": bad signature -> 401 and no row; duplicate delivery id -> 200 `duplicate` and no row.
- The poller only starts when Devin credentials are configured (`src/index.ts`), so status transitions can only be
  tested against the fake API. Have the stub's `GET /organizations/{org}/sessions/{id}` return `status:"exit"` plus
  `pull_requests[0].pr_url` and `acus_consumed`; with `POLL_INTERVAL_MS=2000` the row flips to `finished` within ~2 s and
  logs `run status refreshed`. `error` -> `failed`, `suspended` -> `blocked`.
- Metrics are computed over the whole history, so assert deltas: `successRate` counts only `finished` runs **that have a
  pr_url**, `mttrMs` is null until some run has `pr_url_recorded_at`, `throughputLast24h` counts finished runs, and
  `cost.estimated` is true while any run lacks an ACU cost.
- The DB file survives restarts — reuse the same `DATABASE_URL` across reboots to prove persistence, or delete the
  directory to start from the zeroed metrics shape.
- Retry backoff now carries ±20% jitter, so gap assertions must use ranges (200 ms initial -> ~160-240 ms, then ~320-480 ms),
  never exact doubling.

## Known limits to watch for

- `bodyLimit` is set to GitHub's 25 MB maximum (`BODY_LIMIT_BYTES` overrides it, invalid values fall back to the default).
  Payloads above the limit return `413 FST_ERR_CTP_BODY_TOO_LARGE`; if a large-body test unexpectedly 413s, that is this
  limit, not a signature problem.
- Requests without `X-GitHub-Delivery` skip dedupe entirely (delivery id becomes `""`).

## Devin Secrets Needed

None — the webhook secret is arbitrary for local testing (`GITHUB_WEBHOOK_SECRET=test-secret`), and `DEVIN_API_KEY` /
`DEVIN_ORG_ID` should be dummy values pointed at a local fake API (see above). A real `DEVIN_API_KEY` is only needed
for an intentional live smoke test against `https://api.devin.ai/v3`, which costs ACUs and should be avoided by default.
