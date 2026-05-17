# 研究備註與來源

本文件整理目前用於產品藍圖的外部證據。價格與法規具有時效性，正式對外簡報前需要再次查證。

## 市場與競品

### iCHEF

來源：`https://www.ichefpos.com/zh-tw/pricing`

重點：

- 公開頁顯示 POS 月費 NT$1,950 起。
- 開通費 NT$990。
- 擴充台最低 NT$1,000/月起。
- 核心功能包含 POS、報表、會員、電子發票等。
- 掃碼點餐、LINE 點餐、線上外帶等進階功能可能採加購或按量方案。

產品含意：

- 完整型 POS 價格帶明顯高於 NT$399。
- 若要低價切入，必須用自助導入與功能分級降低服務成本。

### SWD Order / 上萬點

來源：`https://swdorder.com/` 及公開比較文搜尋結果。

重點：

- 公開市場資訊常見 NT$399-499 入門月租、不抽成、不綁約、14 天試用等主張。
- 主力是 LINE 點餐、掃碼點餐、自助點餐與自有通路接單。

產品含意：

- 小店對低月租、不抽成、快速上線高度敏感。
- 單純低價已不是差異化；必須證明「比接單工具更完整」。

### 其他競品與替代品

搜尋結果出現：

- 肚肚 Dudoo
- 快一點
- Eats365
- Simpos
- new2POS
- OKSHOP
- MENU爸
- TAKOPOS
- Posify
- Square
- Liqid
- eGo

產品含意：

- 台灣 POS 市場不是空白市場，是紅海。
- 競爭重點不是列更多功能，而是鎖定店型、快速導入、穩定現場、低客服成本。
- 零售與餐飲需求差異大，不應第一版同時深做。

## 電子發票

### MIG 4.1 / Turnkey 3.2

來源：

- 財政部電子發票整合服務平台文件搜尋結果：`https://www.einvoice.nat.gov.tw/`
- Turnkey 上線前自行檢測作業 PDF 搜尋結果。
- 綠界、鼎新、正航等公告。

重點：

- 電子發票上傳需符合 MIG 4.1。
- Turnkey 需升級到 3.2 相關版本。
- 舊 MIG 版本在 2026 起不再被接受的公告已被多家業者引用。
- 上線需完成測試與通行碼流程。
- B2C 會員載具機制還涉及歸戶測試。

產品含意：

- 電子發票是高風險模組，不能晚期才補。
- 若第一版自建，需投入法規追蹤、測試、維運、異常處理。
- 早期較務實做法是串接加值中心，並保留未來自建 Adapter 的架構。

## 支付與 PCI DSS

來源：

- PCI SSC：`https://www.pcisecuritystandards.org/standards/pci-dss/`
- PCI DSS v4.0.1 公告：`https://blog.pcisecuritystandards.org/just-published-pci-dss-v4-0-1`
- PCI SAQ 文件庫：`https://www.pcisecuritystandards.org/document_library/`

重點：

- PCI DSS 適用於儲存、處理或傳輸 cardholder data 或 sensitive authentication data 的實體。
- POS 若處理完整卡號、CVV、磁條資料，合規範圍會大幅增加。
- SAQ C 類型常涉及連網 POS 且不儲存電子帳戶資料的商戶情境。

產品含意：

- 新創第一版應避免碰完整卡號與敏感認證資料。
- 刷卡與行動支付交由合格金流、刷卡機、SDK 或 hosted payment flow。
- POS 只保存交易序號、授權碼、金額與狀態。

## API 與多租戶資安

來源：

- OWASP API Security Top 10 2023：`https://owasp.org/API-Security/editions/2023/en/0x11-t10/`
- OWASP API1 Broken Object Level Authorization：`https://owasp.org/API-Security/editions/2023/en/0xa1-broken-object-level-authorization/`
- OWASP Multi-Tenant Security Cheat Sheet：`https://cheatsheetseries.owasp.org/cheatsheets/Multi_Tenant_Security_Cheat_Sheet.html`

重點：

- API1:2023 是 Broken Object Level Authorization。
- 每個使用 object ID 存取資料的 API 都應檢查使用者是否有權操作該物件。
- 多租戶 SaaS 不可信任 client 傳入 tenant_id。
- tenant_id 必須出現在 query、cache key、storage path、queue message 等隔離邊界。

產品含意：

- tenant isolation 是第一版基礎建設，不是企業版功能。
- 任何報表、匯出、客服後台、內部工具都需 tenant-aware。

## 個資與雲端

來源：

- 台灣個人資料保護法英譯：`https://law.moj.gov.tw/ENG/LawClass/LawAll.aspx?PCode=I0050021`
- AWS Taiwan Data Privacy：`https://aws.amazon.com/compliance/taiwan-data-privacy/`
- Google Cloud Taiwan PDPA：`https://cloud.google.com/security/compliance/pdpa-taiwan`

重點：

- 個資蒐集、處理、利用需有特定目的與適法基礎。
- 應採取適當安全維護措施。
- 會員資料、手機、生日、消費紀錄、LINE 綁定都屬於需嚴格管理的個資。

產品含意：

- 會員與行銷功能需要清楚告知、同意、退訂與資料刪除流程。
- 匿名 benchmark 必須確實去識別化與聚合，不可讓單店被反推。

## 離線同步與 POS 架構

來源：

- Offline-first POS Architecture, SaleFlex：`https://saleflex.dev/offline-first-pos/`
- IndexGrid offline-first-sync-queue GitHub 搜尋結果。
- React Native / SQLite offline sync queue 技術文章搜尋結果。
- Epson ESC/POS Command Reference：`https://download4.epson.biz/sec_pubs/pos/reference_en/escpos/index.html`

重點：

- POS 離線架構常以本機 SQLite 作為操作資料來源。
- 本機 write + outbox enqueue 應在同一 transaction。
- client 與 server 都要做 idempotency。
- sync worker 需有 retry、backoff、dead letter。
- ESC/POS 是熱感印表機常見命令系統，Epson 提供命令參考與範例。
- 離線同步應以 append/replay 的 command 或 event 為核心，不應做 local SQLite 與 cloud PostgreSQL 的直接 CRUD row overwrite。
- Idempotency key 需綁定 tenant、store、terminal、operation 與 payload fingerprint；同 key 不同 payload 必須拒絕。
- 庫存應以 `stock_ledger` 為真實來源，`stock_balance` 只作為 projection / cache。
- KDS 應訂閱訂單事件或工作站事件，不應直接輪詢訂單資料表。

產品含意：

- 離線不是「網路失敗後暫存一下」，而是一套資料一致性設計。
- 印表機支援需要建立認證硬體清單與測試矩陣。

## 待二次查證

正式商業計畫或投資簡報前，需要再確認：

- 每家競品最新正式價格與加購項目。
- 電子發票 MIG / Turnkey 最新公告、上線流程與加值中心合約條件。
- LINE Pay、街口、信用卡收單合作條件。
- PDPA 與消保相關告知、同意、退訂、資料刪除要求。
- 各店型願付價格與最痛場景。
