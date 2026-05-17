# 人工補救手冊（Manual Repair Playbook）

本檔說明所有 dead-letter / 例外狀態的補救流程。AGENTS.md 規定每個 retry / dead-letter / exception 必須有「誰補、何時補、怎麼補」；本檔即是該規則的合規清單。

## 角色與責任

| 角色 | 補救權限範圍 |
|------|--------------|
| CASHIER | 無 |
| MANAGER | 補打、訂單退款、現金差額簽核、打印工作重新排隊、渠道訂單狀態同步 |
| SUPERVISOR | 列印機 DEAD_LETTER 重派、現金交班強制過帳、人工發票回補、庫存調整與盤點 |
| ADMIN | Outbox DEAD_LETTER 重放、tenant 資料人工調整、權限授予、遠端 telemetry 檢查 |
| 客服 | 跨租戶查詢（需 audit）、引導店家走流程；無寫入權限 |

---

## 觸發來源與處理流程

每一節含：偵測訊號、影響、補救步驟、責任人、SLA、驗證方式、相關 audit action。

### 1. Outbox DEAD_LETTER（同步阻塞）

- **偵測**：`GET /api/v1/sync/jobs?state=DEAD_LETTER`；auditLogs `OUTBOX_DEAD_LETTER`；syncWorker 6 次嘗試後自動轉移。
- **影響**：訂單已寫入本機但未同步雲端。雲端報表會少。下游系統無法消費訂單事件。
- **補救步驟**：
  1. 客服在後台複製 `jobId` 與 `payloadFingerprint`。
  2. ADMIN 檢視 payload 內容是否仍合法（商品/客戶/金額未被竄改）。若 payloadFingerprint 與現有訂單不符，表示發票或金額已變動，需人工決策。
  3. 呼叫 `POST /api/v1/sync/jobs/{id}/retry` 強制重試（無重試上限檢查，可反復嘗試）。
  4. 若網路仍無法通往雲端（SYNC_STALE / SYNC_JOB_NOT_FOUND），等待 telemetry 復活後重試。
  5. 超過 3 次仍失敗轉人工匯入：產出 CSV，交財務手動補單，於本檔留 `manual_import_ticket` 編號。
- **責任人**：ADMIN + 客服協作。
- **SLA**：24h 內處理；72h 仍未處理升級主管。
- **驗證**：再次查詢 `?state=DONE` 應出現；audit `OUTBOX_ADVANCE` 與 `OUTBOX_DONE` 紀錄。
- **相關 audit action**：`OUTBOX_DEAD_LETTER`, `OUTBOX_ADVANCE`。

### 2. 列印任務 DEAD_LETTER

- **偵測**：`GET /api/v1/print-jobs?state=DEAD_LETTER`；auditLogs `PRINT_JOB_RETRY`；syncWorker 無關（printJobs 由 POS App 推動）；MANAGER 手動呼叫 retry 後 6 次失敗自動轉 DEAD_LETTER。
- **影響**：收據未列印。顧客沒有紙本憑證。稅務對帳時無紙本簽樣。
- **補救步驟**：
  1. MANAGER 在後台查詢 `GET /api/v1/print-jobs?state=DEAD_LETTER&storeId=<storeId>`。
  2. 確認列印機是否在線（檢查 `lastErrorCode` 與 `lastTriedAt`）。
  3. 呼叫 `POST /api/v1/print-jobs/{id}/retry` 重新排隊（POS App 會再次嘗試推送至列印機）。
  4. 若列印機仍離線，MANAGER 手動補打：開啟訂單頁面按「補打收據」，系統重新建立 printJob（state=QUEUED）。
  5. 若列印機永久故障，該 DEAD_LETTER 計入「遺失紙本」audit，需 SUPERVISOR 簽核手動簽樣或電子簽核替代（未來加值中心功能）。
- **責任人**：MANAGER（補打）+ SUPERVISOR（簽核損失）。
- **SLA**：2h 內補打或簽核；超過 8h 未補升級主管。
- **驗證**：printJob state 回到 QUEUED 或 SENT；audit `PRINT_JOB_RETRY` 記錄新的 attempts 值。
- **相關 audit action**：`PRINT_JOB_RETRY`。

### 3. Telemetry UNREACHABLE（設備失聯）

- **偵測**：syncWorker telemetry tick 5 分鐘未收到 heartbeat 就標記 UNREACHABLE；auditLogs `TELEMETRY_UNREACHABLE`；recovery tick 2 分鐘內收到復活訊號轉 OK。
- **影響**：POS App 離線無法交班；新訂單/變動無法上傳；無法確認庫存即時狀態。
- **補救步驟**：
  1. 客服通話與店員確認：POS App 是否當機、WiFi 連線狀態、有無錯誤彈窗。
  2. 一線修復：重啟 POS App（讓它重新發送 heartbeat），或重連 WiFi。
  3. 若 App 版本過舊，引導客戶檢查 App Store / Google Play 更新。
  4. 若 5 分鐘內未復活，ADMIN 遠端檢查 CloudWatch logs 看雲端是否故障；若伺服器好則為網路問題（ISP / 防火牆），MANAGER 確認店內網路。
  5. 若 2 小時仍未復活，SUPERVISOR 可強制過帳交班（override `draftAgeThresholdMs` 或手動標記 DRAFT → AUTO_EXPIRED），並留 audit 備查。
- **責任人**：客服（遠端協助）+ ADMIN（雲端檢查）+ MANAGER（網路排障）。
- **SLA**：首次聯繫 15 分鐘內；復活目標 1 小時。超過 4 小時逆行損害評估。
- **驗證**：telemetry snapshot state 回到 OK；無 TELEMETRY_UNREACHABLE audit 新增。
- **相關 audit action**：`TELEMETRY_UNREACHABLE`, `TELEMETRY_RECOVERED`。

### 4. Channel Order PAYMENT_UNKNOWN（渠道支付狀態不明）

- **偵測**：`PATCH /api/v1/channels/orders/:id/status` 回傳 PAYMENT_UNKNOWN；通常來自 QR / LINE 渠道訂單的 items 欄位無效或外部支付狀態無法確認。
- **影響**：顧客通過 QR / LINE 下單但支付資訊不完整；訂單無法進入結帳流程。
- **補救步驟**：
  1. MANAGER 在後台查詢訂單詳情（`GET /api/v1/orders/:id`），檢視 `channelPayload` 裡的 items 與 payment 欄位。
  2. 若 items 為空或 qty <= 0：人工編輯，補充商品項目，重新呼叫 `PATCH /api/v1/channels/orders/:id/status` with valid items。
  3. 若 items 正確但金額不符（例如QR碼金額與系統商品價格差異）：MANAGER 手動撥打確認，更新金額後重試。
  4. 若外部支付（LINE Pay 等）驗證失敗：MANAGER 要求顧客重新掃碼或重新傳送支付憑據，驗證後呼叫 /channels/orders/:id/status with payment confirmation。
- **責任人**：MANAGER（前線）+ 客服（溝通顧客）。
- **SLA**：接獲投訴後 30 分鐘內聯繫顧客；2 小時內解決。
- **驗證**：order state 從 CREATED 轉至 PAID_PENDING / PAID_CARD；audit `CHANNEL_ORDER_STATUS_CHANGED` 記錄。
- **相關 audit action**：`CHANNEL_ORDER_CREATED`, `CHANNEL_ORDER_STATUS_CHANGED`。

### 5. Reconciliation 三方對帳 Mismatch

對應 `GET /api/v1/reconciliation/daily` 回傳 `reason: PAYMENT_MISSING | INVOICE_MISSING | AMOUNT_DRIFT`：

#### 5a. PAYMENT_MISSING（訂單已開發票但無付款紀錄）

- **偵測**：對帳日報 invoiceSum > 0 but paymentSum = 0；通常為現金被遺漏或刷卡 callback 失敗。
- **補救步驟**：
  1. MANAGER 對照錢櫃記錄或刷卡機簽單，確認現金確實收進或卡片已刷。
  2. 若現金遺漏：補 `POST /api/v1/orders/:id/pay/manual` with method=CASH，金額填對帳差額。
  3. 若刷卡 callback 失敗：MANAGER 從刷卡機匯出交易簽單，確認金額無誤後補 `POST /api/v1/orders/:id/pay/manual` with method=CARD & providerTransactionId。
  4. 復查 reconciliation daily，mismatch 應消失。
- **責任人**：MANAGER。SLA：同一天結帳前修正；隔天必須審核完畢。
- **驗證**：`GET /api/v1/reconciliation/daily?date=<date>` 同一筆訂單 paymentSum 應與 invoiceSum 相等；audit `ORDER_PAID_MANUAL` 記錄新補款。

#### 5b. INVOICE_MISSING（付款完成但發票未開）

- **偵測**：對帳日報 paymentSum > 0 but invoiceSum = 0；訂單已付款但 invoice lifecycle 為 null 或 ERROR。
- **補救步驟**：
  1. SUPERVISOR 檢視訂單 (`GET /api/v1/orders/:id`)，確認 paymentState=PAID。
  2. 呼叫 `POST /api/v1/invoices/issue-sandbox` 補開發票（demo 階段；上線後改用加值中心介接）。
  3. 若發票開立成功，invoices record 應出現且 uploadState=PENDING_UPLOAD。
  4. 復查 reconciliation，AMOUNT_DRIFT 應解除。
- **責任人**：SUPERVISOR。SLA：同一天內補開；逾期需報備稅務相關人員。
- **驗證**：audit `invoices.issue_sandbox` 與 `RECONCILIATION_VIEWED` 的 mismatchCount 應變 0。

#### 5c. AMOUNT_DRIFT（三方金額不一致）

- **偵測**：對帳日報 orderSubtotal, paymentSum, invoiceSum 三者不等；delta = max - min。常見原因：折扣誤算、退款未反映、稅金計算差異。
- **補救步驟**：
  1. MANAGER 逐筆檢視 mismatch 訂單（audit logs 裡找 ORDER_DISCOUNT_APPLIED / ORDER_REFUNDED 等）。
  2. 若發現折扣或退款誤錄：用 `PATCH /api/v1/orders/:id/discount` 或 `POST /api/v1/orders/:id/refund` 更正。
  3. 若金額已鎖定無法再改（訂單已 PAID / VOIDED），ADMIN 需人工查證：比對發票號、收據編號、金流回單，確認實際收款人是誰、金額幾何，留 audit ticket 記錄人工決議（例如「客人溢繳 NT$50, 下次優惠」）。
  4. 若跨日期對帳（例如前日收款、今日開票），檢視 businessDate vs createdAt / paidAt，可能正常；SUPERVISOR 簽核後記為「timing mismatch, no action needed」。
- **責任人**：MANAGER（修正）+ ADMIN（人工決議）。SLA：次日結帳前審核；> NT$500 差異同日內解決。
- **驗證**：audit `RECONCILIATION_VIEWED` 下次查詢應 consistent=true；若仍有 delta，留 audit ticket 號作為人工決議憑證。

### 6. DRAFT_AUTO_EXPIRED（24h 未付款訂單自動過期）

- **偵測**：syncWorker tickDraftExpiry 每 60s 掃描 DRAFT 訂單，若年齡 > draftAgeThresholdMs (default 24h) 轉 AUTO_EXPIRED；auditLogs `DRAFT_AUTO_EXPIRED`。
- **影響**：顧客下單後未付款 / 未結帳。庫存未被扣（DRAFT 不會觸發 inventory ledger）。24h 後自動清理，舊訂單無法再補救。
- **補救流程**：
  1. 通常無需補救；若顧客回頭要結帳，MANAGER 需重新建單（呼叫 `POST /api/v1/orders` 新建 order）。
  2. 如該訂單有特殊記錄價值（例如大額預訂、重要客人），MANAGER 可調整 `storeSettings.draftAgeThresholdMs` 延長過期門檻（例如改成 48h），但需 ADMIN 後台變更，並留 audit ticket。
  3. 若要復活已過期的 DRAFT，系統無 API 支援；需 ADMIN 手動修改 data/store.json 將 order state 改回 DRAFT，然後重啟伺服器。
- **責任人**：MANAGER（引導顧客重新建單）+ ADMIN（調整閾值或資料復原）。
- **SLA**：客訴後 2h 內重新建單；延期調整不超過 7 天。
- **驗證**：審核 auditLogs 的 DRAFT_AUTO_EXPIRED 紀錄；若有復活操作，audit log 應含 manual_override ticket。

### 7. Inventory NEGATIVE_AFTER_MOVE / LEDGER_WRITE_FAILED

#### 7a. INVENTORY_NEGATIVE_AFTER_MOVE（調整造成負庫存）

- **偵測**：`POST /api/v1/inventory/adjustments` 或 `POST /api/v1/inventory/counts` 回傳 INVENTORY_NEGATIVE_AFTER_MOVE；系統在寫 ledger 前即檢查 (next = current ± qty < 0)。
- **影響**：庫存調整失敗，無法進貨/盤點；實務上通常代表實物與系統不符。
- **補救步驟**：
  1. MANAGER 先進行實物盤點，確認現有庫存數量。
  2. 若現有量確實低於預期，需先補進貨：呼叫 `POST /api/v1/inventory/adjustments` with qty > 0 & reason=RECEIVE。
  3. 待盤點完成，再呼叫 `POST /api/v1/inventory/counts` 校正系統值與實物一致。
  4. 若庫存長期不符，SUPERVISOR 可呼叫 `POST /api/v1/inventory/rebuild?dryRun=true` 檢查 ledger 累積誤差，確認後呼叫 rebuild with dryRun=false 強制同步。
- **責任人**：MANAGER（日常盤點）+ SUPERVISOR（ledger rebuild）。
- **SLA**：發現負庫存後 24h 內補進；超過 72h 與進貨商確認。
- **驗證**：audit `INVENTORY_ADJUSTED` 與 `INVENTORY_COUNT_RECORDED` 的 before/after；若有 rebuild，audit `INVENTORY_REBUILT` 紀錄。
- **相關 audit action**：`INVENTORY_ADJUSTED`, `INVENTORY_LEDGER_WRITE_FAILED`, `INVENTORY_COUNT_RECORDED`, `INVENTORY_REBUILT`。

#### 7b. INVENTORY_LEDGER_WRITE_FAILED（ledger 寫入異常）

- **偵測**：`POST /api/v1/inventory/adjustments` 或 `POST /api/v1/inventory/counts` 回傳 INVENTORY_LEDGER_WRITE_FAILED (500 error)；ledger append 拋 exception。
- **影響**：庫存調整完全失敗；ledger 可能部分寫入，導致 projection (inventoryLevels) 與 ledger 源 out of sync。
- **補救步驟**：
  1. 立即聯絡工程團隊檢查伺服器日誌、磁盤空間、data/store.json 權限問題。
  2. 重新嘗試相同調整：若伺服器已恢復，重試 `POST /api/v1/inventory/adjustments` 或 `POST /api/v1/inventory/counts`。
  3. 若問題仍在，暫停所有庫存操作；SUPERVISOR 需人工決策：
     - Option A（推薦）：等伺服器修復，呼叫 `POST /api/v1/inventory/rebuild?dryRun=false` 強制 ledger → projection 同步。
     - Option B：ADMIN 手動編輯 data/store.json 補上遺漏的 ledger row，然後運行 rebuild。
  4. 完成後驗證 inventoryLevels 與 ledger 一致。
- **責任人**：ADMIN（工程）+ SUPERVISOR（人工調整）。
- **SLA**：< 30 分鐘內恢復可寫入狀態；若 > 2 小時仍故障，降級到現金制、停止在線銷售。
- **驗證**：audit `INVENTORY_REBUILT` 紀錄應出現；inventory query 結果應無異常。

### 8. Cash Drawer CASH_SHORTFALL_UNEXPLAINED（現金交班差額）

- **偵測**：`POST /api/v1/cash-drawers/close` 回傳 CASH_SHORTFALL_UNEXPLAINED；variance != 0 且 adjustments[] 為空或缺 reason 欄位。
- **影響**：現金交班卡住，無法進行下一班；無法確認短缺是遺漏、竊盜或計算錯誤。
- **補救步驟**：
  1. SUPERVISOR 要求收銀員（CASHIER）重新清點現金，確認金額。
  2. 若金額與系統預期差額已找到，SUPERVISOR 補送 `POST /api/v1/cash-drawers/close` with adjustments=[{amount: <delta>, reason: "CASH_FOUND"} 或 "CASH_LOST" 或 "COUNTING_ERROR"] 簽核。
  3. 若差額找不到原因，SUPERVISOR 仍需簽核，填 reason="VARIANCE_UNEXPLAINED"，並留 audit ticket 供日後查證。
  4. 連續三班差異累計 > NT$200，ADMIN 調閱 audit logs 檢查有無 CASH_DRAWER_OPENED / PAYMENT 異常，或是現金箱本身故障。
- **責任人**：SUPERVISOR（交班簽核）+ ADMIN（重複失衡調查）。
- **SLA**：當班應在 30 分鐘內處理；超過 1 小時無法開下一班則判為故障。
- **驗證**：audit `CASH_DRAWER_CLOSED` 紀錄應含 variance 與 adjustments；若 variance != 0 需 reason 與簽核人。

### 9. Login LOGIN_RATE_LIMITED（登入鎖定）

- **偵測**：`POST /api/v1/auth/login` 回傳 429 LOGIN_RATE_LIMITED；5 次失敗在 5 分鐘內觸發 15 分鐘鎖定。
- **影響**：使用者暫時無法登入；嘗試破解或誤輸密碼過多。
- **補救步驟**：
  1. 使用者等待 15 分鐘自動解除（response 含 `retryAfterSeconds`）。
  2. 若需急速解除（例如緊急交班），ADMIN 後台清除該租戶 + IP 的登入嘗試計數（in-memory map，重啟亦清除）。
  3. 若同一 IP 反復在多個帳號嘗試，ADMIN 在防火牆層面考慮臨時封鎖（未來加值中心功能）。
- **責任人**：ADMIN（緊急解除）。
- **SLA**：自動解除 15 分鐘；若需人工介入 < 5 分鐘回應。
- **驗證**：再次登入應成功；audit `AUTH_LOGIN_FAILED` 與 `AUTH_LOGIN_SUCCESS` 記錄。
- **相關 audit action**：`AUTH_LOGIN_FAILED`, `AUTH_LOGIN_SUCCESS`。

---

## 通用稽核要求

每次人工補救必須留下 audit row，欄位最少包含：

- `actor` / `userRole` / `tenantId`：誰做的、什麼角色、哪個租戶
- `action`：補救動作名稱（例如 `OUTBOX_DEAD_LETTER`, `PRINT_JOB_RETRY`, `INVENTORY_ADJUSTED` 等）
- `resourceType` / `resourceId`：影響的資源類型與 ID（例如 `OUTBOX_JOB` + job id）
- `before` / `after`：變更前後狀態快照
- `reason` 或 `ticketRef`（可選）：人工補救理由或外部 ticket 號

所有 audit entries 應被 datadog / cloudwatch 收集；支援客服團隊查詢與合規稽核。

---

## 工程進場前注意

本檔列出的所有狀態與 errorCode 須能在 `docs/error-codes.md` 找到對應；新增任何 dead-letter 狀態或補救流程須同步補本檔對應節，否則違反 AGENTS.md 硬規則。

### 欄位對應表

| 狀態 / Error Code | 出現路徑 | 負責人 | 補救 SLA | 驗證方式 |
|-------------------|---------|--------|---------|---------|
| OUTBOX_DEAD_LETTER | syncWorker, 6 attempts | ADMIN | 24h | GET /api/v1/sync/jobs?state=DONE |
| PRINT_JOB DEAD_LETTER | manual retry, 6 attempts | MANAGER | 2h | GET /api/v1/print-jobs?state=QUEUED |
| TELEMETRY_UNREACHABLE | syncWorker, 5 min timeout | 客服+ADMIN | 1h | auditLogs TELEMETRY_RECOVERED |
| PAYMENT_UNKNOWN | POST /channels/orders | MANAGER | 2h | PATCH /channels/orders/:id/status success |
| RECONCILIATION mismatch | GET /reconciliation/daily | MANAGER+ADMIN | 24h | GET /reconciliation/daily consistent=true |
| DRAFT_AUTO_EXPIRED | syncWorker, 24h | MANAGER | redeploy | auditLogs DRAFT_AUTO_EXPIRED |
| INVENTORY_NEGATIVE | POST /inventory/adjustments | MANAGER | 24h | POST /inventory/rebuild dry run |
| INVENTORY_LEDGER_WRITE_FAILED | POST /inventory/counts | ADMIN | 30 min | POST /inventory/rebuild dryRun=false |
| CASH_SHORTFALL_UNEXPLAINED | POST /cash-drawers/close | SUPERVISOR | 30 min | CASH_DRAWER_CLOSED audit |
| LOGIN_RATE_LIMITED | POST /auth/login 429 | ADMIN | 15 min auto | POST /auth/login success |

---

## 補救流程決策樹（Quick Reference）

```
系統回傳 errorCode 或偵測到異常狀態
  ├─ OUTBOX_DEAD_LETTER → 呼叫 ADMIN，檢查 payload + retry
  ├─ PRINT_JOB DEAD_LETTER → MANAGER 補打或 retry
  ├─ TELEMETRY_UNREACHABLE → 客服遠端通話 + 重啟 POS App
  ├─ PAYMENT_UNKNOWN → MANAGER 驗證渠道支付資訊
  ├─ RECONCILIATION mismatch
  │   ├─ PAYMENT_MISSING → 補 payment record
  │   ├─ INVOICE_MISSING → SUPERVISOR 補開發票
  │   └─ AMOUNT_DRIFT → MANAGER 逐筆檢查 + ADMIN 人工決議
  ├─ DRAFT_AUTO_EXPIRED → 客戶重建訂單或 ADMIN 延期設定
  ├─ INVENTORY_NEGATIVE_AFTER_MOVE → MANAGER 補進貨
  ├─ INVENTORY_LEDGER_WRITE_FAILED → ADMIN 伺服器復原 + rebuild
  ├─ CASH_SHORTFALL_UNEXPLAINED → SUPERVISOR 清點簽核 + adjustments
  └─ LOGIN_RATE_LIMITED → 等 15 分鐘或 ADMIN 清除

所有補救完成後
  → 檢查對應 audit log 是否記錄
  → 驗證狀態轉移（例如 DEAD_LETTER → DONE）
  → 必要時留 manual_ticket 供後續審計
```

---

**版本**: 1.0  
**最後更新**: 2026-05-16  
**維護人**: ADMIN / POS 系統團隊
