# 部署指南 — ulw-system 上線前最小配置

本文件描述 ulw-system 從開發切換到正式環境前必須完成的部署層工作。對齊 `docs/high-risk-workstreams.md` 的 go-gate 與 `docs/problem-review.md` 的「目前實作差距」。

> ✅ ulw-system 可部署為「Starter 正式服務」：POS 收銀、商品/菜單、接單池、現金收款、手動付款紀錄、日報、角色權限、audit、離線 outbox 與人工同步補救。正式電子發票、正式刷卡 / QR / LINE Pay、AI 自動決策、連鎖總部與完整庫存仍受 `docs/high-risk-workstreams.md` go-gate 限制。

> ⚠️ 對外銷售前必須用合約與頁面明確標示：非現金支付仍為「手動紀錄」或未啟用；電子發票若未串接加值中心，只能稱「串接驗證 / sandbox 健康檢查」，不得宣稱合法正式開立。

## 1. TLS 終端與反向代理

### 1.1 必要條件

- 自家機器 / VM **不直接對外暴露 :3100**。前置一台反向代理 (建議 Caddy 或 nginx) 負責：
  - TLS 終端 (Let's Encrypt or 商用 CA)
  - HSTS、TLS 1.2+ 限制、OCSP stapling
  - 紀錄 `X-Forwarded-For` 與 `X-Forwarded-Proto`
  - WebSocket / SSE pass-through (如未來 KDS 啟用)
- 強制 HTTP → HTTPS 轉址 (`Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`)
- 拒絕 TLS < 1.2 與弱 cipher (no RC4, no SHA-1, no 3DES)

### 1.2 Caddy 範例 (推薦, 自動 Let's Encrypt)

```
pos.example.com {
  encode gzip
  reverse_proxy 127.0.0.1:3100 {
    header_up X-Forwarded-For {remote_host}
    header_up X-Forwarded-Proto {scheme}
    header_up X-Real-IP {remote_host}
  }
  header {
    Strict-Transport-Security "max-age=63072000; includeSubDomains; preload"
    Referrer-Policy "strict-origin-when-cross-origin"
    X-Frame-Options "DENY"
  }
}
```

### 1.3 nginx 範例

```
server {
  listen 443 ssl http2;
  server_name pos.example.com;

  ssl_certificate     /etc/letsencrypt/live/pos.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/pos.example.com/privkey.pem;
  ssl_protocols TLSv1.2 TLSv1.3;
  ssl_prefer_server_ciphers on;
  add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;

  location / {
    proxy_pass http://127.0.0.1:3100;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
server {
  listen 80;
  server_name pos.example.com;
  return 301 https://$host$request_uri;
}
```

### 1.4 設定 ulw-system 信任代理

預設情況下 `ulw-system` 不信任 `X-Forwarded-For` (避免攻擊者偽造來源 IP)。當前置代理確實會剝掉並重寫 XFF 時，**才**設定：

```
TRUST_PROXY=1
```

這個 flag 影響：
- 登入嘗試的 per-IP lockout (`src/domains/identity.js`)
- token-bucket rate limiter (`src/core/rateLimit.js`)
- audit log 的 `ip` 欄位 (`src/core/runtime.js` clientIp helper)

不設或代理未清 XFF 時，所有來源 IP 會被當成 `127.0.0.1`，rate-limit 失準。

## 2. 必填環境變數 (正式環境)

| 變數 | 必填? | 用途 |
|------|------|------|
| `NODE_ENV=production` | 是 | 啟用 prod 啟動 gate |
| `PORT=3100` | 是 | 監聽 port |
| `METRICS_TOKEN` | 是 | `/metrics` Bearer 守門 (server.js 啟動拒絕無此變數) |
| `PIN_PEPPER` | 是 | PIN scrypt pepper (見 `src/core/security.js`) |
| `MFA_KEK` | 是 | 32-byte hex AES-256-GCM key for TOTP secret encryption |
| `TRUST_PROXY` | 是 (若有反代) | 啟用 XFF 解析 |
| `ALLOWED_ORIGINS` | 是 | CORS 白名單, 逗號分隔, **不可含 `*` 配 credentials** |
| `OMC_BOOTSTRAP_SEED_FIXED_PINS` | 否 | production 啟動會拒絕；僅限非正式復原環境 |
| `ALLOW_MOCK_PAYMENT_PROVIDERS` | 否 | 只允許搭配 `DEMO_MODE=1`；正式 Starter 不可啟用 mock 卡片/QR/Mobile provider |
| `INVOICE_NON_PRODUCTION_ACK` | 否 | 顯式承認電子發票仍為 sandbox；未設定時 production 會封鎖 sandbox 發票路由 |
| `DEMO_MODE` | 否 | 設為 `1` 時 prod 進入示範模式，`ALLOW_MOCK_PAYMENT_PROVIDERS=1` 與 `INVOICE_NON_PRODUCTION_ACK=1` 都必填 |
| `DATA_DIR` | 否 | SQLite snapshot 位置 (預設 `./data`) |
| `DISABLE_BACKGROUND_WORKERS` | 否 | 跑回歸測試時可關 |
| `LOG_LEVEL` | 否 | `info` / `debug` / `warn` / `error` |
| `DATABASE_URL` (Postgres) | 否 | 未啟用 Postgres 路徑時不必設 |
| `MFA_KEK` 產生 | 一次性 | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `METRICS_TOKEN` 產生 | 一次性 | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `PIN_PEPPER` 產生 | 一次性 | `node -e "console.log(require('crypto').randomBytes(24).toString('base64'))"` |

正式環境**未設** `METRICS_TOKEN` / `PIN_PEPPER` / `MFA_KEK` / `ALLOWED_ORIGINS`，或 `ALLOWED_ORIGINS=*`，啟動會拒絕。上線前必須各自輪換並寫進 secret manager (建議 Doppler / Vault / Bitwarden Secrets Manager)。

## 3. Process supervisor

不要直接跑 `npm start`. 用 systemd / pm2 / Docker compose 守護：

### 3.1 systemd 範例

```ini
[Unit]
Description=Store Captain POS (ulw-system)
After=network.target

[Service]
Type=simple
User=ulw
WorkingDirectory=/srv/ulw-system
Environment=NODE_ENV=production
EnvironmentFile=/etc/ulw-system/env
ExecStart=/usr/bin/node src/server.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
```

`/etc/ulw-system/env` 權限 `0600`, owner `ulw`.

### 3.2 pm2 範例

```js
module.exports = {
  apps: [{
    name: 'ulw-system',
    script: 'src/server.js',
    instances: 1,
    autorestart: true,
    max_memory_restart: '1G',
    env: { NODE_ENV: 'production' },
    env_file: '/etc/ulw-system/env',
  }],
};
```

## 4. 備份與還原

`scripts/backup.js` 目前只寫**同一顆硬碟**, **單點失效 = 資料全失**。上線前必須完成：

1. 排程 `node scripts/backup.js`, 每日 03:00, 結束後將輸出檔同步到異地物件儲存 (S3 / R2 / B2)
2. 撰寫 `scripts/restore.js` (TODO infra-todo #23) 並**演練**：每季至少一次「從異地拉備份、還原到測試實例、跑 smoke + verify-flows」
3. 文件化 RTO / RPO 目標 (建議 RTO 4 小時 / RPO 24 小時做為起點, Chain 方案後續收緊)

WAL 與 `.wal` / `.shm` 檔案：備份必須與 `store.db` 同步 snapshot，避免 WAL replay 不一致。`scripts/backup.js` 已採 `VACUUM INTO` 取完整快照，不會撕裂。

## 5. /metrics 接 Prometheus

`/metrics` 在生產必填 `METRICS_TOKEN`。Prometheus 取樣：

```yaml
scrape_configs:
  - job_name: ulw-system
    scheme: https
    static_configs:
      - targets: ['pos.example.com']
    authorization:
      type: Bearer
      credentials: <METRICS_TOKEN>
    scrape_interval: 30s
    metrics_path: /metrics
```

關鍵告警 (Grafana / Alertmanager):

- `up{job="ulw-system"} == 0` 5 分鐘 — 服務當掉
- `ulw_outbox_pending_count > 100 for 10m` — 同步累積
- `rate(ulw_orders_created_total[5m]) == 0 during 08:00-22:00` — 業務停滯
- `rate(ulw_login_failed_total[1m]) > 5` — 可能爆破
- `disk_used_percent{mountpoint="/var/lib/ulw-system"} > 80` — 磁碟即將滿

## 6. 上線檢查清單

切換到正式環境前逐項打勾：

- [ ] HTTPS 終端就緒 + HSTS 開啟
- [ ] `NODE_ENV=production` + `METRICS_TOKEN` + `PIN_PEPPER` + `MFA_KEK` 三個密鑰已產生並輪換進 secret manager
- [ ] `TRUST_PROXY=1` 對齊反向代理
- [ ] `ALLOWED_ORIGINS` 不含 `*`
- [ ] systemd / pm2 服務檔已部署, EnvironmentFile 權限 0600
- [ ] `node scripts/backup.js` 排程 + 異地同步排程 + 還原演練文件已交付
- [ ] Prometheus / Grafana scrape OK, 4 條核心告警都有 oncall 對應人
- [ ] `/health` 由負載平衡 / 上層監控每 30 秒呼叫
- [ ] 上線當下執行 `npm test` (131 PASS) + `node scripts/smoke.js` + `node scripts/verify-flows.js` (33 PASS)
- [ ] 金流尚未串接 PSP: 不對外宣傳「刷卡 / QR / LINE Pay」；正式 Starter 不設定 `ALLOW_MOCK_PAYMENT_PROVIDERS`
- [ ] 電子發票尚未串接加值中心: 不對外宣傳「合法電子發票」；若需 sandbox 健康檢查，合約與環境必須明示 `INVOICE_NON_PRODUCTION_ACK=1`
- [ ] 隱私權 / 服務條款 / DPA / 個資告知 / 外洩通報 SOP 已由律師審閱 (見 `docs/compliance-guardrails.md`)

## 7. Roll-back 步驟

故障時：

1. `systemctl stop ulw-system` (或 `pm2 stop`) — 停止寫入
2. 反向代理切到 maintenance page (Caddy: `respond "維護中" 503`)
3. 從異地備份還原 `data/store.db`
4. `systemctl start ulw-system`
5. `curl https://pos.example.com/health/ready` 確認 `{ok:true, checks.sqlite.ok:true}`
6. 跑 `node scripts/smoke.js` 確認業務金針正常
7. 反向代理摘除維護頁
8. 寫 incident retrospective, 補 audit log timeline

不要試著手動改 SQLite blob — `audit_logs` 與業務狀態同步, 缺一就破壞稽核軌跡。
