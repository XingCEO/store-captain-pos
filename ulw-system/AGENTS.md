# ulw-system AGENTS

## OVERVIEW

本檔說明 `ulw-system` 子目錄的協作規則，目標是讓後續修改可直接落地為可執行系統行為，不得成為只會看的文件。`ulw-system` 聚焦於「店長 AI POS」的 API 與前後台頁面，需同時維持離線作業能力、租戶隔離、金流/發票/庫存高風險流程與人工補救機制。

## 覆蓋範圍與不做項

本檔有效範圍：`ulw-system/src/**`、`ulw-system/public/**`、`ulw-system/package.json`、`ulw-system/data/**`。

不做項：
- 不在未讀取 `../docs/ai-engineering-rules.md` 的前提下做任何設計或實作。
- 不將 `ulw-system` 的策略外推到其他資料夾（例如 `docs/**`、`research`、`templates`）。
- 不以「等等」、「相關」、「後續補」等模糊語代替交付細節；高風險流程（電子發票、支付、個資、租戶隔離、離線一致性）不得延後。

## 先決規範（必讀）

- 主要文件仍用繁體中文。
- 技術名詞可保留英文。
- 命名/訊息一致採 `snake_case` JSON 欄位、`camelCase` JS 變數。
- 每次 AI、工程、顧問或代理人進場前，必先讀 `docs/ai-engineering-rules.md`，並在本次變更區段註明「已讀」。

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| 啟動 / route lifecycle | `src/server.js`, `src/core/router.js` | `createApp` 註冊 domains；router 處理字串 / RegExp |
| Tenant / role / audit | `src/core/runtime.js` | `requireTenant`, `requireRole`, `requireStoreScope`, `addAudit` |
| SQLite / persistence | `src/core/db.js`, `src/core/runtime.js` | Map snapshot、audit table、`persistedMaps` |
| Domain API | `src/domains/*.js` | 每檔 `register(router, runtime)` owns routes |
| 前端工作台 | `public/app.html`, `public/app.js`, `public/app.css` | POS / HUB / RISK / OPS / LIVE |
| 行銷 / 法務頁 | `public/index.html`, `public/product.html`, `public/pricing.html`, `public/terms.html`, `public/privacy.html` | 用 `site.css` / `site.js` |
| Offline / outbox | `public/sw.js`, `src/core/syncWorker.js` | SW queue + server worker |
| 測試 | `tests/`, `scripts/smoke.js` | `npm test`, `npm run smoke`, `npm run test:a11y` |

## 運作基礎架構（不可偏離）

`ulw-system` 是一個無框架單一 Node 進程：

- `src/server.js`：啟動 `http`、註冊 domain、呼叫 `runtime.store.persist()`。
- `src/core/router.js`：字串與 RegExp 路由。
- `src/core/runtime.js`：Store、錯誤格式、tenant scope、role gate、audit、idempotency。
- `src/domains/*`：每個 domain 僅透過 `runtime.store.data` 讀寫，共用 `runtime` helpers。
- `public/**`：前端頁面 + `sw.js` 離線控制。

## 核心約束（每次改動要驗證）

1. API、頁面、資料都必須 tenant-scoped。
2. `roleRank` 只允許「數值排序」比對，不得用字串等值比對角色。
3. 所有 mutation（POST/PATCH）在 `res.status < 400` 時才算成功持久化。
4. 欄位更新需先 copy 後 `set` 回 Map；不得只改物件引用。
5. 高風險路徑一定要保留 `idempotencyKey`、`errorCode`、`audit log`。
6. 服務端與 SW outbox 都要保留 `manual repair` 退場條件。
7. 離線補傳、重試、衝突回報要有可對帳輸出，不得用模糊措辭替代。

## 高風險流程清單（不能延後）

- 離線同步：本機寫入與 outbox enqueue 同 transaction 仍以現行 `persist` 與 `outbox` 設計為約束。
- 支付：記錄 `providerTransactionId`、授權欄位、金額、state。
- 電子發票：保存 `uploadState`、`lifecycleState`、金額差異與作廢/折讓。
- 庫存：使用 ledger movement，修改 `stockOnHand` 前要寫 movement。
- 租戶隔離：`storeIds` 為授權範圍，任何 `storeId` 查詢/變更都要過 `requireStoreScope`。

## 變更最小化原則

- 優先小範圍修改：`server`、`runtime`、單一 `domain`，避免同時改動前端全部頁面。
- 新增欄位前先列出 API contract（request/response）與錯誤碼。
- 禁止大規模重構；除非有對應需求與驗收條件。

## 指令與快照驗證

- 啟動：`npm start`（預設 `3100`）；Windows 用 `set PORT=4000 && npm start`，macOS/Linux 用 `PORT=4000 npm start`。
- 健康檢查：`curl http://localhost:3100/health`。
- 單元 / 整合測試：`npm test`。
- Lint：`npm run lint`。
- 無障礙檢查：`npm run test:a11y`。
- 煙測：`npm run smoke`（需已有執行中的 server）。
- 快速回歸：
  1. 有效登入：`POST /api/v1/auth/login`。
  2. 建單：`POST /api/v1/orders`（含 `idempotencyKey`）。
  3. 付款：`POST /api/v1/orders/:id/pay/manual`。
  4. 作廢：`POST /api/v1/orders/:id/void`。

## 前端協作規約

- `public/site.js`、`site.css` 只影響行銷頁；`app.js`、`app.css` 只影響 `app.html` 工作台。
- 任何 `sw.js` 版本變更都要同步升級 `VERSION`，否則用戶端會讀到舊 cache。
- 觸發列印、QR、出清畫面流程需保留現有手勢順序與同步機制。

## 審計與文件要求

- 每次提交須補上以下至少一項：
  - API 錯誤碼對照（至少 1 個），
  - 權限與資料流轉註記。
  - 人工補救動作（誰負責、何時執行、資料補回方式）。
- 不可只補「成功路徑」，必須保留一個壞輸入、一次重試/衝突、一次權限拒絕。
- 不得使用模糊詞代替明確規格。

## 共用參考（高風險）

- 請讀 `../docs/ai-engineering-rules.md`。
- 請讀上層目錄 `../README.md` 的專案定位。
- 修改前確認 `CLAUDE.md` 的 `Common pitfalls`，尤其 `store.persist` 與 SW outbox 交易邊界。

## 交付完成判定

交付完成判定必含：
1. 功能可示範執行（`npm start` + API + 前端）。
2. 錯誤分支有實際回應。
3. high-risk flow 有對應欄位與日志。
4. 本檔更新後與實際行為無明顯衝突。

## 加碼驗收（waves 1-2 之後）

1. 任何新增 mutation route 必須具備：tenant scope、numeric role rank、`addAudit`、`errorCode` 命名一致（見 `docs/error-codes.md`）、若可重送則含 idempotencyKey。
2. 任何新增 sandbox / PoC stub endpoint 必須回傳 `environment: 'sandbox'` 並設 header `x-environment: sandbox`，前端對應顯示 banner。
3. 改動完成後執行 `node scripts/smoke.js`，必須 6/6 PASS。
4. 高風險路徑（發票、金流、AI 自動決策、總部、進階庫存、Benchmark）go-gate 未開不得新增正式版本路由；只能新增 sandbox 版且依本檔規則標記。
