# devin-orchestrator

An event-driven automation orchestrator built on top of the Devin API. It receives GitHub Issue and
Pull Request events via webhooks, decides which Devin sessions to start, tracks those sessions, and
stores their outcomes (success rate, latency, cost) so they can be visualised on a dashboard.

The HTTP server, directory layout, Docker setup, test harness and CI pipeline are in place, and the
GitHub webhook intake and the Devin V3 API client are implemented. The observability store and
dashboard are filled in during follow-up sessions.

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
   `DEVIN_MAX_ACU_LIMIT`, and logs the resulting `session_id`. If the Devin API call fails after all
   retries the error is logged only: the webhook has already answered `200` so GitHub does not
   redeliver.

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
| GET    | `/dashboard/metrics` | Placeholder, returns empty metrics         |

## Layout and upcoming components

```
src/
  index.ts          entrypoint (server startup, graceful shutdown)
  app.ts            Fastify instance and route registration
  config.ts         environment variable loading
  webhook/          Issue/PR webhook intake
  devin-client/     Devin V3 API wrapper
  observability/    state persistence and metrics
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

  Network failures and 5xx responses are retried with an exponential backoff (`DEVIN_MAX_RETRIES`,
  3 by default; `DEVIN_RETRY_INITIAL_DELAY_MS`, 1s then 2s, 4s, …). 4xx responses are raised
  immediately as a `DevinApiError` carrying the status and body.
- **`src/observability/`**: SQLite persistence for events, sessions and outcomes, plus metrics such
  as success rate, time to first response and ACU usage.
- **`src/dashboard/`**: UI showing those metrics and the session list, and the JSON API behind it.

## Environment variables

See `.env.example`. Today `PORT`, `HOST`, `LOG_LEVEL`, `GITHUB_WEBHOOK_SECRET`, `DEVIN_API_KEY`,
`DEVIN_ORG_ID` and the optional `WEBHOOK_DEDUPE_TTL_MS`, `DEVIN_API_BASE_URL`,
`DEVIN_MAX_ACU_LIMIT`, `DEVIN_MAX_RETRIES`, `DEVIN_RETRY_INITIAL_DELAY_MS` are actually used; the
rest are placeholders for the follow-up sessions. Without `DEVIN_API_KEY` / `DEVIN_ORG_ID` the
webhook still runs and logs a warning instead of creating sessions.

## CI

`.github/workflows/ci.yml` runs `npm run lint`, `npm run typecheck` and `npm test` on every push and
pull request.

## Session tags

`orchestrator-build`, `session-1-skeleton`, `session-2-webhook`, `session-3-devin-client`
