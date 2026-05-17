# 店長 AI POS 文件集

本專案是「AI 雲端 POS + 線上點餐 + 電子發票 + 會員行銷 + 庫存管理 + 老闆營運助理」的產品藍圖文件。

定位不是再做一套便宜 POS，而是建立一套小店買得起、成長後不用換系統、能用 AI 協助營運決策的店務作業系統。

## 核心主張

> 小店付得起，連鎖也夠用的 AI POS。

> 別人的 POS 幫你收錢，我們的 POS 幫你賺錢。

## 文件導覽

- `docs/product-plan.md`：產品定位、客群、功能模組、商業模式與 MVP 路線圖。
- `docs/architecture.md`：系統架構、離線同步、資料模型、資安與硬體策略。
- `docs/problem-review.md`：這份計畫目前的問題、風險、缺口與修正建議。
- `docs/roadmap.md`：0 到 12 個月的產品與工程路線圖。
- `docs/compliance-guardrails.md`：電子發票、支付、個資與多租戶的合規邊界。
- `docs/ai-engineering-rules.md`：AI 與工程協作的不可偷工減料硬規則。
- `docs/high-risk-workstreams.md`：電子發票、金流、AI、總部、庫存、benchmark 的高風險工作流。
- `docs/partner-confirmation-checklist.md`：會計師、律師、支付商、電子發票商、AI/資料顧問確認清單。
- `docs/research-notes.md`：市場、法規、資安與技術參考來源。
- `docs/implementation-kickoff-tickets.md`：工程進場 Sprint 0-1 票務清單與驗收門檻。

## 建議第一階段目標

先聚焦早餐店、飲料店、小吃店、便當店、咖啡小店，不要一開始打大型連鎖或全產業。

第一個可銷售版本應完成：

- POS 收銀
- QR / LINE 點餐
- 自動出單
- 商品與菜單後台
- 現金與手動支付記錄
- 電子發票串接路線確認
- 開班交班
- 日營收報表
- AI 菜單匯入
- LINE 老闆日報
- 基本離線交易

## 目前最重要的風險

計畫有市場機會，但不能低估四件事：

- 電子發票不是功能清單項目，而是持續合規與營運責任。
- 離線 POS 的難點不在本機可點餐，而在付款、發票、庫存、同步衝突和客服處理。
- NT$399 起若包含太多客服與法遵成本，毛利會被吃掉。
- AI 日報與備料建議若沒有足夠資料品質，早期應先做規則型洞察，不應承諾全自動決策。
