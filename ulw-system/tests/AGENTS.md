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
- Route tests should align with `docs/qa-matrix.md`: happy path, bad input, conflict/retry, permission denial.
- Error-code expectations must align with `docs/error-codes.md`.

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
