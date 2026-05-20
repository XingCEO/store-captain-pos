# PROJECT KNOWLEDGE BASE

**Generated:** 2026-05-19 Asia/Taipei
**Commit:** a8618a3
**Branch:** master

## OVERVIEW

本專案是「店長 AI POS」產品藍圖 + 可執行系統的混合樹。根目錄與 `docs/` 是繁體中文可執行規格；`ulw-system/` 是唯一可跑的 Node.js POS 實作。

## STRUCTURE

```text
POSstudio/
├── README.md                  # 文件入口與產品定位
├── docs/                      # 產品、架構、合規、QA、補救與研究文件
├── ulw-system/                # Node.js API + 靜態前端實作
├── ops/                       # Promtail / Grafana / logrotate 設定
├── .github/workflows/         # CI / CodeQL，實際進入 ulw-system 執行
├── qrcode-test.js             # 根目錄 QR ad hoc 測試腳本
└── test-qr.cjs                # 根目錄 QR decode ad hoc 測試腳本
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| 專案定位、文件導覽 | `README.md` | 先讀；理解店型與 MVP 焦點 |
| 任何進場規則 | `docs/ai-engineering-rules.md` | 必讀；缺驗收方式即未完成 |
| 產品範圍與價格 | `docs/product-plan.md` | 小店先成交；不要第一版全產業 |
| 系統架構、離線同步 | `docs/architecture.md` | Offline-first、Outbox、Idempotency、Tenant |
| 合規邊界 | `docs/compliance-guardrails.md` | 發票、支付、個資、多租戶 |
| 高風險 gate | `docs/high-risk-workstreams.md` | 未過 gate 不得正式開工 |
| 工程票務模板 | `docs/implementation-kickoff-tickets.md` | Sprint 0-2 直接可拆票規格 |
| API 錯誤碼 | `docs/error-codes.md` | 新 errorCode 先查此檔 |
| QA 覆蓋矩陣 | `docs/qa-matrix.md` | 路由 × happy/bad/conflict/permission |
| 人工補救 | `docs/manual-repair-playbook.md` | dead-letter / exception 誰補、何時補、怎麼補 |
| 可執行系統 | `ulw-system/` | 先讀 `ulw-system/AGENTS.md` 與 `ulw-system/CLAUDE.md` |
| Runtime / persistence / auth kernel | `ulw-system/src/core/` | 讀 `ulw-system/src/core/AGENTS.md` |
| API business domains | `ulw-system/src/domains/` | 讀 `ulw-system/src/domains/AGENTS.md` |
| 前端頁面 / Service Worker | `ulw-system/public/` | 讀 `ulw-system/public/AGENTS.md` |
| 測試與 QA gate | `ulw-system/tests/`, `ulw-system/scripts/smoke.js` | 讀 `ulw-system/tests/AGENTS.md` |
| 維運 / 觀測設定 | `ops/` | Promtail、Grafana alerts、logrotate；不屬 app runtime |

## CODE MAP

| Symbol / Surface | Type | Location | Role |
|------------------|------|----------|------|
| `createApp` | function | `ulw-system/src/server.js` | 啟動 HTTP、runtime、router、domain、background worker |
| `createRuntime` | function | `ulw-system/src/core/runtime.js` | Store、tenant、role、audit、idempotency、static serving |
| `Store` | class | `ulw-system/src/core/runtime.js` | SQLite-backed maps、snapshot、audit buffer、persist |
| `createRouter` | function | `ulw-system/src/core/router.js` | 字串 / RegExp route dispatch |
| `identity.register` | domain | `ulw-system/src/domains/identity.js` | auth、session、users、audit logs、store settings |
| `subscription.register` | domain | `ulw-system/src/domains/subscription.js` | plan change、cancel、entitlements、capacity limits |
| `catalog.register` | domain | `ulw-system/src/domains/catalog.js` | products、SKUs、prices、imports |
| `commerce.register` | domain | `ulw-system/src/domains/commerce.js` | orders、payments、refunds、voids、invoice creation helper |
| `operations.register` | domain | `ulw-system/src/domains/operations.js` | order hub、KDS、cash drawer、inventory、channels |
| `risk.register` | domain | `ulw-system/src/domains/risk.js` | invoice workflows、reports、exports、telemetry、AI brief、sync jobs |
| `src/core/syncWorker.js` | worker engine | `ulw-system/src/core/syncWorker.js` | outbox、telemetry stale、draft expiry、dead-letter |
| `scripts/smoke.js` | runtime QA | `ulw-system/scripts/smoke.js` | live-server smoke gate |

## CONVENTIONS

- 主要文件用繁體中文；技術名詞可保留 `Offline-first`、`Outbox`、`Idempotency`、`Tenant`。
- Agent 回覆預設最小化：先結論、少敘述、無寒暄；只列必要證據、驗證、下一步。
- 對外文案要讓店家看懂，不只寫工程術語。
- 文件是可執行規格，不是願景稿。每個功能要標示目的、使用者、風險、階段、驗收方式。
- 市場價格、法規、第三方 API 必須註明來源與查證日期；不確定放「待確認」或「風險」。
- JSON 欄位用 `snake_case`；JavaScript identifiers 用 `camelCase`。
- API ticket 至少要有 happy path、壞輸入、重試/衝突、權限拒絕。
- 新增 errorCode 前先查 `docs/error-codes.md`；命名用 `SCREAMING_SNAKE_CASE`。

## ANTI-PATTERNS (THIS PROJECT)

- 不得用「等等」、「之類」、「相關」、「視情況」、「後續補」替代明確規格。
- 不得把電子發票、支付、個資、多租戶隔離、資安、資料一致性寫成「未來優化」。
- 不得跳過 Offline-first、idempotency、tenant scope、audit log、錯誤處理、人工補救流程。
- 不得信任 client 傳入的 `tenant_id`；tenant context 必須由 session / API key / device credential 推導。
- 不得用 local SQLite 直接覆蓋 cloud PostgreSQL 做 CRUD 同步；同步必須 append / replay + outbox。
- POS 不保存完整卡號、CVV、磁條資料或 PIN block。
- AI MVP 不自動下單、自動改價、自動發促銷；只能摘要、異常提醒、可審核建議。
- 高風險工作（正式發票、正式金流、AI 自動決策、總部、完整庫存、Benchmark）未過 go/no-go gate 不得正式開工。

## COMMANDS

```bash
cd ulw-system
npm start
npm test
npm run lint
npm run smoke
npm run test:a11y
npm run worker
npm run pg:up
npm run pg:apply
```

Windows 啟動指定 port：`set PORT=4000 && npm start`。根目錄沒有 `package.json`；所有 app 命令都在 `ulw-system/`。`npm run smoke` 需要已有執行中的 server。

## NOTES

- 這不是純 docs repo：`docs/` 是規格，`ulw-system/` 是可執行實作，兩者要對齊但不可混用規則。
- `ulw-system/CLAUDE.md` 可能記錄過期命令；以 `ulw-system/package.json` 的 scripts 為準。
- `.omc/`、`.omx/`、`.playwright-mcp/`、`.sisyphus/` 是工具/狀態目錄；不要把其內容當產品規格。
- `ulw-system/data/pg/**` 是 embedded Postgres 產物；不要為其產生文件或手動整理。
- `ulw-system/migrations/*.sql` 是 DB / RLS 邊界；`migrations/meta/**` 是 Drizzle 產物，不手寫、不當產品規格。
- `ulw-system/topbar-shots/`、根目錄 `test-*.png`、`*.log` 是驗證/截圖/紀錄產物；除非任務指明，不當規格來源。
- 文件型交付也要驗收：README 連結、範圍、不做項、go/no-go gate、待確認人與問題。
