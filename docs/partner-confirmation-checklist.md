# 合作商與顧問確認清單

本文件用於發給會計師、律師、電子發票加值中心、支付商、PSP、LINE Pay、AI/資料顧問。所有回答都應留下書面紀錄，並連回決策文件。

## 1. 會計師確認清單

### 電子發票

- 首版是否 B2C-only？是否需要 B2B？
- 無載具時是否必須印紙本證明聯？
- 退貨、作廢、折讓流程是否符合法規與稅務實務？
- 離線交易最晚多久要完成上傳？
- 發票、訂單、付款金額每日對帳格式是否足夠？
- 字軌、空白未使用字軌、分支機構配號怎麼處理？

### 支付與對帳

- PSP settlement 檔案需要哪些欄位才能入帳？
- refund、partial refund、void 與 chargeback 的帳務分錄怎麼做？
- 手續費、稅、net settled amount 如何入帳？
- 電子發票金額與支付金額不一致時如何處理？

### 庫存與成本

- FIFO / AVCO 選哪一種做會計口徑？
- 報廢、盤點差異、員工餐、試吃、耗損如何入帳？
- BOM 成本是管理報表還是正式會計成本？

## 2. 律師確認清單

### 平台法律定位

- 本產品是否只是 SaaS 技術服務？
- 是否碰到電子支付機構、代收代付、stored value、merchant-of-record 風險？
- LINE Pay、信用卡、電子支付合作模式下，責任邊界如何寫？

### 合約

- 服務條款是否涵蓋停權、資料匯出、資料刪除、服務中斷、責任限制？
- 是否需要獨立 DPA / 委外處理契約？
- 是否需要 AI 使用條款、benchmark opt-in 條款？
- 電子發票、支付、第三方 API 失效時的責任如何切分？

### 個資與跨境

- 會員資料、交易資料、發票資料、LINE UID 是否都已明確告知？
- 跨境雲端、境外客服、境外 AI API 是否可用？需要什麼條款？
- benchmark 聚合資料是否仍可能被視為個資或營業秘密？

## 3. 電子發票加值中心確認清單

- 是否完整支援 MIG 4.1 / Turnkey 3.2？
- 是否提供 sandbox？
- 是否支援 API 開立、作廢、折讓、退貨、補印？
- 是否支援 B2C、B2B、載具、捐贈碼、統編？
- 是否支援離線補傳與 idempotency？
- 失敗單、重送單、重號單怎麼查？
- 是否提供 upload result callback / webhook？
- 是否提供每日對帳報表？
- 憑證過期、規格改版、平台維護時誰通知？
- SLA、RTO、RPO、客服時段是什麼？

## 4. PSP / Acquirer / LINE Pay 確認清單

- 誰是 merchant of record？
- 誰收單、誰清算、誰負責 chargeback？
- 我們是否接觸任何 raw card data？
- 我們適用 SAQ A、SAQ A-EP，還是更高範圍？
- 是否提供 sandbox？
- 是否支援 auth、capture、void、refund、partial refund？
- 是否支援 duplicate `orderId` 防重？
- timeout / duplicate callback / unknown status 怎麼查？
- settlement 檔案欄位有哪些？
- 是否提供 `terminalId`、`storeId`、`cashierId`、`batchId`？
- LINE Pay online / offline API 選哪一種？
- LINE Pay `paymentProvider` 的 TSP / EPI 如何入帳與報表？

## 5. AI / 資料顧問確認清單

- AI 是否只用 tenant-scoped data？
- 哪些資料可進 LLM？哪些禁止？
- 是否允許第三方 AI 供應商保存或訓練資料？
- AI 建議需附哪些 evidence？
- 資料不足時 abstain 規則是什麼？
- 自動下單、自動改價、自動促銷需要哪些 go/no-go 指標？
- recommendation outcome 如何回收？
- AI 錯誤造成營運損失的責任如何切分？

## 6. Benchmark 顧問確認清單

- 是否採 opt-in？是否可撤回？
- k 值門檻採多少？建議外部輸出至少 k ≥ 10。
- 是否使用 suppression、generalization、分位數、區間化？
- 是否禁止價格、毛利、SKU、即時營運指標？
- 是否完成 re-identification assessment？
- 是否有競爭法風險？
- 是否禁止使用 benchmark 做競品定價、促銷、人力推測？

## 7. 書面確認格式

每個外部確認都要留下：

```text
確認主題：
確認人 / 單位：
日期：
問題：
回覆：
限制條件：
影響文件：
未通過前禁止事項：
附件 / URL / 合約條款：
```
