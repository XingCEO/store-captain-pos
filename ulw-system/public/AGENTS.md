# ulw-system/public AGENTS

## OVERVIEW

`public/` contains static marketing pages, POS workstation, customer QR page, legal pages, shared assets, and Service Worker offline behavior.

## STRUCTURE

```text
public/
├── index.html, product.html, pricing.html, login.html, terms.html, privacy.html
├── app.html                 # POS workstation shell
├── o.html                   # customer QR ordering page
├── site.css, site.js         # shared shell; marketing/login/legal and app shell imports
├── app.css, app.js           # POS workstation only
├── sw.js                    # offline shell + IndexedDB outbox
└── lib/                     # QR encoder, topbar, POS extras
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Marketing copy / layout | `index.html`, `product.html`, `pricing.html`, `site.css`, `site.js` | Keep shop-owner language |
| POS workstation | `app.html`, `app.js`, `app.css` | Five zones: POS / HUB / RISK / OPS / LIVE |
| Customer QR order | `o.html`, `lib/` | Read `lib/AGENTS.md`; hash URL + QR encoder invariant matters |
| Offline behavior | `sw.js` | shell cache + IndexedDB mutation outbox |
| Shared nav/topbar | `lib/topbar.js` | affects public pages |
| Legal pages | `terms.html`, `privacy.html` | status claims must stay honest |

## CONVENTIONS

- `site.css` / `site.js` affect marketing, login, legal pages, and app shell imports. `app.css` / `app.js` must stay workstation-scoped.
- `login.html` is hybrid: it loads `site.css`, `app.css`, `site.js`, and `topbar.js`; test it after shared-shell changes.
- `app.html` is workstation, but imports `site.css` / `site.js` for shared shell/topbar; do not assume `site.css` is marketing-only.
- Any `sw.js` shell or fetch strategy change must bump `VERSION`; stale cache bugs count as regression.
- `/api/*` mutation callers must handle offline synthetic `202 { queued: true, reason: 'offline' }`.
- Print window must open synchronously inside the click handler before awaited data.
- QR/topbar/POS extras rules live in `lib/AGENTS.md`; decode-test QR after any QR placement/version/ECC change.
- Customer-facing copy must say what the店家 can do, not only internal architecture.
- UI mode markers must match backend reality; do not force non-production markers after real go-gate clears.

## ANTI-PATTERNS

- Do not use `site.css` fixes for `app.html`, or `app.css` fixes for marketing pages.
- Do not add auth/app chrome to `o.html`; it is customer-facing and hash/query driven.
- Do not remove `.app-frame[hidden] { display: none !important }` visibility protection.
- Do not remove product-card hover `!important` overrides without checking global `button:hover` side effects.
- Do not weaken SW origin checks, IndexedDB outbox retry limits, or auth-expired handling.
- Do not present non-production invoice/payment/AI output as production-ready.
- Do not put secrets, tenant tokens, or raw card data into static JS fixtures.

## ACCEPTANCE

- For UI/CSS changes, open affected pages in a browser and test desktop + mobile widths.
- For `app.js`, run the POS happy path: login, add item, submit order, pay, void or refund as relevant.
- For `sw.js`, test online and offline mutation behavior plus replay after reconnect.
- For QR changes, verify generated QR with a decoder after any placement/version/ECC change.
