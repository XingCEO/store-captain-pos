# 技術與系統架構

## 1. 架構原則

- Offline-first：門市斷網仍可營業。
- Multi-tenant SaaS：多客戶共用平台，但資料隔離。
- Modular：功能模組可依方案開關。
- API-first：方便串接金流、電子發票、LINE、ERP、會計、電商。
- Event-driven：訂單、付款、發票、庫存以事件驅動。
- Idempotent：同步重送不重複建單、不重複扣庫存、不重複開發票。
- Secure by design：租戶隔離、權限、稽核、加密與最小資料曝露。
- Hardware-agnostic：不綁硬體，但維護認證硬體清單。

## 2. 高階系統圖

```text
                    ┌──────────────────────────┐
                    │        總部後台 Web       │
                    │ 商品 / 價格 / 會員 / 報表 │
                    └─────────────┬────────────┘
                                  │
                                  ▼
┌─────────────┐        ┌──────────────────────────┐
│ POS 前台 App │◄──────►│       雲端 API 平台       │
│ 平板/手機/PC │        │ Auth / Order / Payment   │
└──────┬──────┘        │ Invoice / Inventory / AI  │
       │               └─────────────┬────────────┘
       │                             │
       ▼                             ▼
┌─────────────┐        ┌──────────────────────────┐
│ 本機資料庫   │        │      核心資料庫           │
│ 離線交易佇列 │        │ PostgreSQL / Redis / MQ  │
└──────┬──────┘        └─────────────┬────────────┘
       │                             │
       ▼                             ▼
┌─────────────┐        ┌──────────────────────────┐
│ 周邊硬體     │        │ 第三方服務                │
│ 印表機/錢櫃  │        │ 金流 / 電子發票 / LINE    │
│ 掃描器/KDS   │        │ 外送 / 會計 / ERP         │
└─────────────┘        └──────────────────────────┘
```

## 3. 建議技術棧

### 前台

| 平台 | 建議技術 |
| --- | --- |
| Android POS | Flutter 或 Kotlin |
| iPad | Flutter 或 Swift |
| Windows POS | Electron 或 .NET MAUI |
| Web 後台 | React 或 Vue |
| 本機資料庫 | SQLite |
| 同步 | Outbox + Sync Worker + Idempotency Key |
| 印表機 | ESC/POS、廠商 SDK |
| 掃描器 | HID Keyboard、USB、Bluetooth |
| KDS | WebSocket、MQTT 或 LAN polling |

### 後端

| 層級 | 建議技術 |
| --- | --- |
| API | NestJS、Spring Boot 或 .NET |
| 資料庫 | PostgreSQL |
| 快取 | Redis |
| Queue | RabbitMQ、Kafka、SQS 或 Cloud Tasks |
| 搜尋 | OpenSearch |
| 檔案 | S3-compatible storage |
| 報表 | 自建 BI、Metabase 或 Superset |
| AI | LLM API + 規則引擎 + RAG |
| 部署 | Docker + Kubernetes 或 Cloud Run |
| 監控 | Prometheus + Grafana |
| Log | Loki 或 OpenSearch |

## 4. 離線同步設計

離線 POS 的正確心智模型：本機資料庫是前台操作的即時來源，雲端是同步與跨店一致性的來源。

同步模型不要做「本機資料表覆蓋雲端資料表」。POS 應寫入 command / event / ledger，再由雲端驗證、去重、落帳，最後產生查詢用 projection。

本機必須保存：

- 商品
- 分類
- 價格
- 促銷規則
- 常用會員快取
- 庫存快取
- 字軌快取或發票開立所需安全資料
- 訂單
- 付款狀態
- 發票暫存
- 同步佇列

每筆交易必須有穩定唯一鍵：

```text
tenant_id
store_id
terminal_id
business_date
local_sequence
uuid
idempotency_key
```

### Outbox 流程

```text
1. POS 在 SQLite 寫入本機訂單
2. 同一個 transaction 寫入 outbox sync job
3. UI 只讀本機資料，不等雲端回應
4. Sync worker 背景批次上傳
5. 雲端以 idempotency key + unique constraint 去重
6. 成功後標記 synced
7. 可重試錯誤進 retry queue
8. 不可重試錯誤進 dead letter
9. 超過門檻通知店長與客服
```

同步狀態建議：

```text
PENDING
IN_FLIGHT
SYNCED
RETRYABLE_ERROR
FATAL_ERROR
DEAD_LETTER
```

Idempotency 要求：

- Key 必須至少包含 `tenant_id`、`store_id`、`terminal_id`、operation type 與本機事件 ID。
- 雲端需保存 payload fingerprint；同 key 不同 payload 一律拒絕。
- 5xx 類暫時錯誤不得被永久快取為成功。
- 發票、付款、庫存扣減都要各自有業務層 idempotency，不只 API gateway 去重。

### 離線風險控管

| 風險 | 控制 |
| --- | --- |
| 重複訂單 | Client + Server idempotency |
| 發票重號 | 本機字軌分配、終端號區間、雲端核對 |
| 庫存不準 | 本機暫扣、雲端 ledger 合併、差異報表 |
| 付款失敗 | 離線只允許現金或已授權支付 |
| 同步衝突 | 事件版本號、業務規則、人工處理清單 |
| App 崩潰 | 草稿交易與正式交易分離，付款完成時原子提交 |

## 5. 核心資料模型

### 基礎資料

```text
tenants              客戶租戶
stores               門市
terminals            POS 機台
users                使用者
roles                角色
permissions          權限
audit_logs           稽核紀錄
```

### 商品

```text
products             商品主檔
skus                 商品規格
categories           商品分類
modifiers            客製選項
modifier_groups      客製群組
bundles              組合商品
price_books          價格表
product_prices       商品價格
```

### 訂單

```text
orders               訂單主檔
order_items          訂單明細
order_item_modifiers 客製選項明細
order_events         訂單事件
order_sources        訂單來源
refunds              退款
voids                作廢
```

### 付款

```text
payments             付款紀錄
payment_methods      付款方式
payment_transactions 金流交易
cash_drawers         錢櫃
cash_movements       現金異動
settlements          對帳批次
```

### 發票

```text
invoices             發票
invoice_tracks       字軌
invoice_upload_jobs  上傳任務
invoice_upload_logs  上傳紀錄
invoice_allowances   折讓
invoice_voids        作廢紀錄
invoice_exceptions   發票異常
```

### 庫存

```text
stock_items          庫存商品
stock_ledger         庫存流水
stock_balance        庫存餘額
purchase_orders      進貨單
transfer_orders      調撥單
stock_counts         盤點單
waste_records        報廢紀錄
recipes              BOM 配方
recipe_items         配方明細
```

庫存設計規則：

- `stock_ledger` 是事實來源，任何進貨、銷售、退貨、報廢、調撥都新增 ledger row。
- `stock_balance` 是 projection，可重算，不可作為唯一真相。
- 離線銷售先形成本機 stock event，雲端同步後再合併與對帳。
- 負庫存、效期、批號、BOM 扣料要有異常佇列，不應靜默修正。

### 會員

```text
customers            會員
customer_profiles    會員資料
customer_points      點數流水
customer_wallets     儲值錢包
coupons              優惠券
coupon_redemptions   優惠券核銷
campaigns            行銷活動
```

### AI 與報表

```text
daily_summaries      每日摘要
ai_insights          AI 洞察
anomaly_events       異常事件
recommendations      系統建議
benchmarks           匿名同業比較
```

## 6. 權限與資安

角色：

- 收銀員：點餐、結帳、查商品
- 資深員工：折扣、補印
- 店長：退貨、作廢、交班、報表
- 區主管：多店報表、調撥
- 總部：商品、價格、促銷、權限
- 財務：發票、對帳、退款
- 系統管理員：系統設定、API、整合

安全要求：

- HTTPS
- JWT + Refresh Token 或等效 session 管理
- Admin MFA
- RBAC + object-level authorization
- Tenant isolation
- 資料加密
- API rate limit
- 裝置綁定
- 敏感操作二次驗證
- 完整稽核紀錄

多租戶查詢規則：

```text
任何查詢、快取 key、檔案路徑、queue message 都必須帶 tenant context。
不得信任 client 傳來的 tenant_id。
租戶上下文必須由已驗證 session 或 API key 推導。
```

資料庫層防線：

- PostgreSQL 建議使用 Row Level Security 作為 defense-in-depth。
- Table owner 預設可能繞過 RLS，正式環境需評估 `FORCE ROW LEVEL SECURITY`。
- 每個 request / job / worker 都要設定可信 tenant context。
- Admin 或客服跨租戶查詢必須有明確 override 權限與 audit log。

高風險操作必留紀錄：

- 登入失敗
- 改價
- 折扣
- 退貨
- 作廢
- 補印發票
- 開錢櫃
- 修改庫存
- 修改付款
- 匯出資料
- 權限變更

## 7. 電子發票架構

電子發票建議作為獨立 bounded context，不要混在訂單服務裡。

核心元件：

- Invoice Service
- Track Allocation Service
- Upload Worker
- Exception Monitor
- Daily Reconciliation Job
- MIG / Turnkey Adapter
- Value-added Center Adapter

開立流程：

```text
1. 訂單付款完成
2. Invoice Service 建立發票草稿
3. 分配字軌與號碼
4. 產生列印資料與上傳 payload
5. 寫入 invoice_upload_jobs
6. Worker 上傳或送加值中心
7. 記錄成功 / 失敗 / 待重試
8. 日結比對訂單、付款、發票
```

注意：若早期沒有法遵與維運能力，應優先串接成熟電子發票加值中心，而不是第一版自建完整 Turnkey 維運。

## 8. 付款架構

POS 不保存：

- 完整卡號 PAN
- CVV
- 磁條或晶片敏感資料
- PIN / PIN block

POS 可保存：

- payment_provider
- transaction_id
- authorization_code
- amount
- status
- last4，如果金流合約允許
- request/response correlation id

刷卡與行動支付應由合格金流、刷卡機、第三方 SDK 或支付頁承接，降低 PCI 範圍。

## 9. 硬體策略

不綁硬體，但要提供認證硬體清單。

支援設備：

- Android 平板
- iPad
- Windows 電腦
- 熱感印表機
- 錢櫃
- 掃描器
- 標籤機
- KDS 螢幕
- 客顯
- 自助點餐平板

硬體健康監控：

- 印表機離線
- 紙張不足
- KDS 斷線
- POS 同步失敗
- 網路不穩

KDS 與出單設計：

- Order Service 發出工作站事件，例如 `ticket.created`、`ticket.updated`、`ticket.cancelled`。
- KDS 訂閱廚房、吧台、炸台等 station channel。
- 印表機由 Printer Adapter 消費列印任務，不直接綁定訂單流程。
- 每台印表機需有 profile：紙寬、字碼、切紙、錢櫃 pulse、標籤模式、連線方式。
- 列印失敗要進 retry / manual reprint queue，不能讓訂單主流程卡死。

## 10. 可觀測性與客服診斷

低價 SaaS 要活下來，客服必須產品化。

內建遠端診斷：

- POS 版本
- 裝置資訊
- 網路狀態
- 印表機狀態
- 最後同步時間
- sync queue depth
- dead letter 數量
- 發票上傳狀態
- 付款狀態
- 最近錯誤 log

客服後台最少要能看到：

- 這家店今天能不能收銀
- 有沒有未同步訂單
- 有沒有發票異常
- 有沒有付款異常
- 哪台設備斷線
- 哪個版本出錯最多
