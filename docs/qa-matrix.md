# QA 矩陣

本檔對應 `docs/ai-engineering-rules.md` 的「每個 API 至少一個壞輸入 + 重試/衝突 + 權限拒絕」硬規則。
每列為一個 endpoint × 四個 case 是否已驗證或仍待補。

## 圖例
- ✅ 已實作 + 通過驗證
- 🟡 已實作但驗證待補
- ⛔ 尚未實作

## 矩陣

| 路由 | Happy Path | 壞輸入 | 重試/衝突 | 權限拒絕 | 備註 |
|------|-----------|--------|-----------|---------|------|
| POST /api/v1/auth/login | ✅ | ✅ LOGIN_INVALID_CREDENTIALS | ✅ LOGIN_RATE_LIMITED | n/a (公開) | 15分鐘內5次失敗鎖定 |
| GET /api/v1/auth/session | ✅ | ✅ LOGIN_INVALID_CREDENTIALS | n/a | n/a | 驗證 session 有效性 |
| POST /api/v1/auth/logout | ✅ | n/a | n/a | n/a | 幂等清除 session |
| GET /api/v1/audit-logs | ✅ | ✅ PAYLOAD_PARSE_ERROR | n/a | ✅ PERMISSION_DENIED (MANAGER+) | 分頁 + 資源過濾 |
| GET /api/v1/users | ✅ | ✅ PAYLOAD_PARSE_ERROR | n/a | ✅ PERMISSION_DENIED (MANAGER+) | 搜尋 + 租戶隔離 |
| POST /api/v1/users | ✅ | ✅ USER_INVALID / STORE_INVALID | ✅ SUBSCRIPTION_LIMIT_EXCEEDED | ✅ ROLE_GRANT_FORBIDDEN | 電郵唯一性 + 角色層級 + seatLimit 檢驗 |
| PATCH /api/v1/users/:id | ✅ | ✅ USER_INVALID / STORE_INVALID | ✅ SUBSCRIPTION_LIMIT_EXCEEDED | ✅ ROLE_GRANT_FORBIDDEN | 非 MANAGER 不可修改；重新啟用使用者需符合 seatLimit |
| GET /api/v1/stores | ✅ | n/a | n/a | ✅ PERMISSION_DENIED (MANAGER+) | 租戶隔離 |
| POST /api/v1/stores | ✅ | ✅ STORE_INVALID | ✅ SUBSCRIPTION_LIMIT_EXCEEDED | ✅ PERMISSION_DENIED (ADMIN+) | Chain 起：新增店鋪 + 預設 sandbox 設定 + audit |
| GET /api/v1/settings/store | ✅ | ✅ PAYLOAD_PARSE_ERROR | n/a | ✅ PERMISSION_DENIED (MANAGER+) | 商店設定查詢 |
| PATCH /api/v1/settings/store | ✅ | ✅ PAYLOAD_PARSE_ERROR | n/a | ✅ PERMISSION_DENIED (MANAGER+) | 審計欄位變更 |
| GET /api/v1/subscription/plans | ✅ | n/a | n/a | n/a (公開) | Starter / Growth / Chain 方案型錄與 entitlements |
| GET /api/v1/subscription/current | ✅ | n/a | n/a | ✅ PERMISSION_DENIED (MANAGER+) | 租戶目前訂閱 ledger + entitlements + usage/limits |
| POST /api/v1/subscription/change | ✅ | ✅ SUBSCRIPTION_PLAN_INVALID | ✅ SUBSCRIPTION_IDEMPOTENCY_CONFLICT / SUBSCRIPTION_LIMIT_EXCEEDED | ✅ PERMISSION_DENIED (ADMIN+) | 本機人工帳務，不自動扣款；降級需符合 seats/stores 上限 |
| POST /api/v1/subscription/cancel | ✅ | ✅ SUBSCRIPTION_STATE_INVALID | ✅ SUBSCRIPTION_IDEMPOTENCY_CONFLICT | ✅ PERMISSION_DENIED (ADMIN+) | 期末取消 + audit |
| GET /api/v1/products | ✅ | ✅ PAYLOAD_PARSE_ERROR | n/a | n/a | 發佈/草稿過濾 + 商店範圍 |
| GET /api/v1/catalog/menus/published | ✅ | n/a | n/a | n/a | 公開菜單（無認證） |
| GET /api/v1/catalog/categories | ✅ | n/a | n/a | n/a | 按租戶分組 |
| GET /api/v1/catalog/export | ✅ | n/a | n/a | ✅ PERMISSION_DENIED (MANAGER+) | 包含價格覆蓋 |
| POST /api/v1/catalog/products | ✅ | ✅ MODIFIER_RULE_INVALID | ✅ CATALOG_IDEMPOTENCY_CONFLICT | ✅ PERMISSION_DENIED (MANAGER+) | SKU 必須、版本 v1 |
| PATCH /api/v1/catalog/products/:id | ✅ | ✅ MODIFIER_RULE_INVALID | ✅ PUBLISH_CONFLICT | ✅ PERMISSION_DENIED (MANAGER+) | 版本遞增 |
| POST /api/v1/catalog/prices/batch | ✅ | ✅ PRICE_OUT_OF_RANGE | ✅ CATALOG_IDEMPOTENCY_CONFLICT | ✅ PERMISSION_DENIED (SUPERVISOR+) | 逐項驗證 + 部分成功 |
| POST /api/v1/catalog/import | ✅ | ✅ IMPORT_PAYLOAD_INVALID | ✅ CATALOG_IDEMPOTENCY_CONFLICT | ✅ PERMISSION_DENIED (SUPERVISOR+) | 批量建立 + 1–200 限制 |
| POST /api/v1/orders | ✅ | ✅ ORDER_ITEM_INVALID | ✅ ORDER_IDEMPOTENCY_CONFLICT | ✅ PERMISSION_DENIED (CASHIER+) | 🤖 冪等鍵必須 |
| PATCH /api/v1/orders/:id/discount | ✅ | ✅ DISCOUNT_INVALID | ✅ ORDER_STATE_INVALID | ✅ PERMISSION_DENIED (MANAGER+) | 已付款訂單拒絕 |
| POST /api/v1/orders/:id/pay/manual | ✅ | ✅ PAYMENT_INVALID | ✅ OUT_OF_STOCK | ✅ PERMISSION_DENIED (CASHIER+) | 🤖 庫存扣減 + 發票簽發 |
| POST /api/v1/orders/:id/refund | ✅ | ✅ REFUND_AMOUNT_INVALID | ✅ ORDER_IDEMPOTENCY_CONFLICT | ✅ PERMISSION_DENIED (SUPERVISOR+) | 部分退款 + 庫存復原可選 |
| POST /api/v1/orders/:id/void | ✅ | ✅ VOID_NOT_ALLOWED | ✅ ORDER_IDEMPOTENCY_CONFLICT | ✅ PERMISSION_DENIED (MANAGER+) | 🤖 已付款拒絕 |
| GET /api/v1/orders/:id | ✅ | ✅ PAYLOAD_PARSE_ERROR | n/a | ✅ PERMISSION_DENIED (CASHIER+) | 包含支付 + 退款 |
| GET /api/v1/orders/:id/events | ✅ | n/a | n/a | ✅ PERMISSION_DENIED (CASHIER+) | 訂單事件時間軸 |
| GET /api/v1/payments | ✅ | n/a | n/a | ✅ PERMISSION_DENIED (MANAGER+) | 支付分頁 + 商店過濾 |
| POST /api/v1/order-sources/manual | ✅ | ✅ ORDER_ITEM_INVALID | ✅ SOURCE_DUPLICATE | ✅ SUBSCRIPTION_FEATURE_NOT_INCLUDED / PERMISSION_DENIED (MANAGER+) | Growth 起：外部參考去重 |
| POST /api/v1/channels/qr/orders | ✅ | ✅ ORDER_ITEM_INVALID | ✅ CATALOG_IDEMPOTENCY_CONFLICT | ✅ SUBSCRIPTION_FEATURE_NOT_INCLUDED | Growth 起：QR 渠道建立 |
| POST /api/v1/channels/line/orders | ✅ | ✅ CHANNEL_AUTH_FAILED | ✅ CATALOG_IDEMPOTENCY_CONFLICT | ✅ SUBSCRIPTION_FEATURE_NOT_INCLUDED | Growth 起：LINE token 驗證 |
| PATCH /api/v1/channels/orders/:id/status | ✅ | ✅ SOURCE_ITEM_CLOSED | ✅ OUT_OF_STOCK | ✅ SUBSCRIPTION_FEATURE_NOT_INCLUDED / PERMISSION_DENIED (MANAGER+) | Growth 起：渠道訂單狀態轉移 |
| GET /api/v1/order-hub | ✅ | n/a | n/a | n/a | 多源訂單匯總 |
| GET /api/v1/kds/orders | ✅ | n/a | n/a | ✅ PERMISSION_DENIED (CASHIER+) | 廚房生產狀態列表 |
| PATCH /api/v1/kds/orders/:id | ✅ | ✅ KDS_STATE_INVALID | n/a | ✅ PERMISSION_DENIED (CASHIER+) | 生產狀態轉移 |
| POST /api/v1/cash-drawers/open | ✅ | ✅ CASH_SHORTFALL | ✅ CASHBOX_ALREADY_OPEN | ✅ PERMISSION_DENIED (SUPERVISOR+) | 開啟現金收納 |
| GET /api/v1/cash-drawers/open | ✅ | n/a | n/a | ✅ PERMISSION_DENIED (SUPERVISOR+) | 查詢開啟狀態 |
| POST /api/v1/cash-drawers/close | ✅ | ✅ CASH_SHORTFALL | n/a | ✅ PERMISSION_DENIED (SUPERVISOR+) | 現金點收 + 差額計算 |
| GET /api/v1/cash-drawers/:id/report | ✅ | n/a | n/a | ✅ PERMISSION_DENIED (MANAGER+) | 現金報表 |
| GET /api/v1/inventory/levels | ✅ | n/a | n/a | ✅ SUBSCRIPTION_FEATURE_NOT_INCLUDED / PERMISSION_DENIED (MANAGER+) | Growth 起：庫存水位列表 |
| POST /api/v1/inventory/adjustments | ✅ | ✅ INVENTORY_ADJUSTMENT_INVALID | ✅ OUT_OF_STOCK | ✅ SUBSCRIPTION_FEATURE_NOT_INCLUDED / PERMISSION_DENIED (MANAGER+) | Growth 起：手動調整 + 審計 |
| POST /api/v1/inventory/counts | ✅ | ✅ STOCK_COUNT_INVALID | n/a | ✅ SUBSCRIPTION_FEATURE_NOT_INCLUDED / PERMISSION_DENIED (MANAGER+) | Growth 起：盤點 + 批量調整 |
| POST /api/v1/inventory/transfers | ✅ | ✅ TRANSFER_INVALID | n/a | ✅ SUBSCRIPTION_FEATURE_NOT_INCLUDED / PERMISSION_DENIED (SUPERVISOR+) | Chain 起：商店間轉移 |
| GET /api/v1/invoices/health | ✅ | n/a | n/a | ✅ PERMISSION_DENIED (MANAGER+) | 發票狀態檢查 |
| POST /api/v1/invoices/issue-sandbox | ✅ | ✅ INVOICE_ORDER_NOT_READY | n/a | ✅ PERMISSION_DENIED (MANAGER+) | 測試環境發票簽發 |
| POST /api/v1/invoices/:id/mark-uploaded | ✅ | n/a | n/a | ✅ PERMISSION_DENIED (MANAGER+) | 標記已上傳 |
| POST /api/v1/invoices/:id/void-sandbox | ✅ | ✅ INVOICE_VOID_INVALID | n/a | ✅ PERMISSION_DENIED (MANAGER+) | 測試環境發票作廢 |
| GET /api/v1/reconciliation/daily | ✅ | ✅ DATE_RANGE_INVALID | n/a | ✅ SUBSCRIPTION_FEATURE_NOT_INCLUDED / PERMISSION_DENIED (MANAGER+) | Growth 起：日對帳 |
| GET /api/v1/reports/daily | ✅ | ✅ DATE_RANGE_INVALID | n/a | ✅ PERMISSION_DENIED (MANAGER+) | 日報告 + 支付細項 |
| GET /api/v1/reports/payment-breakdown | ✅ | ✅ DATE_RANGE_INVALID | n/a | ✅ SUBSCRIPTION_FEATURE_NOT_INCLUDED / PERMISSION_DENIED (MANAGER+) | Growth 起：支付分析 |
| GET /api/v1/reports/top-products | ✅ | ✅ DATE_RANGE_INVALID | n/a | ✅ SUBSCRIPTION_FEATURE_NOT_INCLUDED / PERMISSION_DENIED (MANAGER+) | Growth 起：熱銷商品排行 |
| POST /api/v1/reports/exports | ✅ | ✅ EXPORT_RANGE_INVALID | ✅ EXPORT_RANGE_TOO_LARGE | ✅ SUBSCRIPTION_FEATURE_NOT_INCLUDED / PERMISSION_DENIED (MANAGER+) | Growth 起：報表生成 + 92 天限制 |
| GET /api/v1/reports/exports/:id | ✅ | n/a | n/a | ✅ SUBSCRIPTION_FEATURE_NOT_INCLUDED / PERMISSION_DENIED (MANAGER+) | Growth 起：查詢匯出狀態 |
| GET /api/v1/reports/exports/:id/download | ✅ | ✅ FILE_EXPIRED | n/a | ✅ SUBSCRIPTION_FEATURE_NOT_INCLUDED / TENANT_NOT_AUTHORIZED | Growth 起：Token 驗證 + 過期檢查 |
| GET /api/v1/print-jobs | ✅ | ✅ PRINT_JOB_STATE_INVALID | n/a | n/a | 列印工作列表 |
| POST /api/v1/print-jobs/:id/retry | ✅ | ✅ PRINT_JOB_NOT_RETRYABLE | ✅ RETRY_LIMIT_EXCEEDED | ✅ PERMISSION_DENIED (MANAGER+) | 列印重試 + 6 次上限 |
| POST /api/v1/customers | ✅ | ✅ CUSTOMER_PHONE_INVALID | n/a | ✅ SUBSCRIPTION_FEATURE_NOT_INCLUDED / PERMISSION_DENIED (CASHIER+) | Growth 起：台灣手機驗證 |
| GET /api/v1/customers/search | ✅ | n/a | n/a | ✅ SUBSCRIPTION_FEATURE_NOT_INCLUDED / PERMISSION_DENIED (CASHIER+) | Growth 起：按電話搜尋 |
| GET /api/v1/coupons | ✅ | n/a | n/a | ✅ SUBSCRIPTION_FEATURE_NOT_INCLUDED / PERMISSION_DENIED (CASHIER+) | Growth 起：活躍折扣券列表 |
| POST /api/v1/coupons/redeem | ✅ | ✅ COUPON_NOT_APPLICABLE | ✅ COUPON_NOT_APPLICABLE | ✅ SUBSCRIPTION_FEATURE_NOT_INCLUDED / PERMISSION_DENIED (CASHIER+) | Growth 起：最低消費檢查 |
| POST /api/v1/customers/points/adjust | ✅ | ✅ POINTS_INVALID | n/a | ✅ SUBSCRIPTION_FEATURE_NOT_INCLUDED / PERMISSION_DENIED (MANAGER+) | Growth 起：點數調整 + 歷史記錄 |
| GET /api/v1/ai/daily-brief | ✅ | n/a | n/a | ✅ SUBSCRIPTION_FEATURE_NOT_INCLUDED / PERMISSION_DENIED (MANAGER+) | Growth 起：AI 日報摘要 |
| POST /api/v1/telemetry/heartbeat | ✅ | ✅ SYNC_STALE | n/a | ✅ SUBSCRIPTION_FEATURE_NOT_INCLUDED / PERMISSION_DENIED (CASHIER+) | Chain 起：終端心跳 + 狀態評估 |
| GET /api/v1/telemetry/dashboard | ✅ | ✅ DEVICE_MISMATCH | n/a | ✅ SUBSCRIPTION_FEATURE_NOT_INCLUDED / PERMISSION_DENIED (MANAGER+) | Chain 起：終端狀態儀表板 |
| GET /api/v1/sync/jobs | ✅ | n/a | n/a | ✅ PERMISSION_DENIED (MANAGER+) | 同步工作列表 |
| POST /api/v1/sync/jobs/:id/retry | ✅ | n/a | ✅ RETRY_LIMIT_EXCEEDED | ✅ PERMISSION_DENIED (SUPERVISOR+) | 同步重試 + 3 次上限 |
| POST /api/v1/sync/jobs/:id/resolve | ✅ | ✅ SYNC_RESOLUTION_INVALID | n/a | ✅ PERMISSION_DENIED (SUPERVISOR+) | 同步解決（標記、放棄） |

## 自動化覆蓋

下列路由由 `scripts/smoke.js` 驗證（5 個基本煙測）：

- 🤖 POST /api/v1/auth/login — 登入成功
- 🤖 POST /api/v1/orders — 訂單建立（冪等）
- 🤖 POST /api/v1/orders/:id (replay) — 訂單重放（冪等衝突檢查）
- 🤖 POST /api/v1/orders/:id/pay/manual — 支付 + 庫存扣減 + 發票
- 🤖 POST /api/v1/orders/:id/void — 訂單作廢（冪等）
