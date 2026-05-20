# ulw-system/tests AGENTS

## OVERVIEW

`tests/` is Node built-in test coverage for `ulw-system`; it protects API contracts, security boundaries, persistence, workers, OpenAPI, metrics, a11y, and high-risk invariants.

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Test harness | `helpers.js` | temp data dir, isolated app, disabled background workers |
| Auth / sessions | `auth.test.js`, `sessionHash.test.js`, `pinHash.test.js`, `rateLimit.test.js` | login, PIN, lockout, token hash |
| Orders / payments | `orders.test.js`, `commerce.test.js` | idempotency, payment, void, refund |
| Audit / security | `audit.test.js`, `auditTable.test.js`, `security.test.js`, `middleware.test.js` | tenant, headers, audit persistence |
| Reporting / ops | `metrics.test.js`, `metricsAuth.test.js`, `worker.test.js`, `tz.test.js` | metrics, background jobs, Taipei date |
| Contracts | `errorCodes.test.js`, `openapi.test.js`, `staticEtag.test.js` | docs/API consistency |
| Browser a11y | `a11y.test.js` | separate `npm run test:a11y` |

## CONVENTIONS

- Use `node:test` + `assert/strict`; keep tests framework-free.
- Default suite is `npm test`, matching `tests/*.test.js`.
- `a11y.test.js` is separate and runs via `npm run test:a11y` because it uses Playwright + axe.
- Tests must create isolated temp data and not rely on `ulw-system/data/store.db`.
- Disable background workers in deterministic tests unless testing worker behavior directly.
- Use `helpers.js` for HTTP tests: temp data dir, fresh app, workers disabled, request/login helpers.
- If a test changes env or module behavior, reset `process.env` and `require.cache` in `finally`.
- Route tests should align with `docs/qa-matrix.md`: happy path, bad input, conflict/retry, permission denial.
- Mutating route tests should assert `errorCode`, tenant/store scope, audit side effects, and final state; do not stop at 200/201.
- Idempotency expectation: same key + same body returns same ID with duplicated marker; same key + different body returns 409 conflict.
- Auth/MFA/rate-limit tests should cover PIN-required, bad PIN, refresh/session, lockout, and `Retry-After` when applicable.
- Persistence/audit tests must verify on-disk rows or restart survival when that is the contract.
- Worker tests use explicit store fixtures or spawned processes; do not reuse normal HTTP helper shape unless testing HTTP surface.
- Error-code expectations must align with `docs/error-codes.md`.
- `scripts/smoke.js` is operator QA against a live server; add to it only for operator-facing happy-path regressions.
- `scripts/pg-up.js`, `scripts/pg-apply.js`, and `scripts/backup.js` are operational/idempotent helpers, not `npm test` members.

## ANTI-PATTERNS

- Do not weaken or delete tests to pass CI.
- Do not share persistent DB snapshots across tests.
- Do not assert only HTTP 200 for high-risk behavior; assert errorCode, tenant scope, audit, and state transition.
- Do not add tests that depend on live third-party services.
- Do not hide flaky behavior with arbitrary sleeps; expose a deterministic hook or fake time.

## COMMANDS

```bash
npm test
npm run test:a11y
npm run smoke
```

## ACCEPTANCE

- New API route: add/adjust `tests/*.test.js` and update `docs/qa-matrix.md` when coverage changes.
- New live regression: add to `scripts/smoke.js` if it is part of operator-facing happy path.
- New errorCode: update `docs/error-codes.md` and corresponding tests.
