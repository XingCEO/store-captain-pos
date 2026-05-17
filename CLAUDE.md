# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository shape

This repo is **two things in one tree**, not one app with docs around it:

1. **`docs/` + root `*.md`** — the product blueprint for "店長 AI POS" (Store Captain POS). All product, market, compliance, risk, architecture, and roadmap thinking lives here as Traditional-Chinese specs. These are *executable specs*, not vision deck — every ticket must carry the 9 fields from `docs/ai-engineering-rules.md` (背景/目標/不做範圍/資料表-API-畫面/狀態與錯誤/權限與租戶隔離/稽核與監控/測試案例/手動 QA/上線-回滾/待確認事項).
2. **`ulw-system/`** — the only running code. A single Node.js process serving REST API + multi-page static site out of `public/`. **Has its own `CLAUDE.md`** at `ulw-system/CLAUDE.md` with backend layering, store/persist hazards, Service Worker outbox rules, SW version bump rule, QR encoder invariant, hover-style traps, etc. Read that file before touching anything under `ulw-system/`.

`docs/` and `ulw-system/` evolve together but obey different rules: docs are spec-and-risk artifacts; `ulw-system/` is the runnable implementation and may lag the full spec, but must not contradict the high-risk constraints (offline, idempotency, tenant scope, audit).

## Where to start for any task

| Task | Read first |
|------|-----------|
| Any code change in `ulw-system/` | `ulw-system/CLAUDE.md`, then `ulw-system/AGENTS.md` |
| New ticket / spec / API surface | `docs/ai-engineering-rules.md` (9-field rule), `docs/implementation-kickoff-tickets.md` for the field-level template |
| Anything touching 發票/支付/AI/總部/庫存/benchmark | `docs/high-risk-workstreams.md` — these have explicit go-gates and are blocked until each gate clears |
| Tenant isolation, RLS, idempotency, audit | `docs/architecture.md` §6 (權限與資安) + §4 (離線同步) |
| Compliance scope (電子發票, 個資, 金流, 多租戶) | `docs/compliance-guardrails.md` |
| Pricing, plan tiers, market positioning | `docs/product-plan.md` §5, `docs/research-notes.md` |
| Roadmap window (what is in/out for this sprint) | `docs/roadmap.md` + `docs/implementation-kickoff-tickets.md` |
| Outstanding gaps and known weaknesses | `docs/problem-review.md` |
| External confirmations needed | `docs/partner-confirmation-checklist.md` |

`AGENTS.md` (root) holds the language/style/quality contract for all editors. `ulw-system/AGENTS.md` adds the implementation-side contract.

## Hard rules that override default behavior

These come from `AGENTS.md` + `docs/ai-engineering-rules.md` and apply to **every** change, doc or code:

- **Language**: documents in Traditional Chinese (繁體中文). Technical terms (`Offline-first`, `Outbox`, `Idempotency`, `Tenant`) may stay in English. Customer-facing copy must be plain shop-owner language, not engineering jargon.
- **Naming**: JSON fields `snake_case`, JavaScript identifiers `camelCase`.
- **No fuzzy words.** Do not substitute 「等等」/「之類」/「相關」/「視情況」/「後續補」 for a real spec. Missing info goes in a `待確認` block with *who confirms*, *what they confirm*, and *what cannot start before then*.
- **No "future optimization" for high-risk items.** 電子發票, 支付, 個資, 多租戶隔離, 資安, 資料一致性 must be in the first design — not bolted on later.
- **Every delivery needs an acceptance test.** Deliveries without an acceptance method count as not done.
- **For every API ticket**: at least one bad-input case, one retry/conflict case, one permission-deny case — happy-path-only is rejected.
- **High-risk workstream gates**: `E-INVOICE`, 正式金流, AI 自動決策, 連鎖總部, 複雜進銷存, Benchmark — production enablement requires the corresponding go-gates in `docs/high-risk-workstreams.md`. Non-production scaffolding must label its actual mode; formal implementations must not be forced into non-production labels after gate clearance.
- **Agent output**: default to minimal replies. Lead with conclusion, keep evidence/verification/next step only, no pleasantries.

## Current implementation snapshot (as of 2026-05)

The blueprint targets a 0-to-12-month rollout (see `docs/roadmap.md`). What actually exists today:

- **`ulw-system/`** is the runnable MVP implementation surface: identity (login/sessions/roles), catalog (products/SKUs/modifiers), commerce (orders/payment/void/refund + idempotency + cash drawer), operations (order-hub, print jobs, telemetry, report exports), and risk (invoice/inventory/AI insights) domains. It uses local SQLite snapshot persistence; real auth provider, payment gateway, and invoice 加值中心 remain gated integrations.
- **Background workers** (outbox sync ticker + telemetry staleness daemon) now run in-process; print job retry has exponential backoff + DEAD_LETTER; mode markers must match the active integration state.
- **Frontend**: 8 static HTML pages under `ulw-system/public/` (marketing + login + POS workstation + customer QR + legal). The POS workstation (`app.html`) has the 5-zone (POS/HUB/RISK/OPS/LIVE) layout. Service Worker (`public/sw.js`) implements offline shell + IndexedDB outbox.
- **Not yet production-enabled**: real 電子發票 上線, real 刷卡/QR 金流, KDS hardware, multi-store 總部 control, AI 自動決策, 完整進銷存, anonymous benchmark, ERP/會計/外送平台 webhooks. These are tracked in `docs/roadmap.md` months 4-12 and gated by `docs/high-risk-workstreams.md`.
- **Marketing pricing page** must reflect current capability without forcing a non-production label.

## Running the app

All commands run from `ulw-system/`. There is no root-level app script; use `ulw-system/package.json` for start, lint, test, smoke, and DB helpers.

```
cd ulw-system
npm start                       # node src/server.js, default PORT 3100
curl http://localhost:3100/health
```

Windows: `set PORT=4000 && npm start`. POSIX: `PORT=4000 npm start`. The process writes its PID to `ulw-system/.server-pid.txt` when launched by tooling — kill that PID before relaunching a stale run. Delete `ulw-system/data/store.db*` to fully reset (re-seeded by `ensureTenantDefaults()` on next authenticated request).

Quick regression (per `ulw-system/AGENTS.md`):

1. `POST /api/v1/auth/login`
2. `POST /api/v1/orders` (with `idempotencyKey`)
3. `POST /api/v1/orders/:id/pay/manual`
4. `POST /api/v1/orders/:id/void`

There is **no root-level `package.json`** — anything outside `ulw-system/` is documentation.

## Cross-cutting constraints (apply to both docs and code)

These are the invariants both halves must respect; both `docs/architecture.md` and `ulw-system/CLAUDE.md` expand them in their own context.

- **Offline-first POS**: the till must keep working when the network is down. Local write + outbox enqueue must share one transaction. UI reads local, never blocks on cloud.
- **Idempotency at the business layer, not just the API gateway**: orders, payments, invoices, inventory deltas each need their own key. Cloud stores payload fingerprint; same key + different payload = reject.
- **Tenant scope is non-negotiable**: every query, cache key, queue message, file path, log line carries `tenant_id`. Never trust client-supplied `tenant_id` — derive from the authenticated session/API key. PostgreSQL deployments should layer RLS as defense in depth (`FORCE ROW LEVEL SECURITY` for prod).
- **Role gate is numeric rank, never string equality** — see `roleRank` in `ulw-system/src/core/runtime.js` and the role table in `docs/architecture.md` §6.
- **PCI scope minimization**: POS never stores PAN, CVV, magstripe, or PIN block. Card and mobile-pay flows must be delegated to certified gateway / terminal / SDK; POS keeps only `providerTransactionId`, authorization code, amount, status, optional last4.
- **Audit-or-it-didn't-happen**: 改價/折扣/退貨/作廢/補印發票/開錢櫃/修改庫存/權限變更/匯出 all leave an `audit_logs` row with actor, role, device, tenant, before/after.
- **Manual repair path required**: every retry / dead-letter / exception flow must specify *who* repairs, *when*, and *how data is reconciled*. "後續補" is not a repair plan.
