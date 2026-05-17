# ulw-system/src AGENTS

## OVERVIEW

`src/` 是單一 Node.js 進程的 API、runtime、背景 worker 與 domain 邊界；所有行為必須可透過 HTTP surface 驗證。

## STRUCTURE

```text
src/
├── server.js              # createApp、HTTP lifecycle、persist hook、metrics、OpenAPI
├── core/                  # runtime、router、db、security、metrics、middleware、sync worker
├── domains/               # identity/catalog/commerce/operations/risk route groups
├── db/schema.pg.js         # future Postgres / RLS schema source
└── workers/syncWorker.js   # standalone worker entry
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Route lifecycle | `server.js`, `core/router.js` | `router.add(method, matcher, handler)` |
| Tenant / role / audit | `core/runtime.js` | `requireTenant`, `requireRole`, `requireStoreScope`, `addAudit` |
| Persist / SQLite | `core/db.js`, `core/runtime.js` | Map snapshot + audit table |
| Auth / users | `domains/identity.js` | sessions keyed by token hash |
| Catalog | `domains/catalog.js` | products, SKUs, price batch, import |
| Orders / payments | `domains/commerce.js` | idempotent order create, pay, refund, void |
| Operations | `domains/operations.js` | order hub, KDS, cash drawer, inventory |
| Risk / reporting | `domains/risk.js` | invoice workflows, reports, exports, telemetry, sync jobs |
| Background work | `core/syncWorker.js`, `workers/syncWorker.js` | draft expiry, telemetry stale, outbox jobs |

## CONVENTIONS

- Domain files export `register(router, runtime)`; domains do not call each other directly.
- Handlers read/write via `runtime.store.data` Maps and helpers only.
- Mutations succeed only when response status `< 400`; `server.js` then calls `store.persist()`.
- Update Map rows by copy + `.set(key, next)`. Do not mutate stored object in place and assume readers notice.
- Role checks use numeric `roleRank`; never compare role strings for authorization.
- Every route accepting `storeId` must call `requireStoreScope`.
- New mutation route must define errorCode, tenant scope, role gate, audit row, and idempotency if replayable.
- Invoice / payment / AI / HQ / inventory / benchmark formal routes require go/no-go gate before production use; non-formal routes must mark their actual mode, but do not force formal work into non-production labels.

## ANTI-PATTERNS

- No route that trusts `tenantId` / `tenant_id` from request body or query.
- No mutation without audit when money, inventory, invoice, role, export, discount, refund, void, drawer, or settings change.
- No raw card data in request, DB, log, analytics, fixtures, or tests.
- No direct `stockOnHand` adjustment without ledger movement.
- If an invoice route is non-production, it must return accurate mode fields; formal integrations must not keep old markers after gate clearance.
- No `await fetch` or external I/O inside persistence-critical transaction shapes.
- No new persisted collection without adding it to `persistedMaps` and tests.

## COMMANDS

```bash
npm test
npm run lint
npm run smoke
```

## ACCEPTANCE

- Run relevant `node --test` file or full `npm test`.
- For API behavior, run `npm run smoke` against a live server when route surface changes.
- Verify at least one bad input, one conflict/retry path, one permission denial, tenant isolation, audit row, and manual repair note when applicable.
