# devin-orchestrator

An event-driven automation orchestrator built on top of the Devin API. It receives GitHub Issue and
Pull Request events via webhooks, decides which Devin sessions to start, tracks those sessions, and
stores their outcomes (success rate, latency, cost) so they can be visualised on a dashboard.

The HTTP server, directory layout, Docker setup, test harness and CI pipeline are in place, and the
GitHub webhook intake, the Devin V3 API client and the observability layer (SQLite store, polling
worker, metrics API) are implemented. The dashboard UI is filled in during a follow-up session.

## GitHub webhook intake

`POST /webhook/github` performs the following steps:

1. **Signature verification** — the raw request body (kept as a `Buffer` by a custom
   `application/json` content type parser) is HMAC-SHA256 signed with `GITHUB_WEBHOOK_SECRET` using
   Node's `node:crypto` and compared against `X-Hub-Signature-256` in constant time. A missing or
   mismatching signature yields `401`.
2. **Deduplication** — `X-GitHub-Delivery` is looked up in an in-memory TTL cache
   (`WEBHOOK_DEDUPE_TTL_MS`, 10 minutes by default). A redelivery inside the window returns `200`
   without further processing. Persisting delivery ids is left to the observability store.
3. **Normalisation** — `X-GitHub-Event` selects the handler for `issues`, `issue_comment` and
   `pull_request`. Only `issues` deliveries with `action: labeled` and the `devin-remediate` label
   are actionable; every other delivery is logged and acknowledged with `200` so GitHub does not
   see an error.
4. **Dispatch** — actionable events are passed to `dispatchToDevin()` in `src/webhook/dispatch.ts`
   without awaiting it, so the handler responds immediately. It builds a prompt from the issue and
   repository, creates a Devin session tagged
   `["remediation", "trigger-webhook", "issue-<number>"]` with `max_acu_limit` taken from
   `DEVIN_MAX_ACU_LIMIT`, and logs the resulting `session_id`. Every actionable delivery is recorded
   in the observability store as `pending` before the call, then moved to `working` with the
   `session_id`, or to `dispatch_failed` with the error message if the Devin API call fails after
   all retries. The webhook has already answered `200` so GitHub does not redeliver; the failure is
   visible on `GET /dashboard/metrics` instead of in the logs only.

## Technology choices

### HTTP framework: Fastify

- **Performance**: webhook traffic arrives in bursts, and Fastify's low-overhead routing and JSON
  serialisation handle that better than Express.
- **TypeScript first**: type definitions ship with the framework, so there is no separate
  `@types/*` package to drift out of sync and everything compiles under `strict`.
- **Plugin encapsulation**: `register()` gives each component its own scope and prefix, which maps
  cleanly onto the webhook / dashboard split this project grows into.
- **Testability**: `app.inject()` exercises routes at the HTTP level without binding a port.
- **Webhook signature verification**: raw-body access via `addContentTypeParser` / `onRequest` hooks
  is built in, which is what HMAC verification of GitHub deliveries needs.

### Test framework: Vitest

- **Native TypeScript / ESM**: runs ESM + TS sources directly, with no `ts-jest` or Babel layer.
- **Fast**: esbuild-based transforms and parallel workers keep CI runs short.
- **Jest-compatible API**: `describe` / `it` / `expect` work as usual, so there is nothing new to
  learn and migrating to Jest later would be straightforward.
- **Minimal configuration**: a single `vitest.config.ts`, no extra transformer wiring.

## Running locally

### Docker Compose (recommended)

```bash
cp .env.example .env   # optional today; Compose starts without it
docker compose up --build
curl http://localhost:3000/health   # => {"status":"ok","uptime":...}
```

The `orchestrator-data` volume is mounted at `/app/data` for SQLite persistence.

### Node.js directly

```bash
npm ci
npm run dev      # development server via tsx watch
npm test         # Vitest
npm run lint     # ESLint
npm run build && npm start
```

## Endpoints (current state)

| Method | Path                 | Status                                    |
| ------ | -------------------- | ----------------------------------------- |
| GET    | `/health`            | Implemented; 200 `{"status":"ok","uptime":n}` |
| POST   | `/webhook/github`    | Implemented; HMAC-verified intake, dedupe, normalisation, Devin session creation |
| GET    | `/dashboard/metrics` | Implemented; success rate, failure breakdown, MTTR, throughput, ACU cost |

## Layout and upcoming components

```
src/
  index.ts          entrypoint (server startup, graceful shutdown)
  app.ts            Fastify instance and route registration
  config.ts         environment variable loading
  webhook/          Issue/PR webhook intake
  devin-client/     Devin V3 API wrapper
  observability/    SQLite run store, metrics and polling worker
  dashboard/        dashboard UI / metrics API
tests/              Vitest test suite
```

- **`src/webhook/`**: GitHub webhook signature verification (`GITHUB_WEBHOOK_SECRET`), normalisation
  of `issues` / `issue_comment` / `pull_request` events, delivery deduplication and dispatch to
  downstream handling.
- **`src/devin-client/`**: implemented wrapper around the Devin V3 API. `DevinClient` is scoped to
  `https://api.devin.ai/v3/organizations/{DEVIN_ORG_ID}` (override the root with
  `DEVIN_API_BASE_URL`) and authenticates with `DEVIN_API_KEY` as a bearer token. It uses Node's
  built-in `fetch` (injectable for tests) and exposes:
  - `createSession({ prompt, tags, playbookId, maxAcuLimit, structuredOutputSchema, title, idempotent })`
    → `POST /sessions`, returning `session_id` and `url`;
  - `getSession(sessionId)` → `GET /sessions/{id}`, returning `status`, `structured_output`,
    `pull_requests` and `acus_consumed`;
  - `sendMessage(sessionId, message)` → `POST /sessions/{id}/messages`.

  Network failures, 5xx responses and `429` are retried with an exponential backoff
  (`DEVIN_MAX_RETRIES`, 3 by default, `0` disables retries; `DEVIN_RETRY_INITIAL_DELAY_MS`, 1s then
  2s, 4s, …). Other 4xx responses are raised immediately as a `DevinApiError` carrying the status
  and a truncated body. Every request carries an abort timeout (`DEVIN_REQUEST_TIMEOUT_MS`, 30s).
  Session creation from the webhook sets `idempotent: true` so a retried `POST /sessions` cannot
  start a second remediation run. Each backoff delay carries ±20% jitter (`backoffDelay()`), so
  concurrent clients retrying a failing Devin API do not hit it in lockstep.
- **`src/observability/`**: implemented. SQLite persistence of runs, metric computation and the
  background polling worker — see [Observability](#observability).
- **`src/dashboard/`**: UI showing those metrics and the session list, and the JSON API behind it.

## Observability

### Data model

`src/observability/store.ts` opens the SQLite database at `DATABASE_URL` (`file:` prefix optional,
`:memory:` supported) via `better-sqlite3` and owns a single table:

| Column                | Type    | Notes                                                                        |
| --------------------- | ------- | ---------------------------------------------------------------------------- |
| `run_id`              | TEXT PK | UUID generated when the event is detected                                     |
| `issue_ref`           | INTEGER | GitHub issue number, nullable                                                 |
| `trigger_type`        | TEXT    | `webhook` \| `schedule`                                                       |
| `session_id`          | TEXT    | Devin session id; **null when the Devin API call itself failed**              |
| `tags`                | TEXT    | JSON array of the session tags                                                |
| `detected_at`         | TEXT    | ISO-8601, set on intake                                                       |
| `session_started_at`  | TEXT    | ISO-8601, set when the session was created                                    |
| `session_finished_at` | TEXT    | ISO-8601, set when the session reached a terminal state                       |
| `status`              | TEXT    | `pending` \| `dispatch_failed` \| `working` \| `blocked` \| `finished` \| `failed` |
| `pr_url`              | TEXT    | Pull request opened by the session, nullable                                  |
| `pr_url_recorded_at`  | TEXT    | ISO-8601 stamp of when `pr_url` was first seen; the MTTR end point            |
| `pr_merged_at`        | TEXT    | Always null today, see below                                                  |
| `acu_cost`            | REAL    | `acus_consumed` reported by the Devin API, nullable                           |
| `error_message`       | TEXT    | Dispatch or session error, nullable                                           |

### Lifecycle

1. `pending` — written by the webhook dispatcher as soon as an actionable delivery arrives.
2. `dispatch_failed` — the Devin API rejected or never answered `POST /sessions` (or no Devin
   credentials are configured). `session_id` stays null and `error_message` explains why.
3. `working` — the session was created; `session_id` and `session_started_at` are stored.
4. `blocked` / `finished` / `failed` — written by the polling worker from the Devin session status
   (`suspended` → `blocked`, `exit` → `finished`, `error` → `failed`).

### Polling worker

`SessionPoller` (started from `src/index.ts`, interval `POLL_INTERVAL_MS`, 30s by default) calls
`GET /sessions/{id}` for every `working` / `blocked` run and stores the new status, the ACU cost and
the pull request URL (`pull_requests[0].pr_url`, falling back to `structured_output.pr_url`).
Tracking stops at that point: the Devin API does not report whether the pull request was merged, so
`pr_merged_at` stays null until a GitHub-side integration (polling the PR, or a `pull_request`
`closed`/`merged` webhook) is added — that is deliberately out of scope for this session.

### Metrics

`computeMetrics()` aggregates the whole `runs` table and backs `GET /dashboard/metrics`:

- **success rate** — runs with `status = finished` **and** a `pr_url`, divided by all runs;
- **failure breakdown** — `dispatch_failed` and `failed` counts and rates reported separately, so a
  broken dispatch path (Devin API down) is distinguishable from sessions that ran and failed;
- **MTTR** — average of `pr_url_recorded_at - detected_at` over the runs that produced a PR;
- **throughput** — `finished` runs in the last 24 hours;
- **cost** — sum of `acu_cost`, with `estimated: true` and a note whenever some runs have no ACU
  cost reported yet, in which case the total is a lower bound.

```bash
curl http://localhost:3000/dashboard/metrics
```

## Environment variables

See `.env.example`. Today `PORT`, `HOST`, `LOG_LEVEL`, `GITHUB_WEBHOOK_SECRET`, `DEVIN_API_KEY`,
`DEVIN_ORG_ID` and the optional `WEBHOOK_DEDUPE_TTL_MS`, `DEVIN_API_BASE_URL`,
`DEVIN_MAX_ACU_LIMIT`, `DEVIN_MAX_RETRIES`, `DEVIN_RETRY_INITIAL_DELAY_MS`,
`DEVIN_REQUEST_TIMEOUT_MS`, `DATABASE_URL` and `POLL_INTERVAL_MS` are actually used; the
rest are placeholders for the follow-up sessions. Without `DEVIN_API_KEY` / `DEVIN_ORG_ID` the
webhook still runs and logs a warning instead of creating sessions.

## CI

`.github/workflows/ci.yml` runs `npm run lint`, `npm run typecheck` and `npm test` on every push and
pull request.

## Session tags

`orchestrator-build`, `session-1-skeleton`, `session-2-webhook`, `session-3-devin-client`,
`session-4-observability`
