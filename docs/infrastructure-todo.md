# 基礎建設待辦 (2026-05)

本次 strict 審查列出 50 條技術缺口。可在本機 / 無外部基礎設施環境內完整實作的已落地，下列為**需基礎設施或第三方帳號才能完成**的項目，依優先順序排列。每條附「為何延後」、「先決條件」、「驗收標準」。

---

## P0 — 上線前硬擋

### #5 TLS termination
- **為何延後**：本機開發以 HTTP-only 啟動較順暢；TLS 憑證需要實際 host name。
- **先決條件**：DNS、Let's Encrypt or 內部 CA、reverse proxy (caddy/nginx)。
- **落地**：caddy 反向代理 + ENABLE_HSTS=1 環境變數。
- **驗收**：所有 prod 流量走 https，HSTS preload。

### #7 X-Forwarded-For trust 設定
- **為何延後**：本機開發無 reverse proxy；rate limit 不會收到非本機 IP。
- **先決條件**：#5 完成後一起做。
- **落地**：明確列出可信任的 proxy chain，從 `X-Forwarded-For` 取最右一段。
- **驗收**：rate-limit、audit log 的 `ip` 欄位是真實客戶端 IP。

### #10 HTTPS-only 強制
- **為何延後**：與 #5、#7 綁定。
- **落地**：HTTP listener 重導 301 至 HTTPS、cookie/token transport 強制 secure flag。

### #31 token 改 httpOnly + SameSite cookie
- **為何延後**：前端目前用 `Authorization: Bearer` header（推測 localStorage）。換成 cookie 是前端大改造。
- **先決條件**：#5 TLS 完成（cookie 需 secure flag），#7 完成。
- **落地**：login 回 `Set-Cookie: token=...; HttpOnly; Secure; SameSite=Strict` + CSRF token 雙提交。
- **驗收**：XSS 偷不到 token、API 仍可呼叫、CSRF 受擋。

---

## P1 — 規模化前完成

### #11 Postgres + RLS 實際部署
- **狀態 (2026-05-17)**：**Local PG up + 13 表 + RLS 全部驗證通過**。`embedded-postgres` npm 提供 PG 17 binary，無 docker / 無 admin。
- **已完成**：
  1. `embedded-postgres` 安裝 + `npm run pg:up` (port 5433) ✅
  2. `npm run db:generate` 產出 `migrations/0000_*.sql`（13 表、6 indexes）✅
  3. `npm run pg:apply` 套 schema + `0001_rls.sql` ✅
  4. **`tests/postgresRls.test.js` 3 條驗證**（skip 當 `PG_URL` unset）：
     - tenant context = A → 只見 A row
     - tenant context = B → 只見 B row
     - 無 context → 0 row (FORCE RLS)
     - cross-tenant insert → `42501 row-level security policy` 拒絕
  5. `PG_URL=... npm test` → 64/64 PASS ✅
- **未做**：
  6. 寫 pg-adapter Store 介面，與 SQLite Store 共用同一抽象（domain code 改 async）。
  7. 每 request 在 transaction 內 `SET LOCAL app.tenant_id = ...`。
  8. Connection pool sizing + leak detector。
  9. CI service container 啟動 PG 跑此 test。
- **驗收 (已達)**：tenant A token 觸發 DB query 物理上看不到 tenant B 的 row — SQL 層 (`42501`) 拒絕。
- **下一步**：管 PG 從 dev 移到 staging (managed instance / docker)、寫 pgStore adapter、用 feature flag `STORE_BACKEND=postgres|sqlite` 切換。

### #21 OpenTelemetry tracing
- **為何延後**：需要 OTLP collector (Tempo/Jaeger) 接收端。
- **先決條件**：collector endpoint。
- **落地**：`@opentelemetry/sdk-node` + auto-instrument http/better-sqlite3。Trace ID = request ID。
- **驗收**：每個 request 在 trace UI 看得到端到端 timing。

### #23 Backup/Restore script
- **為何延後**：需要備份目的地（S3-compat 物件儲存）+ cron host。
- **先決條件**：S3 bucket + IAM credential。
- **落地**：每小時 `VACUUM INTO snapshot-<ts>.db` → upload S3，retention 30 天。restore drill 文件化。
- **驗收**：模擬 `store.db` 損毀後 RPO ≤ 1h、RTO ≤ 30min。

### #25 Grafana alerts / SLO
- **為何延後**：需要 Prometheus scrape + Grafana 實例 + on-call 收信端。
- **先決條件**：Prom + Grafana running。
- **落地**：定義 SLI(5xx rate, persist latency p99, outbox DEAD_LETTER rate)、SLO + alertmanager rule、PagerDuty/Slack receiver。
- **驗收**：人為觸發 5xx 連續 5 分鐘 → 告警送達指定收件人。

### #27 Sentry error tracker
- **為何延後**：需要 Sentry DSN。
- **先決條件**：Sentry org + DSN env var。
- **落地**：`@sentry/node` init in `src/core/logger.js`（DSN 缺則 no-op），錯誤 hook 自動 capture。
- **驗收**：強制 throw 後 Sentry dashboard 收到 event 含 stack。

### #28 Log retention / shipping
- **為何延後**：log 目前印 stdout 由 ops 自接 Loki/CloudWatch。
- **落地**：logrotate 或 promtail；保留 30 天 hot、90 天 archive。
- **驗收**：可查詢任意過去 30 天 log，含 tenant_id 過濾。

### #29 Load test profile
- **為何延後**：需要 staging instance + k6 runner。
- **落地**：k6 scripts/load/order-pay.js 模擬 50 訂單/分 × 100 終端，CI 跑 60 秒 baseline。
- **驗收**：知道 p99、saturation point；任何 regression 在 CI 擋。

---

## P2 — 工程體驗

### #35 i18n
- **為何延後**：字串都硬編 zh-TW 在 HTML/JS。
- **落地**：i18next 或 minimal key dictionary，至少 zh-Hant / en。
- **驗收**：UI 切語系後字串全部翻譯，無 missing-key。

### #38 TypeScript 漸進遷移
- **為何延後**：當前 pure JS、無 type system。
- **落地**：先在 `src/core/*.js` 加 `// @ts-check` + JSDoc，CI `tsc --checkJs` gate。
- **驗收**：所有 core/* 通過 type check，零 implicit-any。

---

## 不在此次 audit 但建議跟做

- **#5 完成後**：移除試用 / 狀態 banner 前先過 P0 全套 + P1 #11/#23。
- **#7 + #11**：完成後可開始 GDPR / 個資法 DPIA 文件。
- **#21 + #25 + #27**：合一規劃成 observability stack，建議用 Grafana Cloud 一站 (Prom + Loki + Tempo) 或自架 Tanka。
- **#29**：load test 結果一旦得到，回頭調 SQLite/Postgres、connection pool size、persist coalescing window。

---

## 已落地（本次 audit 修完）

P0：#1 PIN scrypt、#2 session sha256、#3 security headers、#4 CORS、#6 rate limit、#8 per-user lockout、#9 /metrics auth gate。
P1：#12 audit_logs table、#13 transactional persist、#14 idempotency TTL、#15 static stream + ETag、#16 request timeout、#18 graceful drain、#19 Taipei TZ。
P2：#22 OpenAPI spec、#26 DB query duration histogram、#30 CodeQL workflow。
P3：#32 CSP meta、#34 SW origin check、#36 待加 (a11y axe-core)、#37 待 OpenAPI client 生成。
P4：#39 husky+lint-staged、#40 CI dep cache、#41 Windows CI matrix、#44 PR template。
P5：#46 server correlationId、#49 stockTracked boolean、#50 invoice FSM。

55/55 unit + integration tests pass、lint 0 warning。
