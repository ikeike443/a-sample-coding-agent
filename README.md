# devin-orchestrator

An event-driven automation orchestrator built on top of the Devin API. It receives GitHub Issue and
Pull Request events via webhooks, decides which Devin sessions to start, tracks those sessions, and
stores their outcomes (success rate, latency, cost) so they can be visualised on a dashboard.

At this point the repository contains only the **skeleton**: no business logic is implemented yet.
The HTTP server, directory layout, Docker setup, test harness and CI pipeline are in place, and each
component will be filled in during follow-up sessions.

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
| POST   | `/webhook/github`    | Placeholder, returns 501                   |
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
  of `issues` / `issue_comment` / `pull_request` events, and dispatch to downstream handling.
- **`src/devin-client/`**: wrapper around the Devin V3 API (create/get session, send message),
  authenticated with `DEVIN_API_KEY` / `DEVIN_ORG_ID`, with retries and typed responses.
- **`src/observability/`**: SQLite persistence for events, sessions and outcomes, plus metrics such
  as success rate, time to first response and ACU usage.
- **`src/dashboard/`**: UI showing those metrics and the session list, and the JSON API behind it.

## Environment variables

See `.env.example`. Today only `PORT`, `HOST` and `LOG_LEVEL` are actually used; the rest are
placeholders for the follow-up sessions.

## CI

`.github/workflows/ci.yml` runs `npm run lint`, `npm run typecheck` and `npm test` on every push and
pull request.

## Session tags

`orchestrator-build`, `session-1-skeleton`
