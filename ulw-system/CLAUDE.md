# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

`ulw-system` — "店長 AI POS" (Store Captain POS). Traditional-Chinese POS app + marketing site. Single Node.js process serving REST API + static frontend out of `public/`.

## Commands

```
npm start                       # node src/server.js, listens on PORT (default 3100)
PORT=4000 npm start             # override port
curl http://localhost:3100/health
```

There is no build step. Use `package.json` scripts for lint, test, smoke, and DB helpers. Edits to `src/**` or `public/**` are picked up by restarting the process. The server PID is written to `.server-pid.txt` when started via tooling — kill that PID to stop a stale run before relaunching.

State persists to `data/store.db` via SQLite snapshot tables plus `audit_logs`. Delete the DB files to reset tenants, users, orders, inventory, invoices, sessions back to defaults — `ensureTenantDefaults()` will reseed on next authenticated request.

## Architecture

### Two halves, one process

1. **Backend** (`src/`) — modular HTTP API on plain `http` + custom router, no framework.
2. **Frontend** (`public/`) — multi-page static site (8 HTML files) + Service Worker offline shell. The same Node process serves both: GET requests outside `/api/*` and `/health` fall through to `runtime.serveStatic()`.

### Backend layering

```
src/server.js                      # boots http + wires domains
src/core/router.js                 # tiny router (string or RegExp matcher, async handlers)
src/core/runtime.js                # Store + helpers (auth, audit, idempotency, role gate, tenant seed)
src/domains/{identity,catalog,commerce,operations,risk}.js
                                   # each exports register(router, runtime) and owns its API surface
```

The runtime is passed to every domain via `register(router, runtime)`. Domains never touch each other directly — they read/write through `runtime.store.data` Maps and use `runtime.json / parseBody / requireTenant / requireRole / requireStoreScope / addAudit / nextId`.

### Store (`runtime.store`)

In-memory Map-per-collection, persisted as JSON. Every mutating request triggers `store.persist()` via the `res.end` wrapper in `server.js` (response status < 400). Important consequences:

- **Never mutate Map entries without setting them back** — `.set(key, {...current, field: v})`. The persist hook only sees the Map, not field-level deltas, but downstream readers expect a fresh object.
- **IDs come from `runtime.store.nextId(prefix)`** (e.g. `order`, `invoice`, `inventoryMove`). Counters live in `data.counters` and are persisted alongside the Maps.
- Persistence list is `persistedMaps` in `core/runtime.js` — adding a new collection requires appending the name there or it won't survive restart.

### Auth + tenancy

- Tokens are random 32-byte hex strings stored in `data.sessions`. Sent via `Authorization: Bearer …`.
- `requestContext(req)` resolves the bearer into `{ tenantId, userId, role, storeIds, storeId, sessionId, deviceId }`. Anonymous requests get `role: 'GUEST'` and `tenantId: null`.
- `requireTenant` calls `ensureTenantDefaults(tenantId)` — first request from a new tenant seeds 4 users (ADMIN/SUPERVISOR/MANAGER/CASHIER), a default store (`store-001`), 3 products with modifier groups (drink sweetness/ice, breakfast sauce, lunchbox sides), and one coupon. Persisted immediately.
- Role gate is **numeric rank**, not equality: `roleRank` in `core/runtime.js`. `requireRole(res, ctx, 'CASHIER')` admits CASHIER and above. Don't compare role strings directly.
- Store scope: a user's `storeIds` is enforced by `requireStoreScope` on every endpoint that accepts a `storeId` in the body.

### Idempotency + audit

- Mutating endpoints (orders, payments, refunds) require `idempotencyKey` in the body. The runtime stores `${tenantId}:${storeId}:${key}` → previous response. Replays return the cached response.
- `addAudit(ctx, action, resourceType, resourceId, before, after)` appends to `data.auditLogs` (a plain array, not a Map). Use this for any state change a SUPERVISOR/auditor might need to trace.
- `requestFingerprint(payload)` produces a stable `sha256:` of a key-sorted JSON. Used to dedupe events with identical content.

## Frontend

### Pages (`public/`)

| Path | Purpose |
|------|---------|
| `index.html` | Marketing landing — hero, 3 pillar cards linking to product/pricing/workstation, trimmed pain teaser, CTA. Top nav: 首頁 / 產品功能 / 方案 / 工作台 + 登入/註冊. |
| `product.html` | Feature deep-dive — anchor nav + 5 grouped zones (POS / HUB / RISK / OPS / LIVE), pain×7, workflow, industries, compare table. |
| `pricing.html` | 3 plans + cases + 4 trust + horizontal roadmap stepper (42% progress) + exclusive-accordion FAQ + contact CTA. |
| `login.html` | Pure login/register with `height: 100vh; overflow: hidden`. Tab switch + OAuth buttons. Submit redirects to `/app.html`. |
| `app.html` | POS workstation. Auth-gate has 3 store profiles (晨光早餐店 CASHIER/MANAGER, 阿福便當 SUPERVISOR). Five views: POS / HUB / RISK / OPS / LIVE. |
| `o.html` | Customer-facing QR landing page, reads URL hash params. |
| `terms.html`, `privacy.html` | 10-section legal pages with `.legal-card` styling. |

**Two CSS bundles, kept separate**: `site.css` (~61KB) for marketing pages, `app.css` (~52KB) for the POS workstation. Don't cross-contaminate — `index/product/pricing/login/terms/privacy` use site.css; `app.html` uses app.css.

### Service Worker (`public/sw.js`)

- `VERSION = 'sc-vN'` — **bump this any time SHELL contents or fetch strategy change**, otherwise clients keep stale assets. Old `sc-static-*` and `sc-runtime-*` caches are deleted on activate when the version no longer matches.
- Strategy split: navigations + documents are **network-first** (so HTML reloads stay fresh), other static assets are stale-while-revalidate, `/api/*` GETs are network-first with cache fallback, `/api/*` mutations are network-first with **IndexedDB outbox**.
- Outbox returns synthetic `202 { queued: true, reason: 'offline' }` when offline. Drained on `sync` tag `store-captain-drain` or `postMessage({type:'drain-now'})`. Retry cap `MAX_ATTEMPTS = 6`. On 401/403 it broadcasts `queue-auth-expired` and stops.
- The server's idempotency layer is what makes replay safe — do not weaken `idempotencyKey` checks on the API.

### POS client (`public/app.js`, ~73KB)

- All mutating callers must guard `isQueued(result)` (a 202 returns `{ queued: true }` with no `id`). Endpoints that need this: `submitOrder`, `payOrder`, `createQrOrder`, `createLineOrder`, `createPhoneOrder`.
- Cart line key is a **composite** `_key` derived from product id + selected modifiers + combo + addons — same product with different modifiers produces distinct cart lines.
- Print receipt flow opens a print window **synchronously inside the click handler** (`preparePrintWindow()`), then resolves async data into it. Opening after `await` loses the user gesture and gets blocked.
- Modifier modal (`openModifierModal`) renders three section types: modifier groups (single/multi), combo (single radio, copper accent), addons (multi checkbox). Live total recalculates on change.

### Pure-JS QR encoder (`public/lib/qrcode.js`)

Byte mode, ECC L/M/Q/H, versions 1–10. **Critical invariant**: in `placeFormat`, bits 0–5 go along **col 8, rows 0–5** (`matrix[k][8]`), not along row 8. The transposed version structurally looks valid but jsQR cannot decode it — verify with jsQR after any change to format-info placement. v7+ also requires `drawVersion` for the version-info blocks.

### Hover/active styling traps

The marketing CSS has a global `button:hover { background: #1f2730 }`. POS product cards override with `!important`:
```css
.product-card:hover { background-color: #fbf7ec !important; background-image: none !important }
.product-card:active { background: var(--jade-soft) !important }
```
The `.app-frame[hidden]` rule uses `display: none !important` because `display: grid` would otherwise win over the `hidden` attribute. Keep both `!important` overrides if you touch hover/visibility styles.

## Background workers + mode marking

- `src/core/syncWorker.js` runs an in-process outbox tick (10s default) and telemetry staleness tick (30s default). It transitions stuck outbox jobs to `DEAD_LETTER` after 6 attempts and audits the transition. Disable with env `DISABLE_BACKGROUND_WORKERS=1` when running smoke tests or scripted reproductions.
- Current invoice routes under `/api/v1/invoices/*` are non-production until a real 加值中心 / Turnkey adapter ships. Responses must mark the actual mode; do not force old markers after the corresponding go-gate clears.
- Print job retries use exponential backoff capped at 30 min; after 6 attempts the job transitions to `DEAD_LETTER` with audit row `PRINT_JOB_RETRY`.
- Smoke test: `node scripts/smoke.js` against a running server hits health → login → order create → idempotent replay → pay → void → invoice health. Must remain green.

## Common pitfalls

- **Working dir matters for tooling, not for the app.** The dev server only resolves paths via `__dirname`. If you `cd public/lib` for ad-hoc Node tests, do not leave `.omc/` artifacts behind there — they pollute hook detection.
- **CSV BOM**: use the explicit escape `'﻿'`, not a literal char in source.
- **`store.persist()` is synchronous** and runs on every successful mutation response. Don't call it inside read-only handlers; don't skip a response after mutating (the persist hook won't fire if the response status is ≥ 400).
- **Service Worker tx hazard**: never wrap `await fetch(...)` inside an IDB `readwrite` transaction. The current `drainQueue` splits read (readonly) and update/delete (one readwrite per item) for exactly this reason — preserve that shape.
- **Caveman lite communication mode is active** for this session per user-global config: drop articles/filler/pleasantries/hedging in chat replies; keep code, commit messages, and security warnings written normally.
