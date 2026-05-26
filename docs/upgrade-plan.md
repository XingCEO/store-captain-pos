# 店長 AI POS 修補與升級計畫

**執行原則（強制遵守）**
- 嚴格執行 `docs/ai-engineering-rules.md`：每張正式票務必須寫滿 9 欄位 + 待確認事項。
- 嚴格遵守 `docs/high-risk-workstreams.md` go/no-go gate。Phase 0 與 Phase 1 不得碰正式電子發票、正式金流、AI 自動決策、多店總部、完整 BOM。
- 所有修補優先「把已正確的骨架變得能 pilot 用 + 可長期演進」，而非急著加新功能。
- 驗收必須包含：happy path + 至少一個壞輸入/重試/衝突/權限拒絕 + 手動 QA + audit 覆蓋。

## 階段定義

**Phase 0：基礎硬化**  
目標：消除已知會導致安全事件、資料不一致、維運盲區的問題。  
不碰任何高風險 gate 項目。

**Phase 1：Pilot 可用**  
目標：5-10 家真實店家可穩定使用，問題可透過手動 repair playbook 處理。  
仍以手動/簡易流程為主。

**Phase 2：Gate Clearance 與生產整合**  
前提：外部確認完成 + gate 簽核後才啟動。  
目標：通過 `high-risk-workstreams.md` 對應 gate，接真實加值中心與 PSP。

**Phase 3：規模化與差異化**  
AI v1（有依據建議）、多店 v1、完整進銷存。

## Phase 0 優先修補項目（建議順序）

| 優先 | 項目 | 目前狀態 | 主要風險 | 驗收關鍵 |
|------|------|----------|----------|----------|
| P0-1 | Auth 生產級強化（httpOnly cookie + MFA 持久化 + device binding） | Bearer 只走 header；MFA challenge 存在記憶體 | XSS 偷 token、重啟丟挑戰、無法防 device 偽造 | 通過 XSS 測試、MFA challenge 重啟後仍有效、device 簽章驗證 |
| P0-2 | Persistence 抽象層 + Postgres runtime 完整路徑 | SQLite snapshot 為主；PG 只 mirror audit + 測試 | 單機 SQLite 無法支撐多機台 pilot 並發 | 切換 `STORE_BACKEND=postgres` 後全測試通過 + RLS 生效 |
| P0-3 | 監控與可觀測性基礎接線 | OpenTelemetry/Sentry/Prometheus client 有 init，但無 collector/alert/保留 | 上線後完全看不見錯誤與效能 | Sentry 真實事件上報、Prometheus 指標可 scrape、結構化 log 含 tenant_id |
| P0-4 | 關閉 qa-matrix 剩餘黃色項目 | 多個 endpoint 仍缺壞輸入/重試/權限案例驗證 | 回歸風險 | qa-matrix 全綠 + smoke.js 通過 |
| P0-5 | infrastructure-todo P0 可在本機完成的項目（TLS 強制、X-Forwarded-For trust、request timeout 等） | 部分已做，部分仍缺 | 生產環境基本安全缺失 | 生產模式啟動無錯誤、security headers + HSTS 生效 |

## Phase 1 優先項目（Pilot 就緒）

- **P1-1**：至少一條可實際出單的硬體路徑（thermal printer driver + cash drawer 控制）。
- **P1-2**：手動發票流程 + 每日對帳 SOP 完整可執行（含異常手動補救）。
- **P1-3**：Sync worker + dead-letter + manual repair playbook 實戰演練（至少跑過真實斷網回補）。
- **P1-4**：完成真實店家訪談 + 鎖定第一個店型模板（飲料/早餐）+ 菜單匯入實測。
- **P1-5**：基本 LINE 老闆日報（規則型）可發送。

## Phase 2 前置條件（必須先完成，否則不得進入）

- `docs/partner-confirmation-checklist.md` 所有項目有書面回覆或簽核。
- 電子發票：會計師 + 加值中心確認 MIG 4.1 / Turnkey 3.2 支援範圍 + 離線補傳策略。
- 支付：PSP / LINE Pay merchant 核准 + PCI SAQ 類型確認。
- 法務/個資文件（DPA、隱私政策、資料保存政策）完整。
- 只有上述全部完成，才可開始真實 adapter 開發。

## 詳細票務範例（Phase 0-1 直接可用格式）

### T0-AUTH-01：Auth 生產級強化

**背景**：目前 bearer token 只透過 `Authorization` header 傳輸，MFA challenge 存在記憶體，無 device binding，無法通過生產安全審查與 XSS 攻擊面。

**目標**：login 回傳 httpOnly + Secure + SameSite=Strict cookie；MFA challenge 持久化到 DB（含 TTL + 清理）；支援 `x-device-id` 簽章驗證（可選）。

**不做範圍**：不改現有 PIN 流程；不做 OAuth / 第三方 IdP（Phase 2 再評估）。

**資料表/API/畫面**：
- 新增 sessions 表擴充欄位（refresh_token_hash、device_id、last_used_at）。
- 新增 MFA challenges 持久化表。
- 後端 middleware 強制 cookie 模式（可透過 flag 漸進切換）。
- 前端 login.js 改用 `credentials: 'include'`。

**狀態與錯誤**：新增 `AUTH_TOKEN_INVALID`、`MFA_CHALLENGE_EXPIRED`、`DEVICE_ATTESTATION_FAILED`。

**權限與租戶隔離**：所有 session 操作必須 tenant-scoped；refresh rotation 觸發全 family 撤銷。

**稽核與監控**：每次 login、refresh、MFA 成功/失敗、device 綁定都寫 `audit_logs`（含 ip、user_agent、device_id）。

**測試案例**：
- Happy path：cookie 登入 + MFA + refresh rotation。
- 壞輸入：偽造 cookie、過期 challenge、重用已輪換 refresh token。
- 權限：未驗證 device 簽章拒絕。
- 邊界：重啟後 challenge 仍有效。

**手動 QA**：用真實瀏覽器 + Postman 模擬 XSS 偷 header（應失敗）。

**上線/回滾**：雙模式 flag（HEADER_BEARER / COOKIE_ONLY），失敗可快速切回舊模式。

**待確認事項**：
- Cookie 對現有前端（含 Service Worker）影響評估 — 負責人：前端負責人。
- 是否需要 CSRF token 雙提交 — 負責人：安全顧問。

（其餘票務以同格式撰寫，完整版可直接拆 Jira）

## 外部確認需求清單（與文件對齊）

1. 會計師：電子發票 B2C/B2B 範圍、離線開立責任歸屬。
2. 加值中心（Ecpay/EZpay 等）：MIG 4.1 / Turnkey 3.2 支援與測試環境時程。
3. 支付商（PSP / LINE Pay）：merchant 申請與 PCI 邊界。
4. 法務：DPA、個資蒐集告知、跨境風險評估。
5. 真實店家 10-15 家：訪談 + pilot 意願確認。

## 成功指標（Phase 1 結束時）

- 5 家以上店家連續營業，無遺失訂單、無重複付款。
- 所有高風險操作（作廢、退款、開錢櫃、折扣）皆有完整 audit + 可追溯。
- 斷網交易恢復後同步完成且無衝突。
- Sentry 可看到真實錯誤，Prometheus 指標可查詢。
- qa-matrix 100% 綠燈。

## 下一步行動

1. 決定 Phase 0 第一張票（強烈建議從 T0-AUTH-01 或 Persistence 抽象層開始）。
2. 補齊 `docs/partner-confirmation-checklist.md` 的負責人與期限。
3. 安排真實店家訪談（這是目前最大產品風險缺口）。

---

此文件為可執行規格，後續所有修補與升級工作應以此為依據，並持續更新待確認事項與驗收狀態。