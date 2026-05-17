# 工程進場啟動清單（Sprint 0-1）

目標：依 `AGENTS.md`、`docs/ai-engineering-rules.md`、`docs/architecture.md`、`docs/high-risk-workstreams.md` 進場，先完成可交付 MVP（不碰高風險未放行功能）。

## 進場前硬檢

1. 工程、AI、顧問在任一會議前先完成 `docs/ai-engineering-rules.md` 閱讀簽到。
2. 只接受以下範圍：
   - 收銀前台、商品/菜單、訂單、現金收款、線上接單基礎、簡易報表、離線 outbox。
   - 不做：正式電子發票上線、支付刷卡正式串接、AI 自動決策、連鎖總部控制中心。
3. `high-risk` 先行維持封鎖，除非對應 workstream 的 go gate 已全部打勾。
4. 每張票務都必需符合 `docs/ai-engineering-rules.md` 的 9 欄位：背景、目標、不做範圍、資料表/API/畫面、狀態與錯誤、權限與租戶隔離、稽核與監控、測試案例、手動 QA、上線/回滾、待確認事項。

## Sprint 0（第 1-2 週）：基礎資料面與交易事件一致性

### T0-01 本機交易交易模型 + outbox（P0）

- 背景：POS 現場要能在斷網仍完整完成點餐到付款前狀態收斂。
- 目標：建立 `orders`、`order_items`、`order_events` 本機資料模型與出庫前後一致的 outbox 工作列。
- 使用者：收銀員、店長。
- 風險：交易重複建立、草稿資料未對帳、離線回補失敗。
- 不做範圍：不含雲端稅務計算、支付 gateway callback。
- 資料表/API/畫面：
  - 資料表：`orders`, `order_items`, `order_events`, `outbox_jobs`。
  - API：`POST /api/v1/orders`, `GET /api/v1/orders/{id}`, `GET /api/v1/orders/{id}/events`。
  - 畫面：收銀首頁下單流程、草稿單清單、待同步指示。
- 狀態與錯誤：
  - 狀態：`DRAFT`、`CONFIRMED`、`PENDING_SYNC`、`SYNCED`、`VOIDED`。
  - 錯誤：`ORDER_IDEMPOTENCY_CONFLICT`, `ORDER_ITEM_INVALID`, `OUTBOX_WRITE_FAILED`。
- 權限與租戶隔離：
  - 以登入 session 衍生 `tenant_id`；查詢與寫入皆加 `tenant_id` 條件。
  - 僅 `CASHIER`、`MANAGER` 可建立/作廢。
- 稽核與監控：
  - `audit_logs` 記錄 `actor`, `tenant_id`, `action`, `resource_id`, `before`, `after`, `ip`, `device_id`。
  - 監控指標：本機未同步筆數、outbox 逾時比例。
- 測試案例：
  - happy path：正常建立 3 項商品交易。
  - 壞輸入：商品單價小於 0、同一明細缺少 `skuId`。
  - 外部失敗：無雲端回應仍維持 `PENDING_SYNC`。
- 手動 QA：
  - 手機/平板斷網後完成點餐並離場，恢復後確認有回補。
- 上線/回滾：
  - 上線門檻：無 duplicate outbox job，同步狀態不會跳過資料。
  - 回滾：移除 local migration、停用 outbox worker，僅保留本機離線交易草稿。
- 待確認事項：
  - `order_number` 格式與是否跨店不重複。

### T0-02 outbox 同步 worker（P0）

- 背景：本機訂單需同步到雲端並保留去重結果。
- 目標：實作同步排程、重試、dead letter 與告警。
- 使用者：收銀員、店長、客服。
- 風險：重試風暴、silent drop、死信無法處理。
- 不做範圍：不做跨服務串接（僅同步 `orders` 與 `order_events`）。
- 資料表/API/畫面：
  - 資料表：`outbox_jobs`, `sync_retries`。
  - API：`POST /api/v1/sync/jobs/{id}/retry`, `GET /api/v1/sync/jobs`。
- 狀態與錯誤：
  - 狀態：`PENDING`, `IN_FLIGHT`, `RETRYABLE_ERROR`, `DEAD_LETTER`。
  - 錯誤：`IDEMPOTENCY_KEY_MISMATCH`, `PAYLOAD_FINGERPRINT_MISMATCH`, `SYNC_TIMEOUT`, `RETRY_LIMIT_EXCEEDED`。
- 權限與租戶隔離：
  - 同步 worker 僅接受簽章 token 與固定 `tenant_id` 映射。
  - 管理 API 僅 `SUPERVISOR`。
- 稽核與監控：
  - `audit_logs` 記錄每次重試與死信輸入。
  - 監控：dead letter 成功率、平均重試次數。
- 測試案例：
  - happy path：一次提交後狀態變為 `SYNCED`。
  - 壞輸入：`tenant_id` 違規時不得同步。
  - 外部失敗：API timeout，進入 `RETRYABLE_ERROR`，超過 3 次轉 `DEAD_LETTER`。
- 手動 QA：
  - 模擬網路中斷 30 分鐘後，確認 worker 續傳。
- 上線/回滾：
  - 上線門檻：payload fingerprint 一致性檢查通過。
  - 回滾：停掉 worker，改由人工匯出待同步檔。
- 待確認事項：
  - 同步批次大小、重試退避上限。

## Sprint 1（第 3-4 週）：前台流程與基礎報表

### T1-01 POS 前台核心 UI（P0）

- 背景：店員至少要有可用最小操作流程。
- 目標：完成商品列表、購物車、付款方式（現金/待結帳）、出單列印基礎流程。
- 使用者：收銀員、店員、店長。
- 風險：高峰時操作超時、列印失敗但付款已完成無追溯。
- 不做範圍：付款刷卡正式授權、複雜促銷規則。
- 資料表/API/畫面：
  - 畫面：POS 首頁、商品搜尋、購物車、結帳面板、收據預覽。
  - API：`GET /api/v1/products`, `POST /api/v1/orders/{id}/pay/manual`, `POST /api/v1/orders/{id}/void`。
- 狀態與錯誤：
  - 狀態：`OPEN_CART`, `READY_TO_CHECKOUT`, `PAID_CASH`, `PAID_PENDING`, `VOIDED`。
  - 錯誤：`CART_EMPTY`, `PRODUCT_NOT_FOUND`, `CHECKOUT_WINDOW_EXPIRED`, `VOID_NOT_ALLOWED`。
- 權限與租戶隔離：
  - 收銀 UI 限同店角色。
  - 只可讀取同 `tenant_id` 商品與訂單。
- 稽核與監控：
  - 每次列印、作廢、現金付款變更入 `audit_logs`。
- 測試案例：
  - happy path：3 行商品 + 現金結帳。
  - 壞輸入：付款前選擇空購物車。
  - 外部失敗：列印機離線，顯示待列印列隊。
- 手動 QA：
  - 店員 10 分鐘操作測試（新手上手）。
- 上線/回滾：
  - 上線門檻：結帳全程可回滾為草稿。
  - 回滾：暫停收銀頁面切到「維護模式」，保留本機草稿。
- 待確認事項：
  - 客製選項層數限制（目前先 2 層）。

### T1-02 訂單來源整合（QR/電話）

- 背景：現場和線上單需集中顯示。
- 目標：整合 `ORDER_HUB` 來源模型，保留來源與製作狀態。
- 使用者：店長、客服、店員。
- 風險：重複進單、來源欄位不完整造成漏單。
- 不做範圍：外送平台 webhook、外部外掛認證。
- 資料表/API/畫面：
  - 資料表：`order_sources`, `order_items`（新增 `source` 欄位）。
  - API：`POST /api/v1/order-sources/manual`, `GET /api/v1/order-hub`。
- 狀態與錯誤：
  - 狀態：`NEW`, `IN_PROGRESS`, `READY`, `DONE`。
  - 錯誤：`SOURCE_CHANNEL_UNKNOWN`, `MISSING_REFERENCE_ID`, `SOURCE_DUPLICATE`。
- 權限與租戶隔離：
  - 來源資料僅可透過租戶內角色讀取。
- 稽核與監控：
  - 記錄來源導入時間、原始 ref id、導入人。
- 測試案例：
  - happy path：QR/電話/manual 三種類型進單。
  - 外部失敗：來源資料欄位缺失，標記為 `REJECTED`。
- 手動 QA：
  - 一組測試電話單與 QR 單同時建立後，不可重複出單。
- 上線/回滾：
  - 上線門檻：重複單需可阻擋。
  - 回滾：保留 `source` 欄位但停用聚合 endpoint。
- 待確認事項：
  - 外部 LINE/QR token 來源與到期政策。

### T1-03 現金對帳與開班交班

- 背景：避免現金漏盤與客服爭議。
- 目標：實作開班現金、當班明細、交班回報雛形。
- 使用者：店長、櫃檯主管、會計。
- 風險：現金缺口未揭露、補差流程不合規。
- 不做範圍：多日補班與多據點匯總。
- 資料表/API/畫面：
  - 資料表：`cash_drawers`, `cash_movements`, `settlement_batches`。
  - API：`POST /api/v1/cash-drawers/open`, `POST /api/v1/cash-drawers/close`, `GET /api/v1/cash-drawers/{id}/report`。
- 狀態與錯誤：
  - 狀態：`OPEN`, `IN_PROGRESS`, `CLOSED`。
  - 錯誤：`CASHBOX_ALREADY_OPEN`, `CASH_SHORTFALL`, `DRAWER_NOT_FOUND`。
- 權限與租戶隔離：
  - 只開放 `SUPERVISOR` 開關鈔櫃。
- 稽核與監控：
  - 交班時間戳、現金差額、簽核者入 audit。
- 測試案例：
  - happy path：開班 -> 收款 -> 結案。
  - 壞輸入：重複關帳。
- 手動 QA：
  - 交班差異可人工調整，但必須留下備註與簽核。
- 上線/回滾：
  - 上線門檻：差額為零才能結帳完成。
  - 回滾：禁止交班動作，保留只讀模式。
- 待確認事項：
  - 現金差額處理責任人與補差流程。

### T1-04 基礎 KPI 報表（P1）

- 背景：管理層需要最小可讀報表。
- 目標：建立日營收、付款方式、商品排行彙總。
- 使用者：店長、營運管理者。
- 風險：報表口徑與出納口徑不一致。
- 不做範圍：毛利、多店合併。
- 資料表/API/畫面：
  - API：`GET /api/v1/reports/daily`, `GET /api/v1/reports/payment-breakdown`, `GET /api/v1/reports/top-products`。
- 狀態與錯誤：
  - 錯誤：`TENANT_NOT_READY`, `DATE_RANGE_INVALID`。
- 權限與租戶隔離：
  - 僅 `MANAGER` 可看所有門市日報。
- 稽核與監控：
  - 報表查詢 log，含時間區間與條件。
- 測試案例：
  - happy path：單日有 10 筆訂單可輸出 3 張報表。
  - 外部失敗：資料庫延遲，回傳 `503` 並提示重試。
- 手動 QA：
  - 用同一日現金與刷卡交易，核對加總與原始訂單。
- 上線/回滾：
  - 上線門檻：報表欄位與來源欄位一致。
  - 回滾：停用 dashboard 小部件，保留 API。
- 待確認事項：
  - 是否要加入會員欄位與發票欄位。

## 風險標註（高風險模組封鎖）

- `E-INVOICE`、正式金流、AI 自動決策、連鎖總部、複雜進銷存、Benchmark 任何票務不得啟動。
- 啟動條件：對應工作流在 `docs/high-risk-workstreams.md` 的 go gate 全部完成。

## Sprint 0-1 工程排程與角色分工

### 角色

- PM：確認需求邊界、驗收清單、優先順序、依賴關係。
- 工程（FE/BE）：完成欄位級規格、API、DB、UI、同步邏輯。
- QA：撰寫並執行驗收腳本、人工 QA、回歸用例。
- 法遵（或顧問）：檢查高風險欄位、個資、租戶隔離、audit、對帳規格。

### Sprint 0 票務板（第 1-2 週）

| 票務 | 角色分工 | 依賴 | 主要交付 | 風險 gate |
| --- | --- | --- | --- | --- |
| T0-01 本機交易交易模型 + outbox（P0） | PM 1h，工程 2 人日，QA 0.5 人日，法遵 0.5 人日 | 基礎資料模型、離線交易原則 | `orders`、`order_items`、`order_events`、`outbox_jobs` migration + `POST /api/v1/orders` 實作 | 本機寫入與 outbox 同 transaction；tenant scope 不可信任 client |
| T0-02 outbox 同步 worker（P0） | PM 0.5h，工程 2 人日，QA 1 人日，法遵 0.5 人日 | T0-01 完成，worker 環境準備 | `sync_jobs` worker、`POST /api/v1/sync/jobs/{id}/retry`、`GET /api/v1/sync/jobs` | 重試策略、dead letter、人工補救有警報 |

### Sprint 1 票務板（第 3-4 週）

| 票務 | 角色分工 | 依賴 | 主要交付 | 風險 gate |
| --- | --- | --- | --- | --- |
| T1-01 POS 前台核心 UI（P0） | PM 1h，工程 FE 2 人日，QA 1 人日，法遵 0.5 人日 | T0-01、T0-02 完成，設備測試清單 | 商品清單、購物車、結帳、列印與待列印列隊 | 現場操作超時 < 3 秒，列印失敗可重打 |
| T1-02 訂單來源整合（QR/電話） | PM 1h，工程 1.5 人日，QA 1 人日，法遵 0.5 人日 | T0-01、T0-02 完成 | `order_sources`、`order-hub` endpoint、重複進單阻擋 | 來源欄位缺失會標記 rejected 並可人工放行 |
| T1-03 現金對帳與開班交班（P1） | PM 1h，工程 1.5 人日，QA 1 人日，法遵 0.5 人日 | T0-01 完成、T1-01 完成 | `cash_drawers`、`cash_movements`、`settlement_batches`，交班報表 | 差額不可隱匿，補差需審核紀錄 |
| T1-04 基礎 KPI 報表（P1） | PM 0.5h，工程 1 人日，QA 1 人日，法遵 0.5 人日 | T0-01、T1-01、T1-03 完成 | 日營收、付款方式、商品排行 API 與 Dashboard widget | 報表口徑與付款口徑一致 |

### 跨工時節點（建議）

- D1：完成 `T0-01` 寫入 + outbox 同步基礎框架。
- D3：完成 `T0-02` Worker，具備手動重試與 dead letter 清單。
- D5：完成 `T1-01`，進行第一輪操作壓力測試。
- D7：完成 `T1-02`，執行來源合併驗收。
- D9：完成 `T1-03`，跑一次交班流程 dry-run。
- D12：完成 `T1-04`，以同一日資料比對三份報表。

### 會議與交付節奏

- 每日 15 分鐘：前日進度、當日風險。
- 兩天一次：PM 同步 `待確認事項`，法遵只在 high-risk 欄位簽核。
- 每個票務結束：PM 走「驗收腳本」+ QA 手動 QA 紀錄 + 監控項驗證。

## P0-P1 主要票務欄位級別規格（直接開發）

### T0-01 本機交易交易模型 + outbox（P0）

#### API：`POST /api/v1/orders`

請求（body）：

```json
{
  "clientRef": "string",
  "storeId": "uuid",
  "terminalId": "uuid",
  "businessDate": "2026-05-14",
  "customerTag": "string | null",
  "items": [
    {
      "productId": "uuid",
      "skuId": "uuid",
      "name": "string",
      "qty": 2,
      "unitPrice": 120,
      "discountAmount": 0
    }
  ],
  "notes": "string | null",
  "idempotencyKey": "string"
}
```

回應（201）：

```json
{
  "id": "uuid",
  "orderNumber": "string",
  "state": "DRAFT",
  "currency": "TWD",
  "subtotal": 240,
  "discountTotal": 0,
  "taxTotal": 0,
  "grandTotal": 240,
  "createdAt": "2026-05-14T08:20:00.000Z",
  "sync": {
    "jobId": "uuid",
    "state": "PENDING"
  }
}
```

請求 header：

- `Idempotency-Key`（必填，字串）
- `If-Match`（可選，針對重送保護）

錯誤碼：

- `ORDER_IDEMPOTENCY_CONFLICT`：同一 `Idempotency-Key` 已存在且 payload 不一致。
- `ORDER_ITEM_INVALID`：數量 <= 0、單價 < 0、`skuId` 不存在。
- `OUTBOX_WRITE_FAILED`：交易與 outbox 在同 transaction 寫入失敗。

租戶規則：

- `tenant_id` 僅自 `Authorization` token 推導。
- 任何 `storeId`、`terminalId` 查詢以 tenant-scoped index 驗證歸屬。
- response 不可回傳其他租戶訂單。

Rollback：

- 保留 `orders` 與 `order_items` migration，清除 `outbox_jobs` pending；前端僅保留草稿單。
- 需要回復到「可作業但不可同步」模式時，停用 outbox worker、將 `order.state = DRAFT`。

#### API：`GET /api/v1/orders/{id}`

回應欄位：

```json
{
  "id": "uuid",
  "tenantId": "uuid",
  "storeId": "uuid",
  "terminalId": "uuid",
  "orderNumber": "string",
  "state": "DRAFT|CONFIRMED|PENDING_SYNC|SYNCED|VOIDED",
  "items": [
    {
      "id": "uuid",
      "productId": "uuid",
      "skuId": "uuid",
      "name": "string",
      "qty": 2,
      "unitPrice": 120,
      "subtotal": 240
    }
  ],
  "createdBy": "uuid",
  "createdAt": "2026-05-14T08:20:00.000Z",
  "updatedAt": "2026-05-14T08:20:00.000Z",
  "lastSyncAt": null,
  "outbox": {
    "jobId": "uuid",
    "state": "PENDING|IN_PROGRESS|RETRYABLE_ERROR|DONE"
  }
}
```

#### API：`GET /api/v1/orders/{id}/events`

回應欄位：

```json
{
  "orderId": "uuid",
  "events": [
    {
      "eventType": "ORDER_CREATED|ORDER_CONFIRMED|ORDER_VOIDED",
      "actorId": "uuid",
      "at": "2026-05-14T08:20:00.000Z",
      "payloadFingerprint": "sha256...",
      "meta": {}
    }
  ]
}
```

### T0-02 outbox 同步 worker（P0）

#### API：`POST /api/v1/sync/jobs/{id}/retry`

請求：

```json
{
  "reason": "MANUAL_RETRY|NETWORK_RECOVERY|DEAD_LETTER_UNBLOCK",
  "requestedBy": "uuid"
}
```

回應：

```json
{
  "id": "uuid",
  "state": "PENDING",
  "retryCount": 1,
  "lastRetryAt": null,
  "nextRetryAt": "2026-05-14T08:25:00.000Z"
}
```

#### API：`GET /api/v1/sync/jobs`

查詢參數：

- `tenantId` 不得輸入；使用 `tenant context`
- `state`: `PENDING|IN_PROGRESS|RETRYABLE_ERROR|DONE|DEAD_LETTER`
- `from`, `to`：時間區間
- `page`, `pageSize`

回應欄位：

```json
{
  "items": [
    {
      "id": "uuid",
      "resourceType": "order|order_event",
      "resourceId": "uuid",
      "state": "DEAD_LETTER",
      "attempts": 4,
      "lastErrorCode": "RETRY_LIMIT_EXCEEDED",
      "lastErrorMessage": "message",
      "createdAt": "2026-05-14T08:00:00.000Z",
      "updatedAt": "2026-05-14T08:10:00.000Z"
    }
  ],
  "nextPageToken": "opaque-token"
}
```

錯誤碼：

- `IDEMPOTENCY_KEY_MISMATCH`
- `PAYLOAD_FINGERPRINT_MISMATCH`
- `SYNC_TIMEOUT`
- `RETRY_LIMIT_EXCEEDED`

租戶規則：

- worker 只能使用管理 token 發起；`tenant_id` 來源是 worker 入口映射。
- API 僅查詢當前租戶可見 job；跨 tenant 查詢直接拒絕 `403`。

Rollback：

- 暫停 worker schedule，保留 dead letter 匯出；客服可透過人工重放腳本回補。

### T1-01 POS 前台核心 UI（P0）

#### API：`POST /api/v1/orders/{id}/pay/manual`

請求：

```json
{
  "orderId": "uuid",
  "paymentMethod": "CASH",
  "amount": 240,
  "cashReceived": 300,
  "rounding": 0,
  "tenderChange": 60,
  "cashierMemo": "開立補充說明"
}
```

回應：

```json
{
  "orderId": "uuid",
  "state": "PAID_CASH",
  "paymentSummary": {
    "method": "CASH",
    "amount": 240,
    "received": 300,
    "change": 60
  },
  "printQueueId": "uuid"
}
```

#### API：`POST /api/v1/orders/{id}/void`

請求：

```json
{
  "orderId": "uuid",
  "reasonCode": "CUST_CANCEL|INPUT_ERROR|VOID_AFTER_PRINT",
  "actorPin": "4-digit",
  "note": "string"
}
```

錯誤碼：

- `CART_EMPTY`
- `PRODUCT_NOT_FOUND`
- `CHECKOUT_WINDOW_EXPIRED`
- `VOID_NOT_ALLOWED`

租戶規則：

- 開單、作廢、列印只允許同店角色。
- 每筆作廢寫 `audit_logs`：`actorId`, `role`, `deviceId`, `tenantId`, `ipAddress`。

Rollback：

- 付款頁面保留「回到草稿」機制；列印失敗可退回至 `PAID_PENDING` 並標記 `pendingPrint`。

#### API 回應欄位（前台共用）

```json
{
  "orderSummary": {
    "items": [],
    "tax": 0,
    "subtotal": 240,
    "discount": 0,
    "grandTotal": 240,
    "state": "OPEN_CART|READY_TO_CHECKOUT|PAID_CASH|PAID_PENDING|VOIDED"
  },
  "print": {
    "status": "queued|success|failed",
    "queueId": "uuid"
  }
}
```

### T1-02 訂單來源整合（QR/電話）

#### API：`POST /api/v1/order-sources/manual`

請求：

```json
{
  "tenantStoreId": "uuid",
  "channel": "QR|PHONE|POS|LINE|WEB",
  "externalReferenceId": "string",
  "customerName": "string | null",
  "phone": "09xx",
  "items": [
    {
      "productId": "uuid",
      "skuId": "uuid",
      "qty": 1,
      "price": 65,
      "notes": "少冰"
    }
  ],
  "pickedTime": "2026-05-14T08:20:00.000Z",
  "dueTime": "2026-05-14T08:30:00.000Z"
}
```

回應：

```json
{
  "sourceId": "uuid",
  "orderId": "uuid",
  "normalizedChannel": "QR",
  "state": "NEW",
  "dupCheck": {
    "isDuplicate": false,
    "existingOrderId": null
  }
}
```

#### API：`GET /api/v1/order-hub`

查詢參數：

- `status=NEW|IN_PROGRESS|READY|DONE`
- `source=QR|PHONE|POS|LINE|WEB`
- `from`, `to`
- `storeId`

回應欄位：

```json
{
  "items": [
    {
      "orderId": "uuid",
      "source": "PHONE",
      "sourceRef": "string",
      "state": "READY",
      "lineItemCount": 2,
      "createdAt": "2026-05-14T08:15:00.000Z"
    }
  ],
  "nextCursor": "opaque-token"
}
```

錯誤碼：

- `SOURCE_CHANNEL_UNKNOWN`
- `MISSING_REFERENCE_ID`
- `SOURCE_DUPLICATE`

租戶規則：

- `externalReferenceId` 以來源+租戶上下文判斷去重；不可跨店共用。
- `source` 欄位不保留顧客敏感資料，僅保留必要最少欄位。

Rollback：

- 停用 `order-hub` 聚合欄位仍保留 `order_sources`；手動頁面可直接依 source 建單。

### T1-03 現金對帳與開班交班

#### API：`POST /api/v1/cash-drawers/open`

請求：

```json
{
  "storeId": "uuid",
  "terminalId": "uuid",
  "expectedOpeningCash": 0,
  "openedBy": "uuid",
  "note": "string"
}
```

回應：

```json
{
  "cashDrawerId": "uuid",
  "state": "OPEN",
  "openedAt": "2026-05-14T07:00:00.000Z"
}
```

#### API：`POST /api/v1/cash-drawers/close`

請求：

```json
{
  "cashDrawerId": "uuid",
  "closingCash": 1000,
  "countedBy": "uuid",
  "note": "string",
  "adjustments": [
    {
      "type": "MANUAL_ADJUST|SHORTFALL|OVERAGE",
      "amount": 50,
      "reason": "找零異常"
    }
  ]
}
```

回應：

```json
{
  "cashDrawerId": "uuid",
  "state": "CLOSED",
  "cashVariance": -50,
  "auditId": "uuid",
  "reportUrl": "/api/v1/cash-drawers/uuid/report"
}
```

#### API：`GET /api/v1/cash-drawers/{id}/report`

回應欄位：

```json
{
  "cashDrawerId": "uuid",
  "period": {
    "openedAt": "2026-05-14T07:00:00.000Z",
    "closedAt": "2026-05-14T23:00:00.000Z"
  },
  "openingCash": 0,
  "closingCash": 1000,
  "variance": -50,
  "movements": [],
  "signoffs": {
    "cashierId": "uuid",
    "supervisorId": "uuid|null"
  }
}
```

錯誤碼：

- `CASHBOX_ALREADY_OPEN`
- `CASH_SHORTFALL`
- `DRAWER_NOT_FOUND`

租戶規則：

- 開班/交班只接受店內角色與 `tenant context`；跨店帳務查詢必須另行授權。
- 所有現金調整需記 `audit_logs` 並保留簽核人。

Rollback：

- 關帳失敗時保留 `CLOSED` 草稿狀態；需主管簽核才可過帳。

### T1-04 基礎 KPI 報表（P1）

#### API：`GET /api/v1/reports/daily`

查詢：

- `date=YYYY-MM-DD`（必填）
- `storeId`（選填，預設全部店）
- `timezone`（選填）

回應：

```json
{
  "date": "2026-05-14",
  "storeId": "uuid",
  "totals": {
    "revenue": 10240,
    "orderCount": 52,
    "lineItemCount": 178
  },
  "payments": [
    {
      "method": "CASH|CARD|QR",
      "count": 10,
      "amount": 2000
    }
  ],
  "exceptions": {
    "syncLagOrderCount": 2,
    "printFailCount": 1
  }
}
```

#### API：`GET /api/v1/reports/payment-breakdown`

查詢：

- `from`, `to`
- `storeId`
- `groupBy`: `DAY|WEEK|MONTH`

回應：

```json
{
  "rows": [
    {
      "date": "2026-05-14",
      "method": "CASH",
      "orderAmount": 1200,
      "orderCount": 24
    }
  ],
  "total": {
    "amount": 10240,
    "transactions": 58
  }
}
```

#### API：`GET /api/v1/reports/top-products`

查詢：

- `from`, `to`
- `storeId`
- `limit`（1-50）

回應：

```json
{
  "items": [
    {
      "productId": "uuid",
      "skuId": "uuid",
      "name": "奶茶",
      "soldQty": 120,
      "grossAmount": 4800,
      "netAmount": 4200
    }
  ]
}
```

錯誤碼：

- `TENANT_NOT_READY`
- `DATE_RANGE_INVALID`

租戶規則：

- 報表查詢只允許同租戶店號；若用 `storeId` 超出 tenant 範圍，回 `403`。
- 匯出需加上 `tenantId` 與角色條件，避免混用。

Rollback：

- Dashboard 小部件可關閉；API 保留只讀查詢供審核與故障回溯。

### 待確認項（欄位級）

- `order_number` 是否需跨店全域唯一：若要，請補 `tenantId` 外加序列化前綴。
- `print_queue_id` 失效時，是否需保留 7 天或 30 天的列印 payload。
- `cash_drawers` 是否需支援多錢櫃同店並行。
- `order-hub` 的 `sourceRef` 異常長度與字元集，請指定正則與長度上限。

## Sprint 2（第 5-8 週）：MVP 補完

### T2-01 商品與菜單管理後台（P0）

- 背景：Sprint 1 有收銀與報表，但菜單維運仍不足，店務人員換價、停售、客製群組仍需跨店一致操作。
- 目標：完成可發佈、可停用、可審核版本的商品、SKU、分類、客製選項管理。
- 使用者：店長、總部營運、總部採購（視方案可見欄位）。
- 風險：定價錯誤或不可回溯變更造成營收口徑偏差。
- 不做範圍：進階會員價、跨店自動同步規則、複雜組合促銷。
- 資料表/API/畫面：
  - 資料表：`products`, `categories`, `skus`, `modifier_groups`, `modifiers`, `product_prices`, `product_publish_queue`。
  - API：
    - `POST /api/v1/catalog/products`
    - `PATCH /api/v1/catalog/products/{productId}`
    - `POST /api/v1/catalog/prices/batch`
    - `GET /api/v1/catalog/menus/published`
  - 畫面：商品清單、分類排序、SKU 明細、客製群組、版本草稿與發佈確認。
- 狀態與錯誤：
  - 狀態：`DRAFT`, `PUBLISHED`, `DELISTED`。
  - 錯誤：`PRODUCT_NAME_DUPLICATE`, `CATEGORY_NOT_FOUND`, `PRICE_OUT_OF_RANGE`, `MODIFIER_RULE_INVALID`, `PUBLISH_CONFLICT`。
- 權限與租戶隔離：
  - 僅 `MANAGER+` 可編輯，`SUPERVISOR` 可審核發佈。
  - `price_books`、`skus` 查詢必加 `tenant_id` 與 `store_visibility` 過濾。
  - 切換店別只能看該租戶可見店。
- 稽核與監控：
  - `audit_logs` 記錄 `productId`, `skuId`, `actorId`, `oldPrice`, `newPrice`, `publishReason`。
  - 監控：`product_publish_fail`, `price_drift_ratio`, `menu_sync_lag`。
- 測試案例：
  - happy path：草稿新增商品、編輯價格、發佈到指定店。
  - 壞輸入：缺少 `categoryId` 時拒絕建立。
  - 外部失敗：審核後發佈同時間再次發佈，回 `409`。
- 手動 QA：
  - 同一商品分別調整價格與停售，店長端 5 分鐘內同步可見。
- 上線/回滾：
  - 上線門檻：每筆價目修改留存版本並可回放。
  - 回滾：鎖定上一次 `PUBLISHED` 版本，撤回草稿，暫停同步。
- 待確認事項：
  - `price_books` 是否先開啟跨店共用。

### T2-02 線上點餐（QR/LINE）前台（P0）

- 背景：既有 `order-hub` 有來源整合，但缺少線上入口可直接下單、付款狀態回寫與到店流程。
- 目標：建立 QR 與 LINE 的可用下單/付款追蹤入口，輸出到 `order-hub`。
- 使用者：顧客、店員、店長。
- 風險：重複扣單、付款未知狀態、來源欄位缺失。
- 不做範圍：外送平台雙向 webhook、匿名追蹤 cookie 分析。
- 資料表/API/畫面：
  - 資料表：`online_channels`, `channel_orders`, `order_sources`。
  - API：
    - `POST /api/v1/channels/qr/orders`
    - `POST /api/v1/channels/line/orders`
    - `GET /api/v1/channels/orders/{id}`
    - `PATCH /api/v1/channels/orders/{id}/status`
  - 畫面：QR menu 鏈接頁、LINE 下單卡片/簡易結帳、客製項目選擇。
- 狀態與錯誤：
  - 狀態：`CREATED`, `CONFIRMED`, `CANCELLED`, `EXPIRED`。
  - 錯誤：`CHANNEL_AUTH_FAILED`, `SOURCE_ITEM_CLOSED`, `DUPLICATE_CHANNEL_ORDER`, `PAYMENT_UNKNOWN`。
- 權限與租戶隔離：
  - 來自外部的 `storeSlug` 與 `tenant token` 做雙重查詢；不信任 client 提供 `tenant_id`。
  - 店員只可操作同店對應的來源單。
- 稽核與監控：
  - `audit_logs` 存 `channel`, `storeSlug`, `sourceRef`, `idempotencyKey`。
  - 監控：每 5 分鐘一次來源待接單數、超時未付款率。
- 測試案例：
  - happy path：QR 下單 -> 付款確認 -> 進入 `order-hub`。
  - 壞輸入：`items.qty=0`、`phone` 格式不正確。
  - 外部失敗：LINE token 過期，回 401 並要求重新授權。
- 手動 QA：
  - 用同一設備同一 `channel` 下兩筆同時提交，確認去重與重複阻擋。
- 上線/回滾：
  - 上線門檻：`DUPLICATE_CHANNEL_ORDER` 必須可回放、可人工補單。
  - 回滾：停用外部入口，保留手動補單能力。
- 待確認事項：
  - QR 鏈接與 LINE Entry 的有效期策略。

### T2-03 列印韌性與重打補償（P1）

- 背景：現場作業核心是出單與廚房單，列印失敗時仍需可追溯且可重試。
- 目標：建立列印作業佇列、重試、人工補打與設備離線告警。
- 使用者：收銀員、店員、店長。
- 風險：列印失敗時票據遺漏、與付款狀態脫鉤。
- 不做範圍：多型態廚房 KDS 串接、第三方排程。
- 資料表/API/畫面：
  - 資料表：`print_jobs`, `print_targets`, `terminal_devices`。
  - API：
    - `POST /api/v1/print-jobs/{id}/retry`
    - `GET /api/v1/print-jobs`
    - `PATCH /api/v1/print-jobs/{id}/cancel`
  - 畫面：列印待重試清單、設備離線標示、紙張/網路故障手動補打。
- 狀態與錯誤：
  - 狀態：`QUEUED`, `SENT`, `ACKED`, `FAILED`, `RETRYING`, `CANCELLED`。
  - 錯誤：`PRINTER_OFFLINE`, `RETRY_LIMIT_EXCEEDED`, `INVALID_PRINT_TEMPLATE`, `PRINTER_BUSY`。
- 權限與租戶隔離：
  - `terminalId` 掛載 `tenant_id`，查詢與補打必需在同租戶。
  - 重打要保留 `actorId` 與原始票據 `orderNumber`。
- 稽核與監控：
  - 列印每次嘗試寫入 `audit_logs`。
  - 監控：30 分鐘列印失敗次數、平均重試次數。
- 測試案例：
  - happy path：列印成功後狀態轉 `ACKED`。
  - 外部失敗：設備離線 15 分鐘，進入 `FAILED` 並自動重試。
- 手動 QA：
  - 離線前列印 3 張，恢復後以重試與補打方式完成。
- 上線/回滾：
  - 上線門檻：列印失敗需保留重試歷程，可人工標記補打。
  - 回滾：停用自動重試，改為只顯示待補打。
- 待確認事項：
  - 列印樣版版本升級策略與回退時間。

### T2-04 端末健康與遠端診斷（P1）

- 背景：客服需要快速判斷「是否可收銀」「同步是否阻塞」「列印是否斷線」。
- 目標：提供每台 POS 的版本、同步延遲、錯誤碼、硬體連線狀態摘要與告警。
- 使用者：店長、客服、工程。
- 風險：誤判健康狀態導致店家誤操作。
- 不做範圍：主機級監控、RUM、用量分析。
- 資料表/API/畫面：
  - 資料表：`terminal_health_snapshots`, `support_alerts`。
  - API：
    - `POST /api/v1/telemetry/heartbeat`
    - `GET /api/v1/telemetry/terminal/{terminalId}`
    - `GET /api/v1/telemetry/dashboard`
  - 畫面：健康儀表板、告警卡片、版本與同步延遲圖。
- 狀態與錯誤：
  - 狀態：`OK`, `DEGRADED`, `CRITICAL`, `UNREACHABLE`。
  - 錯誤：`HEARTBEAT_STALE`, `SYNC_STALE`, `SOFTWARE_VERSION_UNKNOWN`, `DEVICE_MISMATCH`。
- 權限與租戶隔離：
  - `dashboard` 僅顯示同 tenant 及授權店號。
  - 客服 impersonation 必須留 `audit_logs`。
- 稽核與監控：
  - `support_alerts` 記錄告警條件、告警人、處理時間。
  - 每 60 秒更新一次 heartbeat，超過門檻自動告警。
- 測試案例：
  - happy path：版本與同步資料入庫後，儀表板顯示 `OK`。
  - 外部失敗：heartbeat 超時超過 5 分鐘，升級 `UNREACHABLE`。
- 手動 QA：
  - 斷開網路 10 分鐘後，客服可從 dashboard 判斷 `SYNC_STALE`。
- 上線/回滾：
  - 上線門檻：可從 dashboard 看到每台 terminal 的三個核心維度。
  - 回滾：保留 heartbeat 查詢但關閉告警推播。
- 待確認事項：
  - 告警閾值（分鐘/次）是否由店型區分。

### T2-05 基礎報表導出與一致性核對（P1）

- 背景：店長需要把日報傳給會計，但目前缺少可追溯匯出與欄位對帳檢核。
- 目標：提供報表 CSV 匯出與匯出失敗重試，保留匯出稽核。
- 使用者：店長、櫃檯主管、會計。
- 風險：欄位缺失導致對帳誤差、匯出時暴露敏感資料。
- 不做範圍：月報 PDF、跨店合併報表、敏感金融欄位導出。
- 資料表/API/畫面：
  - 資料表：`report_exports`, `export_audit`。
  - API：
    - `POST /api/v1/reports/exports`
    - `GET /api/v1/reports/exports/{id}`
    - `GET /api/v1/reports/exports/{id}/download`
  - 畫面：導出清單、下載連結、校驗摘要。
- 狀態與錯誤：
  - 狀態：`QUEUED`, `PROCESSING`, `READY`, `FAILED`, `EXPIRED`。
  - 錯誤：`EXPORT_RANGE_TOO_LARGE`, `EMPTY_REPORT`, `FILE_EXPIRED`, `TENANT_NOT_AUTHORIZED`。
- 權限與租戶隔離：
  - 僅 `MANAGER+` 可匯出。
  - 匯出只允許同租戶 `storeId`，多店以 role policy 驗證。
- 稽核與監控：
  - `export_audit` 紀錄下載時間、下載者、目的地 email、rows
  - 監控：匯出失敗率、過期未下載率。
- 測試案例：
  - happy path：匯出 7 日銷售 CSV，5 分鐘內可下載。
  - 外部失敗：儲存節點暫時失敗，轉 `FAILED` 並保留重試入口。
- 手動 QA：
  - 匯出後用行數與加總核對原報表頁口徑。
- 上線/回滾：
  - 上線門檻：匯出文件可驗證 row count 與 hash。
  - 回滾：保留查詢頁，暫停匯出按鈕。
- 待確認事項：
  - 匯出檔保存天數與刪除責任人。

## Sprint 2 票務板（第 5-8 週）

| 票務 | 角色分工 | 依賴 | 主要交付 | 風險 gate |
| --- | --- | --- | --- | --- |
| T2-01 商品與菜單管理後台（P0） | PM 0.5h，工程 2 人日，QA 1 人日，法遵 0.5 人日 | T1-01 | 商品/分類/SKU 管理 API、發佈流程、版本紀錄 | 價目表版本可回滾，tenant scope 不會跨店透出 |
| T2-02 線上點餐（QR/LINE）前台（P0） | PM 1h，工程 2 人日，QA 1 人日，法遵 0.5 人日 | T1-02 | `channel_orders`、QR/LINE 下單/查詢、重試保護 | 外部 token 過期、未知付款狀態要可人工補償 |
| T2-03 列印韌性與重打補償（P1） | PM 0.5h，工程 1.5 人日，QA 1 人日，法遵 0.5 人日 | T1-01 | print job queue、重試、補打頁、硬體異常追蹤 | 列印失敗不會造成作廢單未回補 |
| T2-04 端末健康與遠端診斷（P1） | PM 0.5h，工程 1 人日，QA 1 人日，法遵 0.5 人日 | T0-02 | heartbeat、dashboard、告警規則 | 5 分鐘未同步能準確示警 |
| T2-05 報表導出與一致性核對（P1） | PM 0.5h，工程 1 人日，QA 1 人日，法遵 0.5 人日 | T1-04 | 匯出 API、下載憑證、對帳摘要 | 匯出與 API 報表欄位口徑一致 |

### 跨工時節點（建議）

- D14：完成 T2-01 菜單資料模型與發佈流程。
- D16：完成 T2-02 線上點餐 API 與去重機制。
- D18：完成 T2-03 列印重試邏輯與補打入口。
- D20：完成 T2-04 端末健康儀表板。
- D22：完成 T2-05 匯出 API，完成欄位口徑比對。

## Sprint 2 主要票務欄位級別規格（直接開發）

### T2-01 商品與菜單管理後台（P0）

#### API：`POST /api/v1/catalog/products`

請求：

```json
{
  "name": "綜合奶茶",
  "categoryId": "uuid",
  "status": "DRAFT",
  "skus": [
    {
      "skuCode": "MILK-ICE-500",
      "price": 70,
      "stockTracked": false
    }
  ],
  "modifiers": [
    {
      "groupName": "甜度",
      "type": "single",
      "options": ["正常", "少冰", "去冰"]
    }
  ],
  "publishToStoreIds": ["uuid"]
}
```

回應：

```json
{
  "productId": "uuid",
  "version": 1,
  "status": "DRAFT",
  "createdAt": "2026-05-14T08:20:00.000Z"
}
```

#### API：`POST /api/v1/catalog/prices/batch`

```json
{
  "productPriceUpdates": [
    {
      "skuId": "uuid",
      "storeId": "uuid",
      "price": 75,
      "currency": "TWD"
    }
  ],
  "reason": "每日早班調價",
  "source": "MANUAL_ADJUST"
}
```

回應：

```json
{
  "batchId": "uuid",
  "applied": 1,
  "skipped": 0,
  "errors": []
}
```

錯誤碼：

- `PRODUCT_NAME_DUPLICATE`
- `CATEGORY_NOT_FOUND`
- `PRICE_OUT_OF_RANGE`
- `MODIFIER_RULE_INVALID`

租戶規則：

- `publishToStoreIds` 僅允許 tenant 下所有授權店。
- `SKU` 與 `modifierGroups` 查詢必須綁定 tenant index。

Rollback：

- 停用新版本發佈、回到上次 `PUBLISHED` 版本。
- 保留 `product_prices` history 不刪除。

#### API：`GET /api/v1/catalog/menus/published`

查詢參數：

- `storeId`
- `includeDraft`（預設 false）
- `locale`（`zh-TW` / `en-US`）

回應：

```json
{
  "menus": [
    {
      "productId": "uuid",
      "productName": "綜合奶茶",
      "skuId": "uuid",
      "price": 70,
      "status": "PUBLISHED",
      "modifiers": ["正常", "少冰", "去冰"],
      "updatedAt": "2026-05-14T08:20:00.000Z"
    }
  ]
}
```

### T2-02 線上點餐（QR/LINE）前台（P0）

#### API：`POST /api/v1/channels/qr/orders`

```json
{
  "channel": "QR",
  "storeSlug": "tao-sleepy-cafe",
  "tenantPublicKey": "string",
  "customer": {
    "name": "陳小明",
    "phone": "0912345678"
  },
  "items": [
    {
      "skuId": "uuid",
      "qty": 2,
      "options": ["少冰", "去冰"]
    }
  ],
  "idempotencyKey": "string",
  "memo": "外帶"
}
```

回應：

```json
{
  "orderId": "uuid",
  "source": "QR",
  "sourceRef": "string",
  "state": "CREATED",
  "paymentState": "PENDING"
}
```

#### API：`POST /api/v1/channels/line/orders`

同 `POST /api/v1/channels/qr/orders`，多一欄 `lineChannelToken`。

#### API：`PATCH /api/v1/channels/orders/{id}/status`

```json
{
  "state": "CONFIRMED|CANCELLED",
  "actor": "MANAGER|CUSTOMER",
  "reason": "顧客取消|付款完成|超時"
}
```

錯誤碼：

- `CHANNEL_AUTH_FAILED`
- `SOURCE_ITEM_CLOSED`
- `DUPLICATE_CHANNEL_ORDER`
- `PAYMENT_UNKNOWN`

租戶規則：

- `storeSlug` 只做參考索引，真正鑑權仍用 tenant channel 資訊。
- 查詢/更新都以 `storeId` 在 tenant 內驗證。

Rollback：

- 暫停 `qr/orders` 與 `line/orders`；保留手動補單 API。

### T2-03 列印韌性與重打補償（P1）

#### API：`POST /api/v1/print-jobs/{id}/retry`

```json
{
  "reason": "NETWORK_RECOVERY|MANUAL_REPRINT|PRINT_TEMPLATE_UPDATE",
  "requestedBy": "uuid"
}
```

回應：

```json
{
  "printJobId": "uuid",
  "state": "RETRYING",
  "retryCount": 1,
  "estimatedReprintAt": "2026-05-14T08:25:00.000Z"
}
```

#### API：`GET /api/v1/print-jobs`

```json
{
  "items": [
    {
      "id": "uuid",
      "orderId": "uuid",
      "documentType": "RECEIPT|KITCHEN_TICKET",
      "state": "FAILED",
      "attempts": 3,
      "lastErrorCode": "PRINTER_OFFLINE"
    }
  ]
}
```

錯誤碼：

- `PRINTER_OFFLINE`
- `RETRY_LIMIT_EXCEEDED`
- `INVALID_PRINT_TEMPLATE`
- `PRINTER_BUSY`

### T2-04 端末健康與遠端診斷（P1）

#### API：`POST /api/v1/telemetry/heartbeat`

```json
{
  "terminalId": "uuid",
  "appVersion": "1.3.2",
  "deviceStatus": "OK",
  "syncLagSeconds": 120,
  "printerStatus": "OK",
  "queuedOutbox": 3
}
```

回應：

```json
{
  "accepted": true,
  "nextHeartbeatAt": "2026-05-14T08:21:00.000Z",
  "advice": "none"
}
```

#### API：`GET /api/v1/telemetry/dashboard`

查詢參數：

- `tenantId` 不得輸入
- `storeId`
- `timeRange`（`day|week`）

回應：

```json
{
  "storeId": "uuid",
  "overall": "DEGRADED",
  "terminals": [
    {
      "terminalId": "uuid",
      "syncLagSeconds": 120,
      "printErrorCount": 4,
      "softwareVersion": "1.3.2"
    }
  ]
}
```

錯誤碼：

- `HEARTBEAT_STALE`
- `SYNC_STALE`
- `SOFTWARE_VERSION_UNKNOWN`
- `DEVICE_MISMATCH`

### T2-05 基礎報表導出與一致性核對（P1）

#### API：`POST /api/v1/reports/exports`

```json
{
  "reportType": "daily",
  "from": "2026-05-01",
  "to": "2026-05-14",
  "storeIds": ["uuid"],
  "format": "CSV"
}
```

回應：

```json
{
  "exportId": "uuid",
  "state": "QUEUED",
  "checksum": "sha256:...",
  "expiresAt": "2026-05-15T08:20:00.000Z"
}
```

#### API：`GET /api/v1/reports/exports/{id}`

```json
{
  "id": "uuid",
  "reportType": "daily",
  "state": "READY",
  "rows": 1024,
  "checksum": "sha256:...",
  "downloadUrl": "/api/v1/reports/exports/uuid/download?token=..."
}
```

錯誤碼：

- `EXPORT_RANGE_TOO_LARGE`
- `EMPTY_REPORT`
- `FILE_EXPIRED`
- `TENANT_NOT_AUTHORIZED`

租戶規則：

- `storeIds` 僅接受 tenant 內店號。
- 下載 URL 內含一次性 token，含到期與 ip 綁定。

Rollback：

- 發現匯出資料口徑異常時停用導出按鈕，保留報表頁只讀模式。
