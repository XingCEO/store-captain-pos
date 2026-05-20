# ulw-system/src/domains AGENTS

## OVERVIEW

`domains/` owns the POS business API. Each file exports `register(router, runtime)` and may only communicate through `runtime.store.data` plus runtime helpers.

## STRUCTURE

| File | Role |
|------|------|
| `identity.js` | auth, sessions, MFA, users, stores, settings, audit logs |
| `subscription.js` | plan catalog, current subscription, change/cancel, capacity gates |
| `catalog.js` | products, SKUs, modifiers, prices, import/export |
| `commerce.js` | POS orders, payments, refunds, voids, invoice creation helper |
| `operations.js` | manual/QR/LINE channels, order hub, KDS, cash drawer, inventory, sync jobs |
| `risk.js` | invoice sandbox workflows, reconciliation, reports, exports, print jobs, customers, coupons, AI brief |

## CONVENTIONS

- Route handlers must start with `requireTenant` when private, then the minimum `requireRole`.
- Any route with `storeId` must call `requireStoreScope` before reading or mutating store data.
- Replayable mutation routes use idempotency: same key + same fingerprint returns cached response; same key + different body returns 409.
- Money, inventory, invoice, role, export, refund, void, drawer, settings, channel, sync-job changes must call `addAudit`.
- Use copy-then-`.set()` for Map rows; preserve `tenantId`, IDs, version/state fields, timestamps.
- Error responses use existing `SCREAMING_SNAKE_CASE` codes from `docs/error-codes.md` before adding a new one.
- Inventory mutations write ledger movement before projection changes; rebuild may recompute projections from ledger.
- Invoice/payment/AI/HQ/formal inventory flows remain gate-bound by `docs/high-risk-workstreams.md`.

## ANTI-PATTERNS

- No domain-to-domain imports or hidden cross-calls.
- No trusting `tenantId`/`tenant_id` from body/query for authorization.
- No mutation without audit for high-risk state.
- No direct stock balance edit as source of truth.
- No accepting client-calculated totals without server-side SKU/price/permission checks.
- No formal production claim for sandbox invoice/payment/provider output.

## ACCEPTANCE

- Route change requires at least: happy path, bad input, retry/conflict if replayable, permission denial, tenant/store-scope check.
- Operator-facing flow change should update `scripts/smoke.js` when it belongs to login -> order -> pay -> void/invoice health surface.
- Contract change should update `docs/qa-matrix.md`; new/renamed error code updates `docs/error-codes.md` and `tests/errorCodes.test.js`.
