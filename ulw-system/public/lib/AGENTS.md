# ulw-system/public/lib AGENTS

## OVERVIEW

`lib/` holds shared browser primitives used by public pages and the workstation: QR encoder, shared topbar, and POS extras for QR/print/scanner/training helpers.

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| QR encoding | `qrcode.js` | Pure JS QR encoder; no dependency injection or DOM assumption |
| POS extras | `pos-extras.js` | QR display, receipt print popup, scanner helpers, training mode |
| Shared navigation | `topbar.js` | Marketing/login/app topbar behavior; keep page-neutral |

## CONVENTIONS

- `qrcode.js` format-info placement is critical: bits 0-5 go along column 8 rows 0-5 (`matrix[k][8]`).
- v7+ QR output requires version-info blocks; preserve ECC/mask/version behavior.
- `pos-extras.js` owns the `o.html#...` QR URL contract; keep customer order URLs stateless and shareable.
- Receipt print window must open synchronously inside the user click path before awaited data.
- `topbar.js` is shared shell code; do not add page-specific workstation logic there.

## ANTI-PATTERNS

- No moving QR logic into app-only code if `o.html` or marketing surfaces still need it.
- No changing QR format placement without decoder verification.
- No adding tenant tokens, secrets, or raw payment data to QR/hash/static JS.
- No topbar behavior that assumes the user is authenticated.

## ACCEPTANCE

- QR change: generate a QR and decode it with the root QR ad hoc decoder or equivalent.
- Print/receipt change: click through the print flow in browser and confirm popup is not blocked.
- Topbar change: open marketing, login, and app pages at desktop/mobile widths.
