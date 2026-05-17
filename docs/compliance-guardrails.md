# 合規與營運邊界

本文件不是法律意見，而是產品與工程在設計 MVP 前必須遵守的風險邊界。正式上線前需由會計師、稅務顧問、法務與支付合作商確認。

## 1. 電子發票

### 必須做到

- 支援目前財政部電子發票平台要求的 MIG / Turnkey 流程。
- 測試環境與正式環境分離，測試不得使用真實個資或正式營業資料。
- 發票生命週期必須完整：開立、上傳、作廢、折讓、退貨、補印、異常重試。
- B2C、B2B、載具、捐贈碼、統編、分支機構、零稅率等情境需分別驗證。
- 每日必須比對訂單、付款、發票與上傳狀態。
- 發票異常需進 exception queue，不能只寫 log。

### 待專業確認

- 不同交易類型的上傳期限。
- 離線交易可容許的暫存時間與補傳流程。
- 發票字軌在多機台、多門市、斷網時的安全分配方式。
- 加值中心與自建 Turnkey 的責任邊界。
- 紙本電子發票證明聯、載具歸戶、折讓與作廢的實務流程。

### MVP 決策

若團隊尚未具備法遵與維運能力，第一版不自建完整 Turnkey 維運，優先串接成熟電子發票加值中心。

## 2. 支付與 PCI DSS

### 必須做到

POS 與後端不保存：

- 完整卡號 PAN
- CVV
- 磁條或晶片敏感資料
- PIN / PIN block

POS 可保存：

- 金流商
- 交易序號
- 授權碼
- 金額
- 狀態
- 對帳用 correlation id
- `last4`，前提是金流合約與 PCI 顧問確認允許

### MVP 決策

- 刷卡、LINE Pay、街口、信用卡頁面由合格 PSP、刷卡機、hosted checkout 或 SDK 承接。
- 本產品不做 stored value、代收保管、匯款、清算或 merchant-of-record，除非取得法規與合作商確認。
- 不碰原始卡號，降低 PCI DSS 範圍。

## 3. 個資保護

### 涉及個資

- 會員姓名
- 手機
- Email
- LINE UID / 綁定資訊
- 生日
- 消費紀錄
- 儲值、點數、優惠券紀錄
- 發票載具與統編相關資料

### 必須做到

- 蒐集前告知目的、使用範圍、保存期間、第三方接收者與權利行使方式。
- 會員與行銷同意分開，不得把行銷同意包在必要服務條款裡。
- 提供查詢、更正、停止利用、刪除或退會流程。
- 行銷訊息必須提供退訂。
- 匯出資料、客服查詢、跨店查詢都要 audit log。
- 設定資料保存期限與刪除工作，不可無限期保留。
- 建立資安事件與個資外洩通報流程。

### 待專業確認

- SaaS 供應商與店家之間的 controller / processor 角色。
- 跨境雲端儲存與備份位置。
- 行銷、匿名 benchmark、AI 訓練是否需要額外同意。

## 4. 多租戶隔離

### 必須做到

- 所有核心資料表保留 `tenant_id`。
- API 不得信任 client 傳入的 `tenant_id`。
- tenant context 由登入 session、裝置憑證或 API key 推導。
- SQL query、cache key、storage path、queue message 都要 tenant-scoped。
- 內部客服後台跨租戶查詢需二次授權與 audit log。
- 匯出與報表 API 需套用 object-level authorization。

### 建議做到

- PostgreSQL Row Level Security。
- `FORCE ROW LEVEL SECURITY` 評估與測試。
- per-tenant rate limit 與 quota。
- cross-tenant access attempt alert。

## 5. 對外承諾限制

銷售頁與業務話術不得模糊承諾：

- 「完全離線也能開正式電子發票」除非流程已被會計師與發票合作商確認。
- 「支援所有刷卡與支付」除非已完成 PSP 合約與設備測試。
- 「AI 會自動決定備料與促銷」第一版只能稱為建議與提醒。
- 「資料完全匿名可比較同業」除非完成去識別化與反推風險評估。

## 6. 參考來源

- 財政部電子發票平台：`https://www.einvoice.nat.gov.tw/`
- Turnkey / MIG 4.1 自行檢測文件：`https://www.einvoice.nat.gov.tw/static/ptl/ein_upload/download/5440.pdf`
- PCI DSS：`https://www.pcisecuritystandards.org/standards/pci-dss/`
- 個人資料保護法：`https://law.moj.gov.tw/ENG/LawClass/LawAll.aspx?PCode=I0050021`
- OWASP API Security Top 10：`https://owasp.org/API-Security/editions/2023/en/0x11-t10/`
- OWASP Multi-Tenant Security Cheat Sheet：`https://cheatsheetseries.owasp.org/cheatsheets/Multi_Tenant_Security_Cheat_Sheet.html`
