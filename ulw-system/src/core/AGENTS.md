# ulw-system/src/core AGENTS

## OVERVIEW

`core/` 是單一 Node 進程的 kernel：runtime、router、SQLite snapshot、auth/session、rate limit、middleware、metrics/tracing、provider adapters、background state machine。

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Runtime helpers / Store | `runtime.js` | `createRuntime`, `Store`, `requireTenant`, `requireRole`, `requireStoreScope`, `addAudit` |
| Router | `router.js` | `router.add(method, string|RegExp, handler)` |
| SQLite / snapshots | `db.js` | map tables, audit table, idempotency/session tables, schema migration |
| Security / auth primitives | `security.js`, `mfa.js`, `rateLimit.js`, `middleware.js` | hash, MFA, lockout, CORS/security headers |
| Observability | `logger.js`, `metrics.js`, `tracing.js`, `sentry.js`, `auditPg.js` | pino, Prometheus, OTEL, Sentry, PG audit mirror |
| Providers | `paymentProvider.js`, `invoiceProvider.js` | formal adapter boundary; sandbox/go-gate still applies |
| Background work | `syncWorker.js` | outbox, telemetry, draft expiry, invoice retry/dead-letter |
| Contracts | `errorCodes.js`, `openapi.js`, `tz.js`, `entitlements.js` | docs/test alignment surfaces |

## CONVENTIONS

- Core helpers are shared blast-radius code: change the smallest surface and run targeted tests plus `npm test` when behavior crosses domains.
- `roleRank` is numeric authorization truth. Do not compare role strings for privilege.
- `requireTenant` seeds tenant defaults; do not bypass it in authenticated paths.
- `requireStoreScope` must gate any caller-supplied `storeId`.
- Persisted collections must be listed in `persistedMaps`; add restart/persistence coverage when adding one.
- Session/idempotency keys are stored through SQLite-backed maps; preserve TTL/prune behavior.
- `runtime.json` + `runtime.error(errorCode, message, details)` is the response shape. New codes must match `docs/error-codes.md`.
- Provider files define contracts; do not hide sandbox/mock mode after formal go-gate clears.
- Worker transitions need audit, retry caps, dead-letter states, and manual repair traceability.

## ANTI-PATTERNS

- No client body/query `tenant_id` as authority.
- No mutation that relies on in-place object edits without `.set()` when map state changes.
- No read-only handler calling `store.persist()` manually.
- No external I/O inside persistence-critical transaction shapes.
- No raw PAN/CVV/PIN block/magstripe/chip data in logs, DB, traces, fixtures, or errors.
- No metrics endpoint exposure without the configured metrics token gate.

## ACCEPTANCE

- Core runtime change: run affected `tests/*runtime*`, `persistence`, `security`, `middleware`, `rateLimit`, `metrics`, `audit`, then broader `npm test` if shared helpers changed.
- Provider/worker change: assert happy path, retry/dead-letter, audit row, and manual repair state.
- Public API contract change: update `docs/error-codes.md`, `docs/qa-matrix.md`, OpenAPI tests if route shape changed.
