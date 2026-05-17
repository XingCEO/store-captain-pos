# 高風險工作流執行規格

本文件整理目前不能偷工、不能直接衝 production build 的 7 條高風險工作流。每條工作流都要先通過 go/no-go gate，才能進正式開發。

## 0. 總門檻

任何高風險功能進 Sprint 前，必須具備：

- 明確責任人。
- 書面範圍與不做範圍。
- 法務、會計師或合作商待確認清單。
- API / 資料 / 狀態 / 錯誤碼 / 稽核規格。
- 測試案例與手動 QA 流程。
- 上線、監控、回滾、人工補救流程。

## 1. 正式電子發票上線

### MVP 安全範圍

- 單一公司、單一店別、單一路徑。
- 優先串接電子發票加值中心。
- 支援開立、上傳、作廢、退貨、折讓、補印、失敗重試。
- 建立發票健康儀表板與每日對帳。

### 暫不做

- 多公司、多品牌、多門市共享字軌。
- 複雜 B2B 交換。
- 複雜會員載具歸戶。
- 自建完整 Turnkey 維運。

### Go gate

- 會計師確認首版 B2C / B2B 範圍。
- 加值中心確認支援 MIG 4.1 / Turnkey 3.2。
- 測試環境完成開立、作廢、折讓、補傳測試。
- POS 離線補傳與去重設計通過。
- 發票、訂單、付款金額可每日對帳。

### No-Go

- 沒有 upload SLA / retry SLA。
- 沒有字軌分配策略。
- 沒有作廢、折讓、失敗重送流程。
- 沒有會計師或加值中心書面確認。

## 2. 正式金流 / 刷卡 / LINE Pay

### MVP 安全範圍

- 一個 card PSP/acquirer。
- LINE Pay online 或 offline API 擇一先做。
- POS 不碰完整卡號、CVV、磁條資料或 PIN block。
- Payment Adapter 與 POS 核心、庫存、會員隔離。

### 必存對帳欄位

- `merchantOrderId`
- `providerTransactionId`
- `paymentProvider`
- `method`
- `amount`
- `currency`
- `terminalId`
- `storeId`
- `cashierId`
- `settlementDate`
- `fee`
- `netSettledAmount`
- `status`
- `failureCode`
- `originalPaymentReference`

### Go gate

- PSP / acquirer / LINE Pay merchant approval 完成。
- PCI scope 與 SAQ 類型確認。
- 測試環境通過成功、失敗、取消、退款、重送、重複單號。
- 對帳可用 `orderId ↔ transactionId ↔ settlementId` 對起來。
- log 已驗證不含敏感卡資料。

### No-Go

- raw card data 進 DB、log 或 analytics。
- 無法每日 close settlement。
- 不知道誰是 merchant of record。
- 不知道 chargeback / refund / dispute 責任人。

## 3. AI 備料、促銷、自動決策

### 成熟度階梯

| 階段 | 功能 | 可否 MVP |
| --- | --- | --- |
| L0 | 資料整理與固定報表 | 可 |
| L1 | 營運摘要 | 可 |
| L2 | 異常提醒 | 可 |
| L3 | 有依據的建議草稿 | 限制性可 |
| L4 | 產生待核准草稿 | 後期 |
| L5 | 自動執行 | 不可 MVP |

### MVP 安全範圍

- AI 日報。
- 銷售摘要。
- 庫存風險提醒。
- 備料建議草稿。
- 促銷成效回顧。

### 禁止 MVP

- 自動下供應商訂單。
- 自動改價格。
- 自動發優惠券或促銷。
- 自動決定備料量並派工。

### Go gate：摘要到建議

- 至少 30-60 天可用銷售資料。
- 商品、訂單、退貨、作廢、庫存資料品質通過。
- AI 建議能列出依據資料與時間窗。
- 資料不足時能 abstain。

### Go gate：建議到半自動

- 建議有 approve / reject / edit。
- 有成本、數量、折扣、毛利上限。
- 有推薦結果回收資料。
- 沒有高嚴重度商家損失事件。

### No-Go

- AI 不能說明依據。
- BOM 或庫存盤點缺失卻輸出備料建議。
- 用營收上升代替毛利改善。
- 沒有人工核准與 kill switch。

## 4. 多店加盟總部

### MVP 安全範圍

- `Tenant → Brand/Region/Store Group → Store` 階層。
- scoped roles。
- 中央菜單。
- 中央 price book。
- scheduled publish。
- rollback。
- store-level sold-out / availability override。
- 基本跨店報表。
- immutable audit log。

### Override 模式

| 模式 | 用途 |
| --- | --- |
| Locked | 門市不可改 |
| LocalAllowed | 門市可直接改 |
| ApprovalRequired | 門市申請，總部核准 |
| Temporary | 到期自動還原 |
| LocalOnly | 只屬於門市 |

### Go gate

- tenant / franchise isolation 測試通過。
- permission matrix 通過。
- 中央 publish 以完整版本抵達 POS。
- rollback 可回 last-good version。
- 離線 POS 不會吃到半套菜單或價格。
- 高風險變更都有 actor、diff、scope、approval、version。

### No-Go

- rollback 只能人工改 DB。
- audit log 不完整。
- local POS 可能半更新。
- franchisee 可以看到其他 franchisee 資料。

## 5. 完整進銷存 / BOM

### MVP 安全範圍

- immutable `stock_ledger`。
- `stock_balance` 只作 projection。
- purchase receipt。
- stock transfer。
- waste / scrap。
- batch + expiry。
- FEFO。
- single-level recipe BOM。
- sale-time ingredient deduction。
- offline stock event outbox。
- basic FIFO / AVCO costing。

### 暫不做

- multi-level BOM。
- work order / production routing。
- advanced landed cost。
- forecasting / auto-replenishment。
- serial-number tracking。
- AI 採購自動化。

### Go gate

- 銷售、退貨、報廢、調撥、盤點都可形成 movement。
- duplicate stock event 不會 double-deduct。
- BOM version 變更不影響歷史訂單。
- FEFO 測試通過。
- 離線 stock event 回同步可對帳。

### No-Go

- 直接改庫存餘額當真相。
- 沒有 movement audit。
- 沒有 UOM / rounding 規則。
- 沒有負庫存與批號異常流程。

## 6. 匿名同業比較 Benchmark

### MVP 安全範圍

- opt-in 小型封閉試點。
- 月報或季報。
- 只顯示區間、分位數、粗分類趨勢。
- 指標限：客單、等待時間、營收區間、訂單量。
- 對外 benchmark 建議 k ≥ 10，最低不得低於 k ≥ 5。

### 禁止

- 單店排行。
- 店名或可回推 ID。
- 即時或近即時價格、毛利、產能、SKU 指標。
- 小樣本 cell 的平均值或極值。
- 可推回競品定價、補貨、人力、促銷策略的輸出。

### Go gate

- opt-in / contract 完成。
- DPIA / re-identification assessment 完成。
- 每個 release cell 都達門檻。
- 無價格、容量、客戶、SKU 級敏感輸出。
- 競爭法與隱私法顧問 sign-off。

### No-Go

- 任一 cell 低於門檻。
- 能回推單店或單租戶。
- 沒有明示 opt-in。
- 沒有撤回、刪除、事故流程。

## 7. 法務 / 個資 / 合規

### 必備文件

- 隱私權政策。
- 個資蒐集告知。
- 服務條款。
- 電子支付服務條款。
- DPA / 委外處理契約。
- 資料保存與刪除政策。
- 資安事件應變 SOP。
- AI 使用政策。
- 匿名化/去識別化標準。

### Go gate

- 資料流向圖完成。
- controller / processor 角色確認。
- 跨境與雲端風險確認。
- AI / benchmark 資料使用目的確認。
- 外洩通報與刪除流程可執行。

### No-Go

- 未完成隱私告知就收會員資料。
- 未完成跨境評估就送海外 AI / analytics。
- 未確認合法基礎就用交易資料訓練模型。
- 未簽 DPA 就委外處理個資。
