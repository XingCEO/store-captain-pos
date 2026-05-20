# ulw-system AGENTS

## OVERVIEW

`ulw-system` 是「店長 AI POS」唯一可執行實作：單一 Node.js 進程提供 REST API、靜態前端、Service Worker 離線 outbox、SQLite snapshot、背景 worker。

## SCOPE

適用：`src/**`、`public/**`、`tests/**`、`scripts/**`、`package.json`、`data/**`、`migrations/**`。進場前讀 `../docs/ai-engineering-rules.md`；高風險流程不得用「等等 / 相關 / 後續補」替代規格。

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| 啟動 / route lifecycle | `src/server.js`, `src/core/router.js` | `createApp` 註冊 domains；router 處理字串 / RegExp |
| Core kernel | `src/core/` | 讀 `src/core/AGENTS.md`；runtime、persistence、auth、audit、idempotency、workers |
| Domain API | `src/domains/` | 讀 `src/domains/AGENTS.md`；identity/subscription/catalog/commerce/operations/risk |
| 前端工作台 | `public/app.html`, `public/app.js`, `public/app.css` | POS / HUB / RISK / OPS / LIVE |
| 行銷 / 法務 / QR | `public/` | 讀 `public/AGENTS.md` 與 `public/lib/AGENTS.md` |
| Offline / outbox | `public/sw.js`, `src/core/syncWorker.js` | SW queue + server worker；retry/dead-letter/manual repair |
| 測試 / QA gate | `tests/`, `scripts/smoke.js` | 讀 `tests/AGENTS.md` |
| DB / RLS | `src/db/`, `migrations/*.sql` | `migrations/meta/**` 是 Drizzle 產物，不手寫 |
| Runtime data | `data/store.db`, `data/pg/**`, `data/backups/**` | local state / embedded PG / backups；不當產品規格 |

## ARCHITECTURE

- 無框架單一 Node 進程：`src/server.js` 建 HTTP server，成功 mutation 後由 response wrapper 呼叫 `store.persist()`。
- `src/core/runtime.js` owns Store、錯誤格式、tenant scope、role gate、audit、idempotency、static serving。
- `src/domains/*` 每檔 `register(router, runtime)`；domain 不互相 import，只用 `runtime.store.data` 與 helpers。
- `public/**` 是多頁靜態前端；`sw.js` 管 shell cache、API GET cache、offline mutation outbox。

## CORE RULES

- API、頁面、資料必須 tenant-scoped；不得信任 client 傳入的 `tenant_id`。
- `roleRank` 只做數值排序；不得用字串等值判斷權限。
- 所有 `storeId` 查詢/變更必須過 `requireStoreScope`。
- Map row 更新需 copy 後 `.set(key, next)`；不要只改物件引用。
- 高風險 mutation 保留 `idempotencyKey`、`errorCode`、`addAudit`、manual repair 退場。
- 庫存使用 ledger movement；不得直接把 `stockOnHand` 當真相修改。
- 支付不可保存完整卡號、CVV、磁條資料或 PIN block。
- 發票、正式金流、AI 自動決策、總部、完整庫存、Benchmark 正式化前必須過 `../docs/high-risk-workstreams.md` go-gate。

## COMMANDS

```bash
npm start
npm test
npm run lint
npm run test:a11y
npm run smoke
npm run worker
npm run pg:up
npm run pg:apply
```

Windows 指定 port：`set PORT=4000 && npm start`。`npm run smoke` 需要已有 server；CI 會先啟動 server 並等 `/health`。

## FRONTEND NOTES

- `public/site.css` / `site.js` 是 shared shell；會影響 marketing、login、legal、app shell。
- `public/app.css` / `app.js` 只放工作台邏輯。
- 改 `sw.js` shell/fetch strategy 要 bump `VERSION`。
- QR、列印、topbar 規則看 `public/lib/AGENTS.md`。

## ACCEPTANCE

- API 變更：至少驗 happy path、壞輸入、重試/衝突、權限拒絕、tenant/store scope、audit row。
- 前端變更：用瀏覽器開受影響頁；desktop + mobile；POS happy path 視需要跑。
- Route contract / error code 變更：同步 `../docs/qa-matrix.md`、`../docs/error-codes.md`、相關 tests。
- Operator-facing happy path 變更：更新或跑 `scripts/smoke.js`。
