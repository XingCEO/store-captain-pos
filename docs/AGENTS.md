# docs AGENTS

## OVERVIEW

`docs/` 是可執行規格庫；每份文件要能拆成任務、測試、決策或外部確認。

## STRUCTURE

| Area | Files | Use |
|------|-------|-----|
| 產品 / 市場 | `product-plan.md`, `problem-review.md`, `roadmap.md`, `research-notes.md` | 定位、價格、MVP、風險、來源 |
| 架構 / 工程 | `architecture.md`, `implementation-kickoff-tickets.md`, `infrastructure-todo.md` | API、資料、同步、部署前缺口 |
| 合規 / 高風險 | `compliance-guardrails.md`, `high-risk-workstreams.md`, `partner-confirmation-checklist.md` | go/no-go gate、外部書面確認 |
| QA / 維運 | `qa-matrix.md`, `error-codes.md`, `manual-repair-playbook.md` | 驗收矩陣、錯誤碼、人工補救 |
| 協作品質 | `ai-engineering-rules.md` | 禁用語、9 欄規格、Definition of Done |

## WHERE TO LOOK

| Task | Start Here | Notes |
|------|------------|-------|
| 新規格 / 新票務 | `ai-engineering-rules.md` + `implementation-kickoff-tickets.md` | 必須填完整欄位 |
| 高風險功能 | `high-risk-workstreams.md` | 未過 gate 不得啟動正式版本 |
| 法規 / 合作商問題 | `partner-confirmation-checklist.md` | 回覆要有書面來源 |
| API 錯誤碼 | `error-codes.md` | 新碼前先查重 |
| 驗收補齊 | `qa-matrix.md` | happy / bad input / retry-conflict / permission |
| dead-letter / 例外 | `manual-repair-playbook.md` | 必須寫誰補、何時補、怎麼補 |

## CONVENTIONS

- 文件用繁體中文；必要技術名詞保留英文。
- 每個功能最少要寫：目的、使用者、範圍、狀態、權限、資料、例外、稽核、驗收、風險。
- 工程設計最少要寫：API contract、schema、error codes、DB/indexes、idempotency、tenant scope、permission、audit、retry/dead-letter、observability、rollback、manual repair。
- 外部事實（價格、法規、API 能力、SLA）要附來源與查證日期。
- 不確定事項用「待確認」格式：問題、確認人、確認來源、未確認前禁止、影響文件/功能。
- 對外文案不可過度承諾；實作狀態需依事實標示，不得強制降級成非正式狀態。
- Agent 回覆預設最小化：先結論、少敘述、無寒暄；只列必要證據、驗收、阻塞。

## ANTI-PATTERNS

- 禁用「等等」、「之類」、「相關」、「一些」、「基本上」、「視情況」、「後續補」、「先簡單做」、「暫時先這樣」、「應該可以」、「大概」、「有需要再做」、「以後優化」。
- 不得把發票、金流、個資、多租戶、資安、資料一致性寫成後補。
- 不得只寫「做 API」、「串金流」、「接發票」、「做同步」。
- 不得用營收成長代替毛利、對帳、合規或資料品質驗證。
- 不得把「待確認」偷渡成已確定事實。

## ACCEPTANCE

- 文件交付需能回答：誰使用、為什麼做、資料從哪裡來、狀態如何流轉、失敗如何處理、誰有權限、怎麼驗收、上線後誰監控。
- 文件型驗收需檢查：README 是否連到文件、範圍是否明確、不做項是否列出、go/no-go gate 是否列出、待確認人與問題是否列出。
