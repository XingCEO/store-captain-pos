# 錯誤碼總覽

本檔列出 `ulw-system` 所有 API 回傳的 `errorCode`，包含意義、HTTP 狀態、發生路徑與是否可重試。新增錯誤碼前先讀本檔避免重複。

## 通用

| 錯誤碼 | HTTP | 意義 | 來源路徑 | 可重試 |
|-------|------|------|----------|--------|
| UNHANDLED | 500 | 未捕捉的伺服器異常 | POST 任意路徑（異常處理） | 是 |
| PAYLOAD_PARSE_ERROR | 400 | JSON 解析失敗 | POST /api/v1/auth/login, POST /api/v1/users, POST /api/v1/catalog/products, POST /api/v1/catalog/prices/batch, POST /api/v1/catalog/import, POST /api/v1/orders, POST /api/v1/invoices/issue-sandbox, ... | 否 |
| TENANT_NOT_AUTHORIZED | 403 | 租戶權限不足或未授權 | GET /api/v1/orders/:id, GET /api/v1/orders/:id/events, GET /api/v1/reports/exports/:id/download, ... | 否 |
| PATH_NOT_FOUND | 404 | 路由不存在 | 任意未定義的路徑 | 否 |
| PERMISSION_DENIED | 403 | 角色權限不足 | POST /api/v1/catalog/prices/batch (SUPERVISOR+), PATCH /api/v1/users/:id (MANAGER+), ... | 否 |
| DATE_RANGE_INVALID | 400 | 日期範圍或格式無效 | GET /api/v1/reconciliation/daily, GET /api/v1/reports/daily, GET /api/v1/reports/payment-breakdown, GET /api/v1/reports/top-products, POST /api/v1/reports/exports | 否 |
| DEVICE_MISMATCH | 400 | 設備或租戶識別不符 | GET /api/v1/telemetry/dashboard | 否 |

## Identity / Auth

| 錯誤碼 | HTTP | 意義 | 來源路徑 | 可重試 |
|-------|------|------|----------|--------|
| LOGIN_INVALID_CREDENTIALS | 400/403 | 登入認證無效（租戶、密碼、角色） | POST /api/v1/auth/login, GET /api/v1/auth/session | 否 |
| LOGIN_RATE_LIMITED | 429 | 登入嘗試過多，帳戶被鎖定 | POST /api/v1/auth/login | 是 |
| USER_INVALID | 400 | 使用者資料無效（角色、欄位） | POST /api/v1/users, PATCH /api/v1/users/:id | 否 |
| USER_NOT_FOUND | 404 | 使用者不存在 | PATCH /api/v1/users/:id | 否 |
| USER_EMAIL_DUPLICATE | 409 | 電郵在租戶內已被使用 | POST /api/v1/users | 否 |
| ROLE_GRANT_FORBIDDEN | 403 | 角色授予權限不足或違反層級 | POST /api/v1/users, PATCH /api/v1/users/:id | 否 |

## Catalog / 商品

| 錯誤碼 | HTTP | 意義 | 來源路徑 | 可重試 |
|-------|------|------|----------|--------|
| MODIFIER_RULE_INVALID | 400 | 修飾符規則結構無效 | POST /api/v1/catalog/products, PATCH /api/v1/catalog/products/:id | 否 |
| CATEGORY_NOT_FOUND | 400 | 商品分類不存在或未指定 | POST /api/v1/catalog/products | 否 |
| PRICE_OUT_OF_RANGE | 400 | 價格超出有效範圍（0–999999） | POST /api/v1/catalog/products, POST /api/v1/catalog/prices/batch | 否 |
| PRODUCT_NOT_FOUND | 404 | 商品或 SKU 不存在 | PATCH /api/v1/catalog/products/:id, POST /api/v1/catalog/prices/batch | 否 |
| PRODUCT_NAME_DUPLICATE | 409 | 商品名稱已在租戶內使用 | POST /api/v1/catalog/products | 否 |
| CATALOG_IDEMPOTENCY_CONFLICT | 409 | 冪等鍵承載的內容與之前請求衝突 | POST /api/v1/catalog/products, PATCH /api/v1/catalog/products/:id, POST /api/v1/catalog/prices/batch, POST /api/v1/catalog/import | 否 |
| PUBLISH_CONFLICT | 409 | 發佈版本衝突（新版本號 < 現有） | PATCH /api/v1/catalog/products/:id | 否 |
| IMPORT_PAYLOAD_INVALID | 400 | 批量匯入資料格式或數量無效 | POST /api/v1/catalog/import | 否 |

## Commerce / 訂單與支付

| 錯誤碼 | HTTP | 意義 | 來源路徑 | 可重試 |
|-------|------|------|----------|--------|
| ORDER_ITEM_INVALID | 400 | 訂單項目無效（SKU、數量、價格） | POST /api/v1/orders, POST /api/v1/order-sources/manual, POST /api/v1/channels/qr/orders, POST /api/v1/channels/line/orders | 否 |
| IDEMPOTENCY_KEY_MISMATCH | 400 | 缺少冪等鍵 | POST /api/v1/orders | 否 |
| ORDER_IDEMPOTENCY_CONFLICT | 409 | 訂單冪等鍵承載衝突 | POST /api/v1/orders, POST /api/v1/orders/:id/refund, POST /api/v1/orders/:id/void | 否 |
| ORDER_NOT_FOUND | 404 | 訂單不存在 | PATCH /api/v1/orders/:id/discount, POST /api/v1/orders/:id/pay/manual, POST /api/v1/orders/:id/refund, POST /api/v1/orders/:id/void, GET /api/v1/orders/:id, GET /api/v1/orders/:id/events, GET /api/v1/payments | 否 |
| ORDER_STATE_INVALID | 409 | 訂單狀態不允許該操作（已付款、已作廢） | PATCH /api/v1/orders/:id/discount, POST /api/v1/orders/:id/pay/manual, POST /api/v1/orders/:id/refund | 否 |
| DISCOUNT_INVALID | 400 | 折扣金額或原因碼無效 | PATCH /api/v1/orders/:id/discount | 否 |
| PAYMENT_INVALID | 400 | 支付金額或方式無效 | POST /api/v1/orders/:id/pay/manual | 否 |
| OUT_OF_STOCK | 409 | 庫存不足 | POST /api/v1/orders/:id/pay/manual, PATCH /api/v1/channels/orders/:id/status, POST /api/v1/inventory/adjustments | 是 |
| REFUND_AMOUNT_INVALID | 400 | 退款金額超過可退金額或原因碼無效 | POST /api/v1/orders/:id/refund | 否 |
| VOID_NOT_ALLOWED | 400/409 | 訂單無法作廢（已付款或原因碼無效） | POST /api/v1/orders/:id/void | 否 |

## Operations / 訂單源、現金、庫存

| 錯誤碼 | HTTP | 意義 | 來源路徑 | 可重試 |
|-------|------|------|----------|--------|
| SOURCE_CHANNEL_UNKNOWN | 400 | 訂單來源渠道無效 | POST /api/v1/order-sources/manual | 否 |
| MISSING_REFERENCE_ID | 400 | 缺少外部參考編號 | POST /api/v1/order-sources/manual | 否 |
| SOURCE_DUPLICATE | 409 | 該渠道的外部參考已存在 | POST /api/v1/order-sources/manual | 否 |
| CHANNEL_AUTH_FAILED | 400/403 | 渠道驗證失敗（LINE token、QR）  | POST /api/v1/channels/qr/orders, POST /api/v1/channels/line/orders | 否 |
| PAYMENT_UNKNOWN | 400 | 支付相關欄位無效（項目） | POST /api/v1/channels/qr/orders, POST /api/v1/channels/line/orders | 否 |
| SOURCE_ITEM_CLOSED | 404/409 | 訂單來源項目已關閉或狀態不允許更新 | PATCH /api/v1/channels/orders/:id/status | 否 |
| KDS_STATE_INVALID | 400 | 生產狀態無效 | PATCH /api/v1/kds/orders/:id | 否 |
| CASHBOX_ALREADY_OPEN | 409 | 現金收納箱已開啟 | POST /api/v1/cash-drawers/open | 否 |
| CASH_SHORTFALL | 400 | 現金金額無效或為負 | POST /api/v1/cash-drawers/open, POST /api/v1/cash-drawers/close | 否 |
| DRAWER_NOT_FOUND | 404 | 現金收納箱不存在 | POST /api/v1/cash-drawers/close, GET /api/v1/cash-drawers/:id/report | 否 |
| INVENTORY_ADJUSTMENT_INVALID | 400 | 庫存調整欄位無效（SKU、數量、原因） | POST /api/v1/inventory/adjustments | 否 |
| STOCK_COUNT_INVALID | 400 | 庫存盤點資料無效（SKU、數量） | POST /api/v1/inventory/counts | 否 |
| TRANSFER_INVALID | 400 | 庫存轉移資料無效（來源、目標） | POST /api/v1/inventory/transfers | 否 |

## Risk / 發票、報表、列印

| 錯誤碼 | HTTP | 意義 | 來源路徑 | 可重試 |
|-------|------|------|----------|--------|
| INVOICE_ORDER_NOT_READY | 404 | 訂單未支付或不存在 | POST /api/v1/invoices/issue-sandbox | 否 |
| INVOICE_NOT_FOUND | 404 | 發票不存在 | POST /api/v1/invoices/:id/mark-uploaded, POST /api/v1/invoices/:id/void-sandbox | 否 |
| INVOICE_VOID_INVALID | 400 | 發票作廢原因碼無效 | POST /api/v1/invoices/:id/void-sandbox | 否 |
| RECONCILIATION_STORE_SCOPE_VIOLATION | 403 | 對帳商店超出租戶權限範圍 | GET /api/v1/reconciliation/daily | 否 |
| EXPORT_RANGE_INVALID | 400 | 報表匯出範圍或欄位無效 | POST /api/v1/reports/exports | 否 |
| EXPORT_RANGE_TOO_LARGE | 400 | 報表匯出日期範圍超過 92 天 | POST /api/v1/reports/exports | 否 |
| FILE_EXPIRED | 410 | 匯出檔案已過期 | GET /api/v1/reports/exports/:id/download | 否 |
| PRINT_JOB_STATE_INVALID | 400 | 列印工作狀態值無效 | GET /api/v1/print-jobs | 否 |
| PRINTER_OFFLINE | 404 | 列印工作不存在 | POST /api/v1/print-jobs/:id/retry | 否 |
| RETRY_LIMIT_EXCEEDED | 409 | 列印工作已達重試上限 | POST /api/v1/print-jobs/:id/retry | 否 |
| PRINT_JOB_NOT_RETRYABLE | 409 | 列印工作狀態不允許重試 | POST /api/v1/print-jobs/:id/retry | 否 |
| CUSTOMER_PHONE_INVALID | 400 | 客戶電話格式無效（非台灣手機） | POST /api/v1/customers | 否 |
| COUPON_NOT_APPLICABLE | 400/409 | 折扣券不適用或最低消費不達 | POST /api/v1/coupons/redeem | 否 |
| POINTS_INVALID | 400 | 客戶點數調整欄位無效 | POST /api/v1/customers/points/adjust | 否 |
| SYNC_STALE | 400 | 遠端同步心跳欄位缺失 | POST /api/v1/telemetry/heartbeat | 否 |
| SYNC_JOB_NOT_FOUND | 404 | 同步工作不存在 | POST /api/v1/sync/jobs/:id/retry, POST /api/v1/sync/jobs/:id/resolve | 否 |
| SYNC_RESOLUTION_INVALID | 400 | 同步解決方案值無效 | POST /api/v1/sync/jobs/:id/resolve | 否 |

## 命名慣例

- SCREAMING_SNAKE_CASE
- 動詞通常為 `_INVALID` / `_NOT_FOUND` / `_CONFLICT` / `_DENIED` / `_EXCEEDED` / `_VIOLATION` / `_FAILED` / `_EXPIRED`
- 同類型錯誤共用同一碼，不要為每個欄位再分支
- HTTP 狀態對應：400（格式/邏輯錯誤）、403（權限拒絕）、404（資源不存在）、409（衝突）、410（已過期）、429（速率限制）、500（未捕捉異常）
