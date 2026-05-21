const SESSION_STORAGE_KEY = 'storeCaptain.session.v2';
const DEVICE_ID = 'terminal-web-001';

const state = {
  products: [],
  cart: [],
  activeOrderId: null,
  activeOrderTotal: 0,
  activeOrderPayload: null,
  lastPaidOrder: null,
  lastPaidOrderId: null,
  lastInvoiceId: null,
  lastInvoicePayload: null,
  activeChannelOrderId: null,
  lastChannelOrder: null,
  activeKdsOrderId: null,
  activeSyncJobId: null,
  activeCustomerId: null,
  cashDrawerId: null,
  reportExportId: null,
  reportSnapshot: null,
  session: null,
  invoiceHealth: null,
  inventory: [],
  category: 'all',
  invoiceSettings: loadInvoiceSettings(),
};

function loadInvoiceSettings() {
  try {
    const raw = localStorage.getItem('storeCaptain.invoiceSettings');
    return raw ? JSON.parse(raw) : { mode: 'B2C', carrier: '', buyerTaxId: '', donationCode: '' };
  } catch { return { mode: 'B2C', carrier: '', buyerTaxId: '', donationCode: '' }; }
}
function saveInvoiceSettings() {
  try { localStorage.setItem('storeCaptain.invoiceSettings', JSON.stringify(state.invoiceSettings)); } catch {}
}

const categoryNames = {
  all: '全部',
  drink: '飲料',
  breakfast: '早餐',
  lunchbox: '便當',
  food: '餐點',
};

const roleRank = { GUEST: 0, CASHIER: 1, MANAGER: 2, SUPERVISOR: 3, ADMIN: 4 };
const roleNames = { CASHIER: '收銀員', MANAGER: '店長', SUPERVISOR: '督導', ADMIN: '系統管理員' };

const $ = (id) => document.getElementById(id);
const money = (value) => Number(value || 0).toLocaleString('zh-TW');
// Business date must follow the store's Asia/Taipei wall clock, not UTC. Using the
// UTC date stamps orders made between 00:00–07:59 Taipei with the previous day,
// which breaks daily reports and the server's Taipei-based businessDate validation.
const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
const newIdempotencyKey = () => `idem-${(crypto.randomUUID && crypto.randomUUID()) || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
const inSession = () => Boolean(state.session?.token && new Date(state.session.expiresAt).getTime() > Date.now());
const canUse = (minRole) => (roleRank[state.session?.role] || 0) >= (roleRank[minRole] || 0);

function h(tag, opts = {}, children = []) {
  const el = document.createElement(tag);
  if (opts.className) el.className = opts.className;
  if (opts.text !== undefined) el.textContent = opts.text;
  if (opts.attrs) {
    for (const [key, value] of Object.entries(opts.attrs)) {
      if (value !== undefined && value !== null) el.setAttribute(key, String(value));
    }
  }
  if (opts.dataset) {
    for (const [key, value] of Object.entries(opts.dataset)) {
      if (value !== undefined && value !== null) el.dataset[key] = String(value);
    }
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    el.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return el;
}

function clear(el) {
  if (el) el.replaceChildren();
}

function showAuthGate(visible) {
  $('authGate').hidden = !visible;
  document.querySelector('.app-frame').hidden = visible;
  document.body.dataset.auth = visible ? 'locked' : 'open';
}

function setStatus(message, tone = 'ready') {
  const line = $('statusLine');
  line.textContent = message;
  line.dataset.tone = tone;
}

function pick(value, keys) {
  for (const key of keys) if (value && value[key] !== undefined && value[key] !== null) return value[key];
  return null;
}

function countLabel(count, unit = '筆') {
  return `${Number(count || 0).toLocaleString('zh-TW')} ${unit}`;
}

function moneyLabel(value) {
  return `NT$${money(value)}`;
}

function stateLabel(value) {
  const labels = {
    DRAFT: '待結帳',
    UNPAID: '未付款',
    PARTIALLY_PAID: '部分付款',
    PAID: '已付款',
    PAID_CASH: '現金已收',
    PAID_PENDING: '付款待對帳',
    PENDING: '待處理',
    PENDING_UPLOAD: '待上傳',
    UPLOADED: '已上傳',
    VOID_PENDING_UPLOAD: '作廢待上傳',
    VOIDED_SANDBOX: 'Sandbox 已作廢',
    ISSUED_SANDBOX: 'Sandbox 已開立',
    READY: '已完成',
    IN_PROGRESS: '製作中',
    QUEUED: '排隊中',
    CONFIRMED: '已接單',
    CREATED: '新訂單',
    SYNCED: '已同步',
    DONE: '完成',
    RETRYABLE_ERROR: '可重試',
    DEAD_LETTER: '需人工補救',
    OPEN: '開班中',
    CLOSED: '已交班',
    OK: '正常',
    LOW: '低庫存',
    OUT: '缺貨',
  };
  return labels[value] || value || '未指定';
}

function lines(...rows) {
  return rows.flat().filter(Boolean).join('\n');
}

function itemLines(items, render, empty = '目前沒有資料') {
  if (!Array.isArray(items) || items.length === 0) return [empty];
  return items.slice(0, 6).map(render).concat(items.length > 6 ? [`另有 ${items.length - 6} 筆未顯示`] : []);
}

function formatOrder(value) {
  if (value.cash && value.card) return lines(
    '混合付款完成',
    `現金 ${moneyLabel(value.cash.paymentSummary?.amount)}，刷卡 ${moneyLabel(value.card.paymentSummary?.amount)}`,
    `訂單 ${value.card.orderId}：${stateLabel(value.card.paymentState)}`,
    value.card.invoice ? `發票：${value.card.invoice.invoiceNumber}（${stateLabel(value.card.invoice.uploadState)}）` : '發票：未開立'
  );
  if (value.refund) return lines(
    '退貨退款完成',
    `退款 ${moneyLabel(value.refund.amount)}，原因 ${value.refund.reasonCode}`,
    `訂單 ${value.refund.orderId}：${stateLabel(value.order?.state)}`,
    value.refund.restock ? '庫存已回補 ledger' : '庫存未回補'
  );
  if (value.redemptionId) return lines(
    '優惠券已套用',
    `折抵 ${moneyLabel(value.amount)}，代碼 ${value.order?.couponCode || 'WELCOME50'}`,
    `應收 ${moneyLabel(value.order?.grandTotal)}`
  );
  if (value.paymentSummary) return lines(
    '結帳完成',
    `訂單 ${value.orderId}：${stateLabel(value.paymentState)}`,
    `收款 ${moneyLabel(value.paymentSummary.amount)}，找零 ${moneyLabel(value.paymentSummary.change)}`,
    value.invoice ? `發票：${value.invoice.invoiceNumber}（${stateLabel(value.invoice.uploadState)}）` : '發票：未開立',
    value.printQueueId ? `列印佇列：${value.printQueueId}` : null
  );
  if (value.orderId && value.source) return lines(
    `${value.source} 訂單已建立`,
    `訂單 ${value.orderId}，金額 ${moneyLabel(value.grandTotal)}`,
    `狀態：${stateLabel(value.state)} / ${stateLabel(value.paymentState)}`
  );
  if (value.id && value.orderNumber) return lines(
    value.discountTotal ? '訂單折扣已套用' : '訂單已送出',
    `單號 ${value.orderNumber}`,
    `狀態：${stateLabel(value.state)} / ${stateLabel(value.paymentState)}`,
    `小計 ${moneyLabel(value.subtotal)}，折扣 ${moneyLabel(value.discountTotal)}，應收 ${moneyLabel(value.grandTotal)}`,
    value.outbox?.jobId ? `同步：${stateLabel(value.outbox.state)}（${value.outbox.jobId}）` : null
  );
  if (value.state === 'CONFIRMED' || value.source) return lines(
    '來源單已更新',
    `訂單 ${value.id || value.orderId}：${stateLabel(value.state)}`,
    `來源：${value.source || 'POS'}`
  );
  if (value.orderId && value.state) return lines('訂單已更新', `訂單 ${value.orderId}：${stateLabel(value.state)}`);
  return null;
}

function formatInvoice(value) {
  if (value.invoice && value.void) return lines(
    'Sandbox 作廢已建立',
    `發票 ${value.invoice.invoiceNumber}：${stateLabel(value.invoice.lifecycleState)}`,
    `上傳狀態：${stateLabel(value.invoice.uploadState)}`,
    `人工補救單：${value.void.id}，原因 ${value.void.reasonCode}`
  );
  if (value.mode) return lines(
    '發票 Sandbox 佇列',
    `發票 ${countLabel(value.totals?.invoices)}，待上傳 ${countLabel(value.totals?.pendingUpload)}，異常 ${countLabel(value.totals?.exceptions)}`,
    itemLines(value.exceptions, (item) => `• ${item.invoiceNumber}：${stateLabel(item.uploadState)} / ${stateLabel(item.lifecycleState)}`, '目前沒有待處理發票'),
    '正式電子發票需完成會計師、加值中心、字軌與補傳 gate。'
  );
  if (value.invoiceNumber) return lines('發票已更新', `${value.invoiceNumber}：${stateLabel(value.uploadState)} / ${stateLabel(value.lifecycleState)}`);
  return null;
}

function formatOutput(id, value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return String(value ?? '完成');

  if (id === 'orderResult') return formatOrder(value) || '訂單操作完成';
  if (id === 'invoiceResult') return formatInvoice(value) || '發票操作完成';
  if (id === 'kdsResult') return lines('KDS 製作佇列', itemLines(value.items, (item) => `• ${item.orderNumber || item.orderId}：${stateLabel(item.productionState)}，叫號 ${item.callNumber || '未叫號'}，${item.items?.length || 0} 項`, '目前沒有待製作訂單'));
  if (id === 'drawerResult') return lines('錢櫃狀態', `狀態：${stateLabel(value.state)}`, value.cashDrawerId ? `班別：${value.cashDrawerId}` : null, value.openingCash !== undefined ? `備用金：${moneyLabel(value.openingCash)}` : null, value.cashVariance !== undefined ? `差異：${moneyLabel(value.cashVariance)}` : null, value.recovered ? '已接續本端末既有開班錢櫃' : null);
  if (id === 'printResult') return lines('列印佇列', itemLines(value.items, (item) => `• ${item.documentType} ${item.orderId}：${stateLabel(item.state)}，嘗試 ${item.attempts} 次`, '目前沒有列印工作'));
  if (id === 'reconcileResult') {
    if (value.summary) return lines('今日三方對帳', `訂單 ${countLabel(value.summary.orderCount)}，例外 ${countLabel(value.summary.exceptionCount)}`, `訂單金額 ${moneyLabel(value.summary.orderAmount)}，付款 ${moneyLabel(value.summary.paymentAmount)}，發票 ${moneyLabel(value.summary.invoiceAmount)}`, itemLines(value.rows, (row) => `• ${row.orderNumber}：${row.matched ? '已對齊' : '需人工確認'}，發票 ${stateLabel(row.invoiceUploadState)}`, '目前沒有已付款訂單'));
    if (value.items) return lines('付款明細', itemLines(value.items, (item) => `• ${item.method} ${moneyLabel(item.amount)}：${stateLabel(item.settlementState)}，訂單 ${item.orderId}`, '目前沒有付款'));
  }
  if (id === 'reportResult') return lines('日營收與熱銷', `營收 ${moneyLabel(value.daily?.totals?.revenue)}，訂單 ${countLabel(value.daily?.totals?.orderCount)}`, `付款筆數 ${countLabel(value.payments?.total?.transactions)}，付款總額 ${moneyLabel(value.payments?.total?.amount)}`, itemLines(value.top?.items, (item) => `• ${item.name}：${item.soldQty} 份，${moneyLabel(item.netAmount)}`, '目前沒有熱銷資料'));
  if (id === 'syncRepairResult') return lines('同步補救佇列', itemLines(value.items, (item) => `• ${item.resourceType} ${item.resourceId}：${stateLabel(item.state)}，嘗試 ${item.attempts} 次`, '目前沒有同步工作'));
  if (id === 'exportResult') return lines('會計匯出', `狀態：${stateLabel(value.state)}`, `匯出單：${value.exportId || value.id || '尚未建立'}`, value.rows ? `資料列：${value.rows}` : null, value.downloadUrl ? '下載連結已產生' : null);
  if (id === 'catalogResult') return lines('商品後台', value.created ? `已匯入 ${countLabel(value.created.length)}` : null, value.products ? `商品 ${countLabel(value.products.length)}` : null, value.items ? itemLines(value.items, (item) => `• ${item.name || item.id}：${countLabel(item.productCount || 0, '項')}`) : null, value.productId ? `已建立商品：${value.name || value.productId}` : null);
  if (id === 'inventoryResult') return lines('庫存 ledger', value.movementId ? `已寫入異動：${value.movementId}` : null, value.id ? `已記錄：${value.id}（${stateLabel(value.state)}）` : null, itemLines(value.items, (item) => `• ${item.name}：${item.stockOnHand}，${stateLabel(item.state)}`, '目前沒有庫存資料'));
  if (id === 'memberResult') return lines('會員與優惠', value.phone ? `${value.name} ${value.phone}，點數 ${value.points || 0}` : null, value.items ? itemLines(value.items, (item) => `• ${item.code || item.name || item.phone}：${item.amount ? moneyLabel(item.amount) : stateLabel(item.status)}`) : null, value.customerId ? `點數已調整：${value.before} → ${value.after}` : null);
  if (id === 'settingsResult') return lines('員工與設定', value.items ? itemLines(value.items, (item) => `• ${item.name}：${item.role}，${(item.storeIds || []).join(', ')}`) : null, value.role ? `已建立員工：${value.name}（${value.role}）` : null, value.storeId ? `門市 ${value.storeId}：${value.receiptTitle || '已讀取設定'}，稅務 ${value.taxMode}` : null);
  if (id === 'auditResult') return lines('稽核紀錄', itemLines(value.items, (item) => `• ${item.action}：${item.resourceType || item.resource} ${item.resourceId || ''}`.trim(), '目前沒有稽核紀錄'));
  if (id === 'aiResult') return lines('老闆日報', value.summary, `信心：${stateLabel(value.confidence)}`, itemLines(value.recommendations, (item) => `• ${item}`, '目前沒有建議'));
  if (id === 'telemetryResult') return lines('端末狀態', value.accepted ? `Heartbeat 已收：${value.terminalId}，同步延遲 ${value.syncLagSeconds} 秒，印表機 ${stateLabel(value.printerStatus)}` : null, value.overall ? `整體狀態：${stateLabel(value.overall)}` : null, value.terminals ? itemLines(value.terminals, (item) => `• ${item.terminalId}：${stateLabel(item.state)}，同步 ${item.syncLagSeconds} 秒，印表機 ${stateLabel(item.printerStatus)}`) : null);

  const label = pick(value, ['message', 'state', 'status', 'id', 'orderId', 'invoiceId']) || '完成';
  return `操作完成：${stateLabel(label)}`;
}

function show(id, value) {
  $(id).textContent = formatOutput(id, value);
}

const ERROR_CODE_LABELS = {
  ORDER_IDEMPOTENCY_CONFLICT: '訂單去重衝突：相同 idempotencyKey 已用於不同內容的請求。請重新整理後再試。',
  ORDER_STATE_INVALID: '訂單目前狀態不允許這個動作（可能已付款或已作廢）。',
  ORDER_NOT_FOUND: '找不到這筆訂單。',
  REFUND_AMOUNT_INVALID: '退款金額不正確：超過可退金額或為負數。',
  VOID_NOT_ALLOWED: '此訂單狀態不允許作廢。',
  PERMISSION_DENIED: '權限不足：此操作需要更高的角色。',
  TENANT_SCOPE_VIOLATION: '租戶範圍違規：嘗試操作非授權店別資料。',
  TENANT_NOT_AUTHORIZED: '租戶授權不通過：無法存取此店資料。',
  RETRY_LIMIT_EXCEEDED: '重試次數已達上限，已轉入 DEAD_LETTER，請聯絡客服。',
  PRINT_JOB_STATE_INVALID: '列印任務狀態查詢不合法。',
  EXPORT_RANGE_TOO_LARGE: '匯出區間過長，請改為 92 天以內。',
  EXPORT_RANGE_INVALID: '匯出日期格式錯誤。',
  EMPTY_REPORT: '此區間沒有資料可匯出。',
  FILE_EXPIRED: '匯出檔案已過期，請重新建立。',
  LOGIN_INVALID_CREDENTIALS: '帳號或密碼錯誤。',
  LOGIN_RATE_LIMITED: '登入失敗次數過多，請稍後再試。',
  ROLE_GRANT_FORBIDDEN: '不可授予比自己角色更高的權限。',
  USER_EMAIL_DUPLICATE: 'Email 已存在。',
  CATALOG_IDEMPOTENCY_CONFLICT: '商品異動去重衝突，請重新整理。',
  PRICE_OUT_OF_RANGE: '價格不在允許範圍內。',
  CASHBOX_ALREADY_OPEN: '此終端已有開啟中的錢櫃。',
  CASH_SHORTFALL_UNEXPLAINED: '現金差額需提供調整原因。',
  INVENTORY_NEGATIVE_AFTER_MOVE: '此調整會使庫存為負，已阻擋。',
  CHANNEL_IDEMPOTENCY_CONFLICT: '線上點餐去重衝突。',
  CHANNEL_AUTH_FAILED: '線上點餐通道認證失敗，請更新 token。',
  KDS_TRANSITION_INVALID: 'KDS 狀態轉移不合法。',
  PATH_NOT_FOUND: '此操作尚未載入到目前伺服器。請重新整理；若仍失敗，系統需重啟服務。',
  INVOICE_NOT_FOUND: '找不到這張發票，請先按「讀取佇列」重新整理。',
  INVOICE_VOID_INVALID: '作廢原因不符合規則，請通知店長確認。',
  COUPON_NOT_APPLICABLE: '優惠券不適用此訂單。',
  PAYMENT_INVALID: '付款金額或狀態不正確。',
};

function describeErrorCode(code, fallback) {
  return ERROR_CODE_LABELS[code] || fallback || '發生未預期錯誤';
}

function friendlyError(error) {
  const code = error.body?.errorCode;
  return describeErrorCode(code, error.body?.message || error.message || '操作失敗，請重新整理後再試。');
}

function saveSession(session) {
  if (session) sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  else sessionStorage.removeItem(SESSION_STORAGE_KEY);
  notifySwBearer(session);
}

// Push the current bearer to the Service Worker so its offline outbox can
// re-attach the latest token at drain time. Without this, the SW would replay
// queued mutations with the bearer that was current at queue time, which
// could be a rotated/expired token.
function notifySwBearer(session) {
  try {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.ready.then((reg) => {
      const target = navigator.serviceWorker.controller || reg.active;
      if (!target) return;
      if (session && session.token) {
        target.postMessage({ type: 'update-bearer', bearer: `Bearer ${session.token}` });
      } else {
        target.postMessage({ type: 'clear-bearer' });
      }
    }).catch(() => { /* SW not ready yet — login flow will re-call */ });
  } catch { /* defensive: SW APIs absent in older browsers */ }
}

function clearSession() {
  state.session = null;
  saveSession(null);
  updateSessionUi();
}

function updateSessionUi() {
  const loggedIn = inSession();
  const status = $('sessionStatus');
  status.className = `session-status ${loggedIn ? 'online' : 'offline'}`;
  status.textContent = loggedIn ? `${state.session.storeName || state.session.storeId} / ${roleNames[state.session.role] || state.session.role}` : '未登入';
  $('merchantName').textContent = loggedIn ? state.session.storeName || '店家工作台' : '尚未登入';
  $('operatorName').textContent = loggedIn ? `${state.session.userName || '值班人員'} · ${roleNames[state.session.role] || state.session.role}` : '請選擇店家與身份';
  if (loggedIn) {
    $('tenantId').value = state.session.tenantId;
    $('role').value = state.session.role;
    $('storeId').value = state.session.storeId;
  }
  showAuthGate(!loggedIn);
  applyRoleUi();
  $('logoutButton').disabled = !loggedIn;
}

function applyRoleUi() {
  for (const element of document.querySelectorAll('[data-min-role]')) {
    const allowed = inSession() && canUse(element.dataset.minRole);
    element.hidden = !allowed;
  }
  const activeButton = document.querySelector('.nav-button.active');
  if (activeButton?.hidden) {
    const firstVisible = document.querySelector('.nav-button:not([hidden])');
    if (firstVisible) switchView(firstVisible.dataset.view);
  }
}

async function parseResponse(response) {
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const error = new Error(`${response.status} ${body?.errorCode || 'ERROR'}: ${body?.message || text}`);
    error.body = body;
    error.status = response.status;
    throw error;
  }
  return body;
}

async function login(profile = null) {
  if (profile) {
    $('tenantId').value = profile.tenant;
    $('storeId').value = profile.store;
    $('role').value = profile.role;
  }
  const response = await fetch('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-device-id': DEVICE_ID },
    body: JSON.stringify({ tenantId: $('tenantId').value.trim(), role: $('role').value, storeId: $('storeId').value.trim(), pin: profile?.pin, storeName: profile?.name, userName: profile?.user }),
  });
  state.session = await parseResponse(response);
  if (profile?.name) state.session.storeName = profile.name;
  if (profile?.user) state.session.userName = profile.user;
  saveSession(state.session);
  updateSessionUi();
  setStatus('登入完成，可開始收銀');
  return state.session;
}

async function refreshSession() {
  if (!inSession()) { clearSession(); return false; }
  const response = await fetch('/api/v1/auth/session', { headers: { Authorization: `Bearer ${state.session.token}`, 'x-device-id': DEVICE_ID } });
  if (!response.ok) { clearSession(); return false; }
  state.session = await response.json();
  saveSession(state.session);
  updateSessionUi();
  return true;
}

async function restoreSession() {
  try { state.session = JSON.parse(sessionStorage.getItem(SESSION_STORAGE_KEY)); } catch { state.session = null; }
  updateSessionUi();
  if (state.session) await refreshSession();
}

async function logout() {
  const token = state.session?.token;
  clearSession();
  if (token) await fetch('/api/v1/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'x-device-id': DEVICE_ID } });
  setStatus('已登出', 'warn');
}

function requestHeaders() {
  if (!inSession()) throw new Error('請先登入');
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${state.session.token}`, 'x-device-id': DEVICE_ID };
}

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { ...requestHeaders(), ...(options.headers || {}) } });
  return parseResponse(response);
}

function cartTotal() {
  return state.cart.reduce((sum, item) => sum + item.qty * item.price, 0);
}

function updateMetrics() {
  $('metricProducts').textContent = state.products.length;
  $('metricCart').textContent = state.cart.reduce((sum, item) => sum + item.qty, 0);
  $('activeOrderLabel').textContent = state.activeOrderId ? `訂單 ${state.activeOrderId}` : '尚未建單';
  $('cartTotal').textContent = money(state.activeOrderId ? state.activeOrderTotal : cartTotal());
}

function visibleProducts() {
  const query = $('productSearch').value.trim().toLowerCase();
  return state.products
    .filter((item) => state.category === 'all' || item.categoryId === state.category)
    .filter((item) => !query || `${item.productName} ${item.skuCode} ${item.categoryId}`.toLowerCase().includes(query));
}

function renderCategories() {
  const categories = ['all', ...new Set(state.products.map((item) => item.categoryId || 'food'))];
  clear($('categoryRail'));
  for (const category of categories) {
    const count = category === 'all' ? state.products.length : state.products.filter((item) => item.categoryId === category).length;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `category-button${state.category === category ? ' active' : ''}`;
    button.appendChild(h('span', { text: categoryNames[category] || category }));
    button.appendChild(h('b', { text: count }));
    button.addEventListener('click', () => { state.category = category; renderCategories(); renderProducts(); });
    $('categoryRail').appendChild(button);
  }
}

function addToCart(product, opts = {}) {
  if (state.activeOrderId) {
    show('orderResult', '目前已有送出訂單，請先結帳或作廢再新增商品');
    return;
  }
  const qty = Math.max(1, Number(opts.qty || 1));
  const modifiers = (opts.modifiers || []).slice();
  const addons = (opts.addons || []).slice();
  // JSON-serialise the sorted option arrays so a modifier/addon value that
  // itself contains ',' or '|' cannot collide two distinct combos into one
  // cart line. _key is session-only (the server receives the arrays directly).
  const _key = product.skuId + ':' + JSON.stringify(modifiers.slice().sort()) + '|' + JSON.stringify(addons.slice().sort());
  const existing = state.cart.find((item) => item._key === _key);
  if (existing) existing.qty += qty;
  else state.cart.push({
    ...product,
    qty,
    modifiers,
    addons,
    _key,
    notes: [].concat(modifiers).concat(addons).join(' · '),
  });
  renderCart();
}

function pickProduct(product) {
  if (state.activeOrderId) {
    show('orderResult', '目前已有送出訂單，請先結帳或作廢再新增商品');
    return;
  }
  const hasMod = Array.isArray(product.modifiers) && product.modifiers.length > 0;
  if (!hasMod) { addToCart(product); return; }
  openModifierModal(product);
}

function openModifierModal(product) {
  if (!window.PosExtras) { addToCart(product); return; }
  const body = document.createElement('div');
  body.className = 'modifier-form';
  const productMeta = h('div', { className: 'modifier-prod' }, [
    h('strong', { text: product.productName }),
    h('span', { text: product.skuCode || product.skuId }),
  ]);
  const price = h('div', { className: 'modifier-price' }, ['NT$', h('b', { text: money(product.price) })]);
  body.appendChild(h('header', { className: 'modifier-head' }, [productMeta, price]));
  const groupsContainer = h('div', { className: 'modifier-groups' });
  body.appendChild(groupsContainer);
  const qtyStepper = h('div', { className: 'qty-stepper', attrs: { role: 'group', 'aria-label': '數量' } }, [
    h('button', { text: '−', attrs: { type: 'button', 'data-step': '-1', 'aria-label': '減少' } }),
    h('b', { text: '1', attrs: { id: 'modQty' } }),
    h('button', { text: '+', attrs: { type: 'button', 'data-step': '1', 'aria-label': '增加' } }),
  ]);
  body.appendChild(h('div', { className: 'modifier-qty' }, [
    h('span', { className: 'eyebrow', text: '數量' }),
    qtyStepper,
  ]));
  for (const grp of product.modifiers) {
    const g = document.createElement('fieldset');
    g.className = 'mod-group';
    g.dataset.groupName = grp.groupName;
    g.dataset.type = grp.type;
    const legend = document.createElement('legend');
    legend.appendChild(h('strong', { text: grp.groupName }));
    legend.appendChild(h('span', { text: grp.type === 'single' ? '單選' : '可複選' }));
    g.appendChild(legend);
    const optWrap = document.createElement('div');
    optWrap.className = 'mod-options';
    grp.options.forEach((opt, idx) => {
      const inputType = grp.type === 'single' ? 'radio' : 'checkbox';
      const optEl = document.createElement('label');
      optEl.className = 'mod-option';
      const input = document.createElement('input');
      input.type = inputType;
      input.name = `mod-${grp.groupName}`;
      input.value = opt;
      if (grp.type === 'single' && idx === 0) input.checked = true;
      const span = document.createElement('span');
      span.textContent = opt;
      optEl.appendChild(input);
      optEl.appendChild(span);
      optWrap.appendChild(optEl);
    });
    g.appendChild(optWrap);
    groupsContainer.appendChild(g);
  }
  // Combo radio group (套餐升級)
  const combos = defaultCombosFor(product);
  if (combos && combos.length) {
    const g = document.createElement('fieldset');
    g.className = 'mod-group mod-group--combo';
    g.dataset.groupName = '套餐';
    g.dataset.type = 'single';
    const legend = document.createElement('legend');
    legend.appendChild(h('strong', { text: '套餐升級' }));
    legend.appendChild(h('span', { text: '單選' }));
    g.appendChild(legend);
    const optWrap = document.createElement('div');
    optWrap.className = 'mod-options combo-options';
    combos.forEach((c, idx) => {
      const optEl = document.createElement('label');
      optEl.className = 'mod-option mod-combo';
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'combo';
      input.value = c.name;
      input.dataset.delta = c.delta;
      input.dataset.name = c.name;
      if (idx === 0) input.checked = true;
      const main = document.createElement('span');
      main.className = 'mod-addon-main';
      main.textContent = c.name;
      const price = document.createElement('em');
      price.textContent = c.delta === 0 ? '原價' : (c.delta > 0 ? '+NT$' + c.delta : '−NT$' + Math.abs(c.delta));
      optEl.appendChild(input);
      optEl.appendChild(main);
      optEl.appendChild(price);
      optWrap.appendChild(optEl);
    });
    g.appendChild(optWrap);
    groupsContainer.appendChild(g);
  }

  // Add-on bar — category-based defaults
  const addons = defaultAddonsFor(product);
  if (addons.length) {
    const g = document.createElement('fieldset');
    g.className = 'mod-group mod-group--addon';
    g.dataset.groupName = '加點';
    g.dataset.type = 'multi';
    const legend = document.createElement('legend');
    legend.appendChild(h('strong', { text: '加點 / 套餐升級' }));
    legend.appendChild(h('span', { text: '可複選' }));
    g.appendChild(legend);
    const optWrap = document.createElement('div');
    optWrap.className = 'mod-options addon-options';
    addons.forEach((a) => {
      const optEl = document.createElement('label');
      optEl.className = 'mod-option mod-addon';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.name = 'addon';
      input.value = `${a.name}+${a.delta}`;
      input.dataset.delta = a.delta;
      input.dataset.name = a.name;
      const main = document.createElement('span');
      main.className = 'mod-addon-main';
      main.textContent = a.name;
      const price = document.createElement('em');
      price.textContent = (a.delta >= 0 ? '+NT$' : '−NT$') + Math.abs(a.delta);
      optEl.appendChild(input);
      optEl.appendChild(main);
      optEl.appendChild(price);
      optWrap.appendChild(optEl);
    });
    g.appendChild(optWrap);
    groupsContainer.appendChild(g);
  }

  let qty = 1;
  const qtyB = body.querySelector('#modQty');
  body.querySelectorAll('[data-step]').forEach((btn) => {
    btn.addEventListener('click', () => {
      qty = Math.max(1, qty + Number(btn.dataset.step));
      qtyB.textContent = qty;
      refreshTotal();
    });
  });

  // Live total
  const totalEl = document.createElement('div');
  totalEl.className = 'modifier-total';
  totalEl.appendChild(h('span', { text: '小計' }));
  totalEl.appendChild(h('strong', {}, ['NT$', h('b', { text: money(product.price), attrs: { id: 'modTotal' } })]));
  body.appendChild(totalEl);
  function refreshTotal() {
    const addonDelta = Array.from(body.querySelectorAll('.addon-options input:checked'))
      .reduce((sum, inp) => sum + Number(inp.dataset.delta || 0), 0);
    const comboInput = body.querySelector('.combo-options input:checked');
    const comboDelta = comboInput ? Number(comboInput.dataset.delta || 0) : 0;
    const total = (product.price + addonDelta + comboDelta) * qty;
    body.querySelector('#modTotal').textContent = money(total);
  }
  body.querySelectorAll('.addon-options input, .combo-options input').forEach((inp) => inp.addEventListener('change', refreshTotal));
  refreshTotal();

  const foot = document.createElement('div');
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'ghost';
  cancel.textContent = '取消';
  cancel.addEventListener('click', () => PosExtras.closeModal());
  const submit = document.createElement('button');
  submit.type = 'button';
  submit.textContent = '加入購物車';
  submit.addEventListener('click', () => {
    const chosen = [];
    // Modifier groups (excluding combo + addon groups)
    for (const grp of body.querySelectorAll('.mod-group:not(.mod-group--addon):not(.mod-group--combo)')) {
      const inputs = grp.querySelectorAll('input:checked');
      for (const inp of inputs) chosen.push(`${grp.dataset.groupName}：${inp.value}`);
    }
    const addonNames = [];
    let addonDelta = 0;
    for (const inp of body.querySelectorAll('.addon-options input:checked')) {
      addonNames.push(inp.dataset.name);
      addonDelta += Number(inp.dataset.delta || 0);
    }
    const comboInput = body.querySelector('.combo-options input:checked');
    let comboName = '';
    let comboDelta = 0;
    if (comboInput) {
      comboDelta = Number(comboInput.dataset.delta || 0);
      if (comboDelta !== 0) comboName = comboInput.dataset.name; // skip "單點" base
    }
    const totalDelta = addonDelta + comboDelta;
    const finalProduct = totalDelta ? { ...product, price: product.price + totalDelta, _basePrice: product.price, _delta: totalDelta } : product;
    const combinedAddons = comboName ? [comboName, ...addonNames] : addonNames;
    addToCart(finalProduct, { qty, modifiers: chosen, addons: combinedAddons });
    PosExtras.closeModal();
    PosExtras.toast(`已加入：${product.productName}${comboName ? ' (' + comboName + ')' : ''} × ${qty}`, 'ok');
  });
  foot.appendChild(cancel);
  foot.appendChild(submit);

  PosExtras.showModal({
    title: product.productName,
    lead: '選擇客製化選項與加點，再加入購物車。',
    body,
    footer: foot,
  });
}

function escapeAttr(s) {
  return String(s || '').replace(/[<>&"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function defaultAddonsFor(product) {
  const map = {
    drink: [
      { name: '加珍珠', delta: 10 },
      { name: '加椰果', delta: 10 },
      { name: '加蘆薈', delta: 10 },
    ],
    breakfast: [
      { name: '加蛋', delta: 10 },
      { name: '加起司', delta: 15 },
      { name: '加培根', delta: 20 },
    ],
    lunchbox: [
      { name: '加滷蛋', delta: 10 },
      { name: '加香腸', delta: 20 },
      { name: '加雞腿', delta: 35 },
    ],
    food: [
      { name: '加大份量', delta: 15 },
      { name: '加辣', delta: 0 },
    ],
  };
  return map[product.categoryId] || map.food;
}

function defaultCombosFor(product) {
  const map = {
    drink: [
      { name: '單點', delta: 0 },
      { name: '升大杯', delta: 15 },
      { name: '升超大杯', delta: 25 },
    ],
    breakfast: [
      { name: '單點', delta: 0 },
      { name: '+紅茶套餐', delta: 25 },
      { name: '+豆漿套餐', delta: 25 },
      { name: '大套餐 (紅茶+雞塊)', delta: 50 },
    ],
    lunchbox: [
      { name: '單點', delta: 0 },
      { name: '+味噌湯套餐', delta: 15 },
      { name: '+味噌湯+紅茶套餐', delta: 30 },
    ],
  };
  return map[product.categoryId] || null;
}

function renderProducts() {
  const grid = $('products');
  clear(grid);
  const products = visibleProducts();
  if (products.length === 0) {
    grid.appendChild(h('article', { className: 'empty-state', text: '沒有符合搜尋條件的商品' }));
    updateMetrics();
    return;
  }
  for (const product of products) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'product-card';
    button.dataset.category = product.categoryId || 'food';
    const hasMod = Array.isArray(product.modifiers) && product.modifiers.length > 0;
    button.appendChild(h('span', { className: 'product-meta', text: product.skuCode || product.skuId }));
    button.appendChild(h('strong', { text: product.productName }));
    button.appendChild(h('span', { className: 'product-foot' }, [
      h('b', { text: 'NT$' + money(product.price) }),
      h('em', { text: categoryNames[product.categoryId] || product.categoryId || '餐點' }),
    ]));
    if (hasMod) button.appendChild(h('span', { className: 'product-mod-badge', text: '可客製', attrs: { 'aria-hidden': 'true' } }));
    button.addEventListener('click', () => pickProduct(product));
    grid.appendChild(button);
  }
  updateMetrics();
}

function changeQty(key, delta) {
  const item = state.cart.find((row) => (row._key || row.skuId) === key);
  if (!item) return;
  item.qty += delta;
  if (item.qty <= 0) state.cart = state.cart.filter((row) => (row._key || row.skuId) !== key);
  renderCart();
}

function renderCart() {
  const cart = $('cart');
  clear(cart);
  if (state.cart.length === 0) {
    cart.appendChild(h('li', { className: 'empty-cart', text: '點選商品即可加入交易' }));
    updateMetrics();
    return;
  }
  for (const item of state.cart) {
    const key = item._key || item.skuId;
    const line = document.createElement('li');
    line.className = 'cart-line';
    line.appendChild(h('div', { className: 'cart-line-head' }, [
      h('strong', { text: item.productName }),
      h('span', { className: 'cart-line-unit', text: `NT$${money(item.price)} × ${item.qty}` }),
    ]));
    if (item.modifiers && item.modifiers.length) {
      line.appendChild(h('ul', { className: 'cart-mods' }, item.modifiers.map((m) => h('li', { text: m }))));
    }
    if (item.addons && item.addons.length) {
      line.appendChild(h('ul', { className: 'cart-addons' }, item.addons.map((a) => h('li', { text: a }))));
    }
    line.appendChild(h('div', { className: 'qty-tools' }, [
      h('button', { text: '−', attrs: { type: 'button', 'aria-label': `減少 ${item.productName}` } }),
      h('b', { text: 'NT$' + money(item.price * item.qty) }),
      h('button', { text: '+', attrs: { type: 'button', 'aria-label': `增加 ${item.productName}` } }),
    ]));
    const [minus, plus] = line.querySelectorAll('.qty-tools button');
    minus.addEventListener('click', () => changeQty(key, -1));
    plus.addEventListener('click', () => changeQty(key, 1));
    cart.appendChild(line);
  }
  updateMetrics();
}

async function loadProducts() {
  const data = await api(`/api/v1/catalog/menus/published?storeId=${encodeURIComponent($('storeId').value)}`);
  state.products = data.menus || [];
  renderCategories();
  renderProducts();
}

async function loadSyncBadge() {
  if (!canUse('MANAGER')) {
    $('syncBadge').textContent = '同步由店長監看';
    $('metricSync').textContent = '-';
    return;
  }
  const data = await api('/api/v1/sync/jobs');
  const pending = data.items.filter((item) => item.state !== 'DONE').length;
  $('syncBadge').textContent = `待同步 ${pending}`;
  $('metricSync').textContent = pending;
}

async function submitOrder() {
  if (state.cart.length === 0) { show('orderResult', '購物車不可為空'); return; }
  if (window.PosExtras?.isTrainingMode()) {
    show('orderResult', '訓練模式：訂單未送出至雲端。共 ' + state.cart.reduce((s, i) => s + i.qty * i.price, 0) + ' 元');
    PosExtras.toast('訓練模式 — 訂單未送出', 'warn');
    state.cart = [];
    renderCart();
    return;
  }
  const payload = {
    clientRef: `web-${Date.now()}`,
    storeId: $('storeId').value,
    terminalId: DEVICE_ID,
    businessDate: today(),
    items: state.cart.map((item) => ({
      skuId: item.skuId,
      name: item.productName,
      qty: item.qty,
      unitPrice: item.price,
      discountAmount: 0,
      notes: item.notes || '',
      modifiers: item.modifiers || [],
      addons: item.addons || [],
    })),
    idempotencyKey: newIdempotencyKey(),
  };
  const result = await api('/api/v1/orders', { method: 'POST', body: JSON.stringify(payload) });
  if (result && result.queued) {
    show('orderResult', '已離線：訂單已排入補傳佇列，重新連線後送出。');
    PosExtras?.toast('離線中 — 訂單已排入佇列', 'warn');
    return;
  }
  state.activeOrderId = result.id;
  state.activeOrderTotal = result.grandTotal;
  state.activeOrderPayload = { ...result, items: payload.items };
  show('orderResult', result);
  await loadSyncBadge();
  updateMetrics();
}

async function payOrder(method, printWindow) {
  if (!state.activeOrderId) { show('orderResult', '尚未建立訂單'); if (printWindow) printWindow.close(); return; }
  const amount = state.activeOrderTotal;
  const payload = { paymentMethod: method, amount, cashReceived: amount, idempotencyKey: newIdempotencyKey() };
  if (method === 'CARD') payload.cashierMemo = '手動刷卡授權碼由 PSP/刷卡機保存，POS 不保存卡號。';
  // Attach invoice settings if user set them
  const inv = state.invoiceSettings || {};
  if (inv.buyerTaxId) payload.invoiceBuyerTaxId = inv.buyerTaxId;
  if (inv.carrier) payload.invoiceCarrier = inv.carrier;
  if (inv.donationCode) payload.invoiceDonationCode = inv.donationCode;
  const result = await api(`/api/v1/orders/${state.activeOrderId}/pay/manual`, { method: 'POST', body: JSON.stringify(payload) });
  if (result && result.queued) {
    show('orderResult', '已離線：付款指令已排入補傳佇列，重新連線後會自動送出。');
    PosExtras?.toast('離線結帳已排入佇列', 'warn');
    if (printWindow) printWindow.close();
    return;
  }
  const orderSnapshot = {
    ...(state.activeOrderPayload || {}),
    ...result,
    orderNumber: result.orderNumber || state.activeOrderPayload?.orderNumber,
    subtotal: result.subtotal != null ? result.subtotal : state.activeOrderPayload?.subtotal,
    grandTotal: result.grandTotal != null ? result.grandTotal : amount,
    discountTotal: result.discountTotal != null ? result.discountTotal : state.activeOrderPayload?.discountTotal,
    items: state.activeOrderPayload?.items || [],
    createdAt: state.activeOrderPayload?.createdAt || new Date().toISOString(),
    cashier: state.session?.userName || state.session?.userId || '',
  };
  state.lastPaidOrder = orderSnapshot;
  state.lastPaidOrderId = result.orderId;
  state.lastInvoiceId = result.invoice?.invoiceId || state.lastInvoiceId;
  state.lastInvoicePayload = result.invoice || state.lastInvoicePayload;
  state.cart = [];
  state.activeOrderId = null;
  state.activeOrderTotal = 0;
  state.activeOrderPayload = null;
  renderCart();
  show('orderResult', result);
  if (window.PosExtras) {
    PosExtras.toast('結帳完成：' + (method === 'CARD' ? '刷卡' : '現金') + ' NT$' + money(amount), 'ok');
    autoPrintReceipt(orderSnapshot, { method, amount, change: result.paymentSummary?.change || 0 }, result.invoice, printWindow);
  } else if (printWindow) {
    printWindow.close();
  }
  await Promise.all([loadSyncBadge(), loadHub(), loadInvoiceHealth().catch(() => null), loadPrintJobs().catch(() => null)]);
}

function autoPrintReceipt(order, payment, invoice, printWindow) {
  if (!window.PosExtras) return;
  const qrUrl = PosExtras.buildCustomerUrl(order, {
    storeId: $('storeId').value,
    storeName: state.session?.storeName,
    source: order.source || 'POS',
  });
  PosExtras.printReceipt({
    store: {
      // Use the store's configured contact info when available; never print
      // fabricated demo address/phone on a real receipt. printReceipt renders
      // an empty meta line gracefully when these are blank.
      name: state.session?.storeName || '店家',
      address: state.storeSettings?.address || '',
      phone: state.storeSettings?.phone || '',
    },
    order: {
      orderNumber: order.orderNumber || order.orderId || order.id,
      id: order.orderId || order.id,
      createdAt: order.createdAt,
      subtotal: order.subtotal,
      discountTotal: order.discountTotal,
      grandTotal: order.grandTotal,
      cashier: order.cashier,
    },
    items: order.items || [],
    payment,
    invoice: invoice
      ? {
          invoiceNumber: invoice.invoiceNumber,
          randomCode: invoice.randomCode,
          carrier: state.invoiceSettings?.carrier,
          buyerTaxId: state.invoiceSettings?.buyerTaxId,
        }
      : null,
    qrUrl,
    footer: 'Store Captain POS',
    target: printWindow || null,
  });
}

async function applyDiscount() {
  if (!state.activeOrderId) { show('orderResult', '尚未建立訂單'); return; }
  const result = await api(`/api/v1/orders/${state.activeOrderId}/discount`, { method: 'PATCH', body: JSON.stringify({ amount: 10, reasonCode: 'MANAGER_APPROVAL' }) });
  state.activeOrderTotal = result.grandTotal;
  show('orderResult', result);
  updateMetrics();
}

async function redeemCoupon() {
  if (!state.activeOrderId) { show('orderResult', '尚未建立訂單'); return; }
  const result = await api('/api/v1/coupons/redeem', { method: 'POST', body: JSON.stringify({ orderId: state.activeOrderId, code: 'WELCOME50', idempotencyKey: `coupon-${state.activeOrderId}-${Date.now()}` }) });
  state.activeOrderTotal = result.order.grandTotal;
  show('orderResult', result);
  updateMetrics();
}

async function splitTender() {
  if (!state.activeOrderId) { show('orderResult', '尚未建立訂單'); return; }
  const orderId = state.activeOrderId;
  const first = Math.floor(state.activeOrderTotal / 2);
  const second = state.activeOrderTotal - first;
  // Each leg carries its own idempotencyKey so a network retry / SW-outbox replay
  // re-applies the same partial payment rather than double-charging.
  const cash = await api(`/api/v1/orders/${orderId}/pay/manual`, { method: 'POST', body: JSON.stringify({ paymentMethod: 'CASH', amount: first, cashReceived: first, idempotencyKey: newIdempotencyKey() }) });
  if (cash && cash.queued) {
    show('orderResult', '已離線：第一段付款已排入補傳佇列，重新連線後會自動送出。請勿重複結帳。');
    PosExtras?.toast('離線中 — 混合付款已排入佇列', 'warn');
    return;
  }
  const card = await api(`/api/v1/orders/${orderId}/pay/manual`, { method: 'POST', body: JSON.stringify({ paymentMethod: 'CARD', amount: second, idempotencyKey: newIdempotencyKey(), cashierMemo: '混合付款第二段，POS 不保存卡號。' }) });
  if (card && card.queued) {
    show('orderResult', '已離線：第二段付款已排入補傳佇列，重新連線後會自動送出。');
    PosExtras?.toast('離線中 — 第二段付款已排入佇列', 'warn');
    return;
  }
  state.lastPaidOrderId = card.orderId;
  state.lastInvoiceId = card.invoice?.invoiceId || state.lastInvoiceId;
  state.cart = [];
  state.activeOrderId = null;
  state.activeOrderTotal = 0;
  renderCart();
  show('orderResult', { cash, card });
  await Promise.all([loadSyncBadge(), loadHub(), loadInvoiceHealth().catch(() => null)]);
}

async function refundOrder() {
  const orderId = state.lastPaidOrderId;
  if (!orderId) { show('orderResult', '尚未有可退款已付款訂單'); return; }
  const order = await api(`/api/v1/orders/${orderId}`);
  const amount = Math.min(10, order.grandTotal || 0);
  // Destructive + money-moving: require explicit confirmation. The refund
  // leaves an audit row and triggers a gateway reversal for non-cash methods.
  if (!window.confirm(`確定退款 NT$${amount}?此動作會留下稽核記錄,非現金將觸發金流退款。`)) return;
  show('orderResult', await api(`/api/v1/orders/${orderId}/refund`, { method: 'POST', body: JSON.stringify({ amount, reasonCode: 'CUSTOMER_RETURN', method: 'CASH', restock: true, idempotencyKey: `refund-${orderId}-${Date.now()}` }) }));
  await loadInventory().catch(() => null);
}

async function voidOrder() {
  if (!state.activeOrderId) { show('orderResult', '尚未建立訂單'); return; }
  // Destructive: voiding clears the active order and leaves an audit row.
  if (!window.confirm('確定作廢這筆訂單?作廢後無法復原,並會留下稽核記錄。')) return;
  const result = await api(`/api/v1/orders/${state.activeOrderId}/void`, { method: 'POST', body: JSON.stringify({ reasonCode: 'INPUT_ERROR', actorPin: '1234', note: '前台輸入錯誤' }) });
  state.activeOrderId = null;
  state.activeOrderTotal = 0;
  state.cart = [];
  renderCart();
  show('orderResult', result);
}

function firstProduct() {
  if (!state.products[0]) throw new Error('尚未載入商品');
  return state.products[0];
}

async function createProduct() {
  const name = $('newProductName').value.trim();
  const result = await api('/api/v1/catalog/products', {
    method: 'POST',
    body: JSON.stringify({ name, categoryId: 'drink', status: 'PUBLISHED', skus: [{ skuCode: $('newSku').value.trim(), name, price: Number($('newPrice').value), stockTracked: false }], modifiers: [{ groupName: '甜度', type: 'single', options: ['正常', '半糖', '無糖'] }], publishToStoreIds: [$('storeId').value] }),
  });
  show('catalogResult', result);
  await loadProducts();
}

function isQueued(result) { return result && result.queued === true; }

async function createQrOrder() {
  const item = firstProduct();
  const result = await api('/api/v1/channels/qr/orders', { method: 'POST', body: JSON.stringify({ channel: 'QR', idempotencyKey: `qr-${Date.now()}`, storeId: $('storeId').value, items: [{ skuId: item.skuId, qty: 1 }] }) });
  if (isQueued(result)) { show('orderResult', '已離線：QR 訂單已排入補傳佇列。'); PosExtras?.toast('離線 — QR 訂單已排入', 'warn'); return; }
  state.activeChannelOrderId = result.orderId;
  state.lastChannelOrder = { ...result, source: 'QR' };
  show('orderResult', result);
  if (window.PosExtras) {
    PosExtras.showQR(state.lastChannelOrder, { storeId: $('storeId').value, storeName: state.session?.storeName, source: 'QR' });
  }
  await loadHub();
}

async function createLineOrder() {
  const item = firstProduct();
  const result = await api('/api/v1/channels/line/orders', { method: 'POST', body: JSON.stringify({ channel: 'LINE', lineChannelToken: `line-token-${Date.now()}`, idempotencyKey: `line-${Date.now()}`, storeId: $('storeId').value, items: [{ skuId: item.skuId, qty: 1, notes: '少冰' }] }) });
  if (isQueued(result)) { show('orderResult', '已離線：LINE 訂單已排入補傳佇列。'); PosExtras?.toast('離線 — LINE 訂單已排入', 'warn'); return; }
  state.activeChannelOrderId = result.orderId;
  state.lastChannelOrder = { ...result, source: 'LINE' };
  show('orderResult', result);
  if (window.PosExtras) {
    PosExtras.showQR(state.lastChannelOrder, { storeId: $('storeId').value, storeName: state.session?.storeName, source: 'LINE' });
  }
  await loadHub();
}

async function createPhoneOrder() {
  const item = firstProduct();
  const result = await api('/api/v1/order-sources/manual', { method: 'POST', body: JSON.stringify({ tenantStoreId: $('storeId').value, channel: 'PHONE', externalReferenceId: `phone-${Date.now()}`, customerName: '王小姐', items: [{ skuId: item.skuId, qty: 1, price: item.price }] }) });
  if (isQueued(result)) { show('orderResult', '已離線：電話訂單已排入補傳佇列。'); PosExtras?.toast('離線 — 電話訂單已排入', 'warn'); return; }
  state.activeChannelOrderId = result.orderId;
  state.lastChannelOrder = { ...result, source: 'PHONE' };
  show('orderResult', result);
  if (window.PosExtras) {
    PosExtras.showQR(state.lastChannelOrder, { storeId: $('storeId').value, storeName: state.session?.storeName, source: 'PHONE' });
  }
  await loadHub();
}

async function confirmChannelOrder() {
  if (!state.activeChannelOrderId) {
    const hub = await api(`/api/v1/order-hub?storeId=${encodeURIComponent($('storeId').value)}`);
    state.activeChannelOrderId = hub.items.find((item) => ['QR', 'LINE', 'PHONE'].includes(item.source) && !['CONFIRMED', 'CANCELLED'].includes(item.state))?.orderId || null;
  }
  if (!state.activeChannelOrderId) { show('orderResult', '目前沒有可確認的來源單'); return; }
  const result = await api(`/api/v1/channels/orders/${state.activeChannelOrderId}/status`, { method: 'PATCH', body: JSON.stringify({ state: 'CONFIRMED', actor: state.session.userId, reason: '人工確認接單' }) });
  if (isQueued(result)) { show('orderResult', '已離線：確認接單已排入補傳佇列。'); PosExtras?.toast('離線 — 確認接單已排入', 'warn'); return; }
  show('orderResult', result);
  state.activeChannelOrderId = null;
  await Promise.all([loadHub(), loadInventory().catch(() => null)]);
}

async function loadHub() {
  const data = await api(`/api/v1/order-hub?storeId=${encodeURIComponent($('storeId').value)}`);
  clear($('hub'));
  if (!data.items.length) $('hub').appendChild(h('article', { className: 'empty-state', text: '目前沒有來源單' }));
  for (const item of data.items) {
    const card = document.createElement('article');
    card.className = 'hub-card';
    card.appendChild(h('strong', { text: item.orderId }));
    card.appendChild(h('span', { text: item.source }));
    card.appendChild(h('span', { text: item.state }));
    card.appendChild(h('em', { text: item.paymentState }));
    card.appendChild(h('small', { text: `${item.lineItemCount} 項` }));
    $('hub').appendChild(card);
  }
}

async function loadKds() {
  const result = await api(`/api/v1/kds/orders?storeId=${encodeURIComponent($('storeId').value)}`);
  state.activeKdsOrderId = result.items?.[0]?.orderId || null;
  show('kdsResult', result);
}

async function updateKds(stateName) {
  if (!state.activeKdsOrderId) await loadKds();
  if (!state.activeKdsOrderId) { show('kdsResult', '目前沒有 KDS 訂單'); return; }
  const result = await api(`/api/v1/kds/orders/${state.activeKdsOrderId}`, { method: 'PATCH', body: JSON.stringify({ productionState: stateName }) });
  show('kdsResult', result);
  await loadKds();
}

async function openDrawer() {
  const existing = await api(`/api/v1/cash-drawers/open?storeId=${encodeURIComponent($('storeId').value)}&terminalId=${encodeURIComponent(DEVICE_ID)}`);
  if (existing.cashDrawer) {
    state.cashDrawerId = existing.cashDrawer.cashDrawerId;
    show('drawerResult', { ...existing.cashDrawer, recovered: true, message: '已接續本端末既有開班錢櫃' });
    return;
  }
  let result;
  try {
    result = await api('/api/v1/cash-drawers/open', { method: 'POST', body: JSON.stringify({ storeId: $('storeId').value, terminalId: DEVICE_ID, expectedOpeningCash: Number($('openingCash').value), openedBy: state.session.userId }) });
  } catch (error) {
    if (error.body?.errorCode !== 'CASHBOX_ALREADY_OPEN' || !error.body?.details?.cashDrawerId) throw error;
    result = { cashDrawerId: error.body.details.cashDrawerId, state: 'OPEN', recovered: true, message: '已接續本端末既有開班錢櫃' };
  }
  state.cashDrawerId = result.cashDrawerId;
  show('drawerResult', result);
}

async function closeDrawer() {
  if (!state.cashDrawerId) { show('drawerResult', '尚未開班'); return; }
  const result = await api('/api/v1/cash-drawers/close', { method: 'POST', body: JSON.stringify({ cashDrawerId: state.cashDrawerId, closingCash: Number($('closingCash').value), countedBy: state.session.userId, adjustments: [] }) });
  show('drawerResult', result);
}

async function drawerReport() {
  if (!state.cashDrawerId) { show('drawerResult', '尚未開班'); return; }
  show('drawerResult', await api(`/api/v1/cash-drawers/${state.cashDrawerId}/report`));
}

async function loadReports() {
  const date = today();
  const from = `${date}T00:00:00.000Z`;
  const to = `${date}T23:59:59.999Z`;
  const [daily, payments, top] = await Promise.all([
    api(`/api/v1/reports/daily?date=${date}&storeId=${encodeURIComponent($('storeId').value)}`),
    api(`/api/v1/reports/payment-breakdown?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&storeId=${encodeURIComponent($('storeId').value)}`),
    api(`/api/v1/reports/top-products?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&storeId=${encodeURIComponent($('storeId').value)}&limit=5`),
  ]);
  state.reportSnapshot = { daily, payments, top };
  show('reportResult', { daily, payments, top });
}

async function loadInvoiceHealth() {
  const result = await api(`/api/v1/invoices/health?storeId=${encodeURIComponent($('storeId').value)}`);
  state.invoiceHealth = result;
  show('invoiceResult', result);
  const invoicePanel = $('invoiceResult').closest('article');
  if (invoicePanel) {
    const existing = invoicePanel.querySelector('.risk-sandbox-banner');
    if (result.environment === 'sandbox') {
      if (!existing) {
        const banner = document.createElement('div');
        banner.className = 'risk-sandbox-banner';
        banner.setAttribute('role', 'alert');
        banner.appendChild(h('strong', { text: '沙盒模式' }));
        banner.appendChild(h('span', { text: '此區域顯示之發票資料為沙盒測試，未上傳至加值中心或財政部。請勿視為實際稅務憑證。' }));
        invoicePanel.insertBefore(banner, invoicePanel.firstChild);
      }
    } else if (existing) {
      existing.remove();
    }
  }
  return result;
}

async function markInvoiceUploaded() {
  if (!state.invoiceHealth) await loadInvoiceHealth();
  const target = state.invoiceHealth.exceptions?.[0];
  if (!target) { show('invoiceResult', '目前沒有待上傳或異常發票'); return; }
  const result = await api(`/api/v1/invoices/${target.invoiceId}/mark-uploaded`, { method: 'POST', body: JSON.stringify({}) });
  show('invoiceResult', result);
  await loadInvoiceHealth();
}

async function voidInvoice() {
  if (!state.invoiceHealth) await loadInvoiceHealth();
  const target = state.invoiceHealth.exceptions?.find((item) => item.lifecycleState !== 'VOIDED_SANDBOX') || (state.lastInvoiceId ? { invoiceId: state.lastInvoiceId } : null);
  if (!target) { show('invoiceResult', '目前沒有可作廢 sandbox 發票'); return; }
  const result = await api(`/api/v1/invoices/${target.invoiceId}/void-sandbox`, { method: 'POST', body: JSON.stringify({ reasonCode: 'CUSTOMER_RETURN' }) });
  await loadInvoiceHealth();
  show('invoiceResult', result);
}

async function loadReconciliation() {
  show('reconcileResult', await api(`/api/v1/reconciliation/daily?date=${today()}&storeId=${encodeURIComponent($('storeId').value)}`));
}

async function loadPayments() {
  show('reconcileResult', await api(`/api/v1/payments?storeId=${encodeURIComponent($('storeId').value)}`));
}

async function loadPrintJobs() {
  show('printResult', await api(`/api/v1/print-jobs?storeId=${encodeURIComponent($('storeId').value)}`));
}

async function loadSyncJobs() {
  const result = await api('/api/v1/sync/jobs');
  state.activeSyncJobId = result.items.find((item) => item.state !== 'SYNCED')?.id || result.items[0]?.id || null;
  show('syncRepairResult', result);
}

async function retrySyncJob() {
  if (!state.activeSyncJobId) await loadSyncJobs();
  if (!state.activeSyncJobId) { show('syncRepairResult', '目前沒有同步工作'); return; }
  show('syncRepairResult', await api(`/api/v1/sync/jobs/${state.activeSyncJobId}/retry`, { method: 'POST', body: JSON.stringify({ errorCode: 'SYNC_TIMEOUT', message: 'UI manual retry' }) }));
  await loadSyncJobs();
}

async function resolveSyncJob() {
  if (!state.activeSyncJobId) await loadSyncJobs();
  if (!state.activeSyncJobId) { show('syncRepairResult', '目前沒有同步工作'); return; }
  show('syncRepairResult', await api(`/api/v1/sync/jobs/${state.activeSyncJobId}/resolve`, { method: 'POST', body: JSON.stringify({ resolution: 'MARK_SYNCED', reason: 'UI manual repair verified' }) }));
  await loadSyncJobs();
}

async function retryPrintJob() {
  const jobs = await api(`/api/v1/print-jobs?storeId=${encodeURIComponent($('storeId').value)}&state=FAILED`);
  const target = jobs.items?.[0];
  if (!target) { show('printResult', '目前沒有失敗列印可重打；結帳後會產生 QUEUED 收據佇列。'); return; }
  show('printResult', await api(`/api/v1/print-jobs/${target.id}/retry`, { method: 'POST', body: JSON.stringify({ reason: 'MANUAL_REPRINT', requestedBy: state.session.userId }) }));
}

async function createReportExport() {
  const date = today();
  const result = await api('/api/v1/reports/exports', { method: 'POST', body: JSON.stringify({ reportType: 'daily', from: date, to: date, storeIds: [$('storeId').value], format: 'CSV' }) });
  state.reportExportId = result.exportId;
  show('exportResult', result);
}

async function loadReportExport() {
  if (!state.reportExportId) { show('exportResult', '尚未建立匯出'); return; }
  show('exportResult', await api(`/api/v1/reports/exports/${state.reportExportId}`));
}

async function loadInventory() {
  const result = await api('/api/v1/inventory/levels');
  state.inventory = result.items || [];
  if (state.inventory[0]) $('inventorySku').value = state.inventory[0].skuId;
  show('inventoryResult', result);
  return result;
}

async function postStockCount() {
  if (!state.inventory[0]) await loadInventory();
  const first = state.inventory[0];
  if (!first) { show('inventoryResult', '沒有可盤點 SKU'); return; }
  show('inventoryResult', await api('/api/v1/inventory/counts', { method: 'POST', body: JSON.stringify({ storeId: $('storeId').value, items: [{ skuId: first.skuId, countedQty: first.stockOnHand }] }) }));
  await loadInventory();
}

async function recordTransfer() {
  if (!state.inventory[0]) await loadInventory();
  const first = state.inventory[0];
  if (!first) { show('inventoryResult', '沒有可調撥 SKU'); return; }
  show('inventoryResult', await api('/api/v1/inventory/transfers', { method: 'POST', body: JSON.stringify({ skuId: first.skuId, qty: 1, fromStoreId: $('storeId').value, toStoreId: 'store-002' }) }));
}

async function adjustInventory() {
  const result = await api('/api/v1/inventory/adjustments', { method: 'POST', body: JSON.stringify({ skuId: $('inventorySku').value, qty: Number($('inventoryQty').value), reason: $('inventoryReason').value, referenceId: `ui-${Date.now()}` }) });
  show('inventoryResult', result);
  await loadInventory();
}

async function createMember() {
  const result = await api('/api/v1/customers', { method: 'POST', body: JSON.stringify({ phone: $('memberPhone').value.trim(), name: $('memberName').value.trim(), lineBound: true, tags: ['首購'] }) });
  state.activeCustomerId = result.id;
  show('memberResult', result);
}

async function searchMember() {
  const result = await api(`/api/v1/customers/search?phone=${encodeURIComponent($('memberPhone').value.trim())}`);
  state.activeCustomerId = result.items?.[0]?.id || state.activeCustomerId;
  show('memberResult', result);
}

async function loadCoupons() { show('memberResult', await api('/api/v1/coupons')); }

async function adjustPoints() {
  if (!state.activeCustomerId) await searchMember();
  if (!state.activeCustomerId) { show('memberResult', '尚未有會員'); return; }
  show('memberResult', await api('/api/v1/customers/points/adjust', { method: 'POST', body: JSON.stringify({ customerId: state.activeCustomerId, points: 10, reasonCode: 'ADJUST', idempotencyKey: `points-${state.activeCustomerId}-${Date.now()}` }) }));
}

async function loadCategories() { show('catalogResult', await api('/api/v1/catalog/categories')); }
async function exportCatalog() { show('catalogResult', await api('/api/v1/catalog/export')); }
async function importCatalog() { show('catalogResult', await api('/api/v1/catalog/import', { method: 'POST', body: JSON.stringify({ products: [{ name: `季節新品${Date.now().toString().slice(-4)}`, skuCode: `SEASON-${Date.now().toString().slice(-6)}`, price: 88, categoryId: 'drink', stockTracked: false, modifiers: [{ groupName: '甜度', type: 'single', options: ['正常', '半糖'] }], publishToStoreIds: [$('storeId').value] }] }) })); await loadProducts(); }

async function loadUsers() { show('settingsResult', await api('/api/v1/users')); }
async function createUser() { show('settingsResult', await api('/api/v1/users', { method: 'POST', body: JSON.stringify({ name: $('newUserName').value, role: 'CASHIER', pin: $('newUserPin').value, storeIds: [$('storeId').value] }) })); }
async function loadStoreSettings() {
  const settings = await api(`/api/v1/settings/store?storeId=${encodeURIComponent($('storeId').value)}`);
  state.storeSettings = settings && !settings.queued ? settings : state.storeSettings;
  show('settingsResult', settings);
}

async function loadAiBrief() { show('aiResult', await api('/api/v1/ai/daily-brief')); }

async function sendHeartbeat() {
  show('telemetryResult', await api('/api/v1/telemetry/heartbeat', { method: 'POST', body: JSON.stringify({ terminalId: DEVICE_ID, storeId: $('storeId').value, syncLagSeconds: 12, printerStatus: 'OK', queuedOutbox: 1, printErrorCount: 0 }) }));
}

async function loadTelemetry() { show('telemetryResult', await api(`/api/v1/telemetry/dashboard?storeId=${encodeURIComponent($('storeId').value)}`)); }
async function loadAudit() { show('auditResult', await api('/api/v1/audit-logs?page=1&pageSize=20')); }

async function loadSubscription() {
  const data = await api('/api/v1/subscription/current');
  if (data && data.errorCode) { show('subscriptionResult', data); return; }
  // Compact summary — plan, period, usage, entitlements
  const summary = {
    planCode: data.planCode,
    status: data.status,
    billingCycle: data.billingCycle,
    paymentState: data.paymentState,
    currentPeriodStart: data.currentPeriodStart,
    currentPeriodEnd: data.currentPeriodEnd,
    seats: `${data.usage && data.usage.activeSeats}/${data.limits && data.limits.seatLimit === null ? '∞' : (data.limits && data.limits.seatLimit)}`,
    stores: `${data.usage && data.usage.activeStores}/${data.limits && data.limits.storeLimit === null ? '∞' : (data.limits && data.limits.storeLimit)}`,
    entitlements: data.entitlements,
    billingNote: data.billing && data.billing.note,
  };
  show('subscriptionResult', summary);
}

async function changeSubscription(planCode) {
  const result = await api('/api/v1/subscription/change', {
    method: 'POST',
    body: JSON.stringify({ planCode, billingCycle: 'MONTHLY', idempotencyKey: `change-${planCode}-${Date.now()}` }),
  });
  show('subscriptionResult', result);
}

async function cancelSubscriptionRequest() {
  const result = await api('/api/v1/subscription/cancel', {
    method: 'POST',
    body: JSON.stringify({ reasonCode: 'OWNER_REQUEST', idempotencyKey: `cancel-${Date.now()}` }),
  });
  show('subscriptionResult', result);
}

// ---- new feature wiring --------------------------------------------------
function openScannerForSearch() {
  if (!window.PosExtras) return;
  PosExtras.openScanner((code) => {
    $('productSearch').value = code.trim();
    renderProducts();
    const match = state.products.find((p) => (p.skuCode || '').toLowerCase() === code.toLowerCase());
    if (match) {
      addToCart(match);
      PosExtras.toast('已加入：' + match.productName, 'ok');
    } else {
      PosExtras.toast('未對應商品 — 已填入搜尋', 'warn');
    }
  });
}

function showInvoiceSettings() {
  if (!window.PosExtras) return;
  const s = state.invoiceSettings;
  const form = document.createElement('form');
  form.className = 'invoice-form';
  const modeWrap = h('div', { className: 'invoice-mode', attrs: { role: 'radiogroup' } });
  [
    ['B2C', 'B2C 一般'],
    ['MOBILE', '手機條碼'],
    ['DONATION', '捐贈發票'],
    ['B2B', 'B2B 統編'],
  ].forEach(([value, label]) => {
    const input = h('input', { attrs: { type: 'radio', name: 'mode', value } });
    input.checked = s.mode === value;
    modeWrap.appendChild(h('label', {}, [input, label]));
  });
  form.appendChild(h('fieldset', { className: 'invoice-fieldset' }, [
    h('legend', { className: 'eyebrow invoice-legend', text: '發票模式' }),
    modeWrap,
  ]));

  function invoiceField(field, label, attrs) {
    const input = h('input', { attrs: { name: field, ...attrs } });
    input.value = s[field] || '';
    const validity = h('span', { className: 'validity', text: '—', attrs: { 'data-valid': field } });
    return h('label', { attrs: { 'data-field': field } }, [
      label,
      h('div', { className: 'field-row' }, [input, validity]),
    ]);
  }

  form.appendChild(invoiceField('carrier', '手機條碼 (例：/AB12345)', { placeholder: '/XXXXXXX' }));
  form.appendChild(invoiceField('buyerTaxId', '買方統一編號 (8 碼)', { placeholder: '12345675', inputmode: 'numeric', maxlength: '8' }));
  form.appendChild(invoiceField('donationCode', '捐贈碼 (3-7 碼，例：8585 創世)', { placeholder: '8585', inputmode: 'numeric', maxlength: '7' }));
  form.appendChild(h('p', { className: 'note invoice-note', text: '選擇模式後，於結帳時會將載具或統編附加至發票申請。所有變動會留下 audit。' }));
  function applyVisibility(mode) {
    form.querySelector('[data-field="carrier"]').hidden = mode !== 'MOBILE';
    form.querySelector('[data-field="buyerTaxId"]').hidden = mode !== 'B2B';
    form.querySelector('[data-field="donationCode"]').hidden = mode !== 'DONATION';
  }
  applyVisibility(s.mode);
  function validate() {
    const carrier = form.querySelector('[name="carrier"]').value.trim();
    const tax = form.querySelector('[name="buyerTaxId"]').value.trim();
    const donation = form.querySelector('[name="donationCode"]').value.trim();
    const vCarrier = form.querySelector('[data-valid="carrier"]');
    const vTax = form.querySelector('[data-valid="buyerTaxId"]');
    const vDonation = form.querySelector('[data-valid="donationCode"]');
    vCarrier.classList.remove('ok', 'err');
    vTax.classList.remove('ok', 'err');
    vDonation.classList.remove('ok', 'err');
    if (carrier) { const ok = PosExtras.isValidMobileBarcode(carrier); vCarrier.classList.add(ok ? 'ok' : 'err'); vCarrier.textContent = ok ? '格式正確' : '格式錯誤'; } else vCarrier.textContent = '—';
    if (tax) { const ok = PosExtras.isValidTaxId(tax); vTax.classList.add(ok ? 'ok' : 'err'); vTax.textContent = ok ? '校驗通過' : '校驗失敗'; } else vTax.textContent = '—';
    if (donation) { const ok = PosExtras.isValidDonationCode(donation); vDonation.classList.add(ok ? 'ok' : 'err'); vDonation.textContent = ok ? '格式正確' : '格式錯誤'; } else vDonation.textContent = '—';
  }
  form.querySelectorAll('input[name="mode"]').forEach((r) => r.addEventListener('change', () => applyVisibility(r.value)));
  form.querySelectorAll('input:not([type="radio"])').forEach((i) => i.addEventListener('input', validate));
  validate();
  const foot = document.createElement('div');
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'ghost';
  cancel.textContent = '取消';
  cancel.addEventListener('click', () => PosExtras.closeModal());
  const save = document.createElement('button');
  save.type = 'button';
  save.textContent = '儲存設定';
  save.addEventListener('click', () => {
    const fd = new FormData(form);
    const mode = fd.get('mode');
    const carrier = String(fd.get('carrier') || '').trim();
    const tax = String(fd.get('buyerTaxId') || '').trim();
    const donation = String(fd.get('donationCode') || '').trim();
    if (mode === 'MOBILE' && carrier && !PosExtras.isValidMobileBarcode(carrier)) { PosExtras.toast('手機條碼格式錯誤', 'err'); return; }
    if (mode === 'B2B' && tax && !PosExtras.isValidTaxId(tax)) { PosExtras.toast('統編校驗失敗', 'err'); return; }
    if (mode === 'DONATION' && donation && !PosExtras.isValidDonationCode(donation)) { PosExtras.toast('捐贈碼格式錯誤', 'err'); return; }
    state.invoiceSettings = {
      mode,
      carrier: mode === 'MOBILE' ? carrier : '',
      buyerTaxId: mode === 'B2B' ? tax : '',
      donationCode: mode === 'DONATION' ? donation : '',
    };
    saveInvoiceSettings();
    PosExtras.toast('發票設定已儲存：' + mode, 'ok');
    PosExtras.closeModal();
  });
  foot.appendChild(cancel);
  foot.appendChild(save);
  PosExtras.showModal({
    title: '發票模式設定',
    lead: '本店家此筆訂單的開立模式。儲存後會帶入下一筆結帳。',
    body: form,
    footer: foot,
  });
}

function reprintReceipt() {
  if (!state.lastPaidOrder) { PosExtras?.toast('沒有可重印的訂單', 'warn'); return; }
  const printWindow = window.PosExtras?.preparePrintWindow() || null;
  autoPrintReceipt(state.lastPaidOrder, { method: 'REPRINT', amount: state.lastPaidOrder.grandTotal, change: 0 }, state.lastInvoicePayload, printWindow);
}

function showOrderQr() {
  const order = state.lastChannelOrder || (state.activeOrderId ? { orderId: state.activeOrderId, grandTotal: state.activeOrderTotal } : state.lastPaidOrder);
  if (!order) { PosExtras?.toast('沒有可建立 QR 的訂單', 'warn'); return; }
  PosExtras?.showQR(order, { storeId: $('storeId').value, storeName: state.session?.storeName, source: order.source || 'POS' });
}

function exportReportCsv() {
  if (!state.reportSnapshot) { PosExtras?.toast('請先按「日報排行」載入資料', 'warn'); return; }
  const snapshot = state.reportSnapshot;
  const rows = [];
  if (snapshot.daily?.totals) {
    rows.push({ 區塊: '今日總計', 鍵: '營收', 值: snapshot.daily.totals.revenue || 0 });
    rows.push({ 區塊: '今日總計', 鍵: '訂單數', 值: snapshot.daily.totals.orderCount || 0 });
  }
  if (snapshot.payments?.breakdown) {
    for (const row of snapshot.payments.breakdown) {
      rows.push({ 區塊: '付款方式', 鍵: row.method, 值: row.amount });
    }
  }
  if (snapshot.top?.items) {
    for (const item of snapshot.top.items) {
      rows.push({ 區塊: '熱銷商品', 鍵: item.name, 值: item.netAmount, 數量: item.soldQty });
    }
  }
  PosExtras.downloadCSV(`store-captain-daily-${today()}.csv`, rows);
}

function switchView(viewId) {
  for (const view of document.querySelectorAll('.view')) view.classList.toggle('active', view.id === viewId);
  for (const button of document.querySelectorAll('.nav-button')) button.classList.toggle('active', button.dataset.view === viewId);
}

let _runInFlight = false;
async function run(fn, outputId) {
  // Single in-flight guard: drop re-entrant clicks while an operation is
  // running. Without it, a double-click on 送出訂單 / 結帳 fires two requests
  // with distinct idempotency keys, so the server cannot dedupe them and
  // creates a duplicate order or payment.
  if (_runInFlight) { window.PosExtras?.toast('處理中,請稍候…', 'warn'); return; }
  _runInFlight = true;
  // Visible global busy state — the bottom status pill is below the fold on
  // tablet layouts, so drive a top progress bar + dim action buttons via CSS.
  document.body.dataset.busy = '1';
  try {
    setStatus('處理中', 'busy');
    await fn();
    setStatus('完成');
  } catch (error) {
    const message = friendlyError(error);
    if (outputId) show(outputId, message);
    setStatus(message, 'error');
  } finally {
    _runInFlight = false;
    delete document.body.dataset.busy;
  }
}

function bindAuthUI() {
  // Tab switcher
  const tabs = document.querySelectorAll('.auth-tab');
  const panels = document.querySelectorAll('.auth-tabpanel');
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      tabs.forEach((t) => {
        const active = t === tab;
        t.classList.toggle('is-active', active);
        t.setAttribute('aria-selected', String(active));
      });
      panels.forEach((p) => { p.hidden = p.dataset.panel !== target; });
    });
  });

  // Password show/hide toggle
  const eye = $('toggleLoginPassword');
  const pwd = $('loginPassword');
  if (eye && pwd) {
    eye.addEventListener('click', () => {
      const showing = pwd.type === 'text';
      pwd.type = showing ? 'password' : 'text';
      eye.setAttribute('aria-label', showing ? '顯示密碼' : '隱藏密碼');
    });
  }

  // Login form submit → fall through to demo profile (MANAGER on breakfast-a) for now
  const loginForm = $('authLoginForm');
  if (loginForm) {
    loginForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const email = $('loginEmail').value.trim();
      const password = $('loginPassword').value;
      if (!email || !password) {
        PosExtras?.toast('請填寫電子郵件與密碼', 'warn');
        return;
      }
      PosExtras?.toast('登入中…', 'ok');
      run(async () => {
        clearSession();
        await login({ tenant: 'breakfast-a', store: 'store-001', role: 'MANAGER', pin: '5001', name: '晨光早餐店', user: email.split('@')[0] || '店長' });
        await bootData();
      }, 'orderResult');
    });
  }

  // Register form
  const regForm = $('authRegisterForm');
  if (regForm) {
    regForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const storeName = $('regStoreName').value.trim();
      const contact = $('regContact').value.trim();
      const email = $('regEmail').value.trim();
      const password = $('regPassword').value;
      const storeType = $('regStoreType').value;
      const agreed = $('regAgree').checked;
      if (!storeName || !contact || !email || !password || !storeType) {
        PosExtras?.toast('請填寫所有欄位', 'warn');
        return;
      }
      if (password.length < 8) {
        PosExtras?.toast('密碼至少需要 8 個字元', 'err');
        return;
      }
      if (!agreed) {
        PosExtras?.toast('請同意服務條款', 'warn');
        return;
      }
      PosExtras?.toast('帳號建立中… 進入 14 天免費試用', 'ok');
      run(async () => {
        clearSession();
        await login({ tenant: 'breakfast-a', store: 'store-001', role: 'MANAGER', pin: '5001', name: storeName, user: contact });
        await bootData();
      }, 'orderResult');
    });
  }

  // OAuth provider buttons
  document.querySelectorAll('.oauth-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const provider = btn.dataset.provider;
      const map = { google: 'Google', line: 'LINE', apple: 'Apple ID' };
      const label = map[provider] || provider;
      PosExtras?.toast(`示範環境暫不串接 ${label}。正式版上線後可用 ${label} 一鍵登入。`, 'warn');
    });
  });

  // Forgot password
  const forgot = $('forgotPassword');
  if (forgot) {
    forgot.addEventListener('click', (event) => {
      event.preventDefault();
      PosExtras?.toast('示範環境：請聯絡 hello@storecaptain.local 取得密碼重設連結。', 'warn');
    });
  }
}

function bind() {
  bindAuthUI();
  document.querySelectorAll('.profile-button').forEach((button) => button.addEventListener('click', () => run(async () => {
    clearSession();
    await login({ tenant: button.dataset.tenant, store: button.dataset.store, role: button.dataset.role, pin: button.dataset.pin, name: button.dataset.name, user: button.dataset.user });
    await bootData();
  }, 'orderResult')));
  document.querySelectorAll('.nav-button').forEach((button) => button.addEventListener('click', () => switchView(button.dataset.view)));
  $('productSearch').addEventListener('input', renderProducts);
  $('loginButton').addEventListener('click', () => { clearSession(); showAuthGate(true); setStatus('請選擇要登入的店家', 'warn'); });
  $('logoutButton').addEventListener('click', () => run(logout, 'orderResult'));
  $('reload').addEventListener('click', () => run(bootData, 'orderResult'));
  $('submitOrder').addEventListener('click', () => run(submitOrder, 'orderResult'));
  $('payOrder').addEventListener('click', () => {
    const printWindow = window.PosExtras?.preparePrintWindow() || null;
    run(() => payOrder('CASH', printWindow), 'orderResult');
  });
  $('cardOrder').addEventListener('click', () => {
    const printWindow = window.PosExtras?.preparePrintWindow() || null;
    run(() => payOrder('CARD', printWindow), 'orderResult');
  });
  $('voidOrder').addEventListener('click', () => run(voidOrder, 'orderResult'));
  $('applyDiscount').addEventListener('click', () => run(applyDiscount, 'orderResult'));
  $('redeemCoupon').addEventListener('click', () => run(redeemCoupon, 'orderResult'));
  $('splitTender').addEventListener('click', () => run(splitTender, 'orderResult'));
  $('refundOrder').addEventListener('click', () => run(refundOrder, 'orderResult'));
  $('createProduct').addEventListener('click', () => run(createProduct, 'catalogResult'));
  $('loadCategories').addEventListener('click', () => run(loadCategories, 'catalogResult'));
  $('exportCatalog').addEventListener('click', () => run(exportCatalog, 'catalogResult'));
  $('importCatalog').addEventListener('click', () => run(importCatalog, 'catalogResult'));
  $('createQrOrder').addEventListener('click', () => run(createQrOrder, 'orderResult'));
  $('createLineOrder').addEventListener('click', () => run(createLineOrder, 'orderResult'));
  $('createPhoneOrder').addEventListener('click', () => run(createPhoneOrder, 'orderResult'));
  $('confirmChannelOrder').addEventListener('click', () => run(confirmChannelOrder, 'orderResult'));
  $('loadHub').addEventListener('click', () => run(loadHub, 'orderResult'));
  $('loadKds').addEventListener('click', () => run(loadKds, 'kdsResult'));
  $('startKdsOrder').addEventListener('click', () => run(() => updateKds('IN_PROGRESS'), 'kdsResult'));
  $('readyKdsOrder').addEventListener('click', () => run(() => updateKds('READY'), 'kdsResult'));
  $('openDrawer').addEventListener('click', () => run(openDrawer, 'drawerResult'));
  $('closeDrawer').addEventListener('click', () => run(closeDrawer, 'drawerResult'));
  $('drawerReport').addEventListener('click', () => run(drawerReport, 'drawerResult'));
  $('loadReports').addEventListener('click', () => run(loadReports, 'reportResult'));
  $('loadInvoiceHealth').addEventListener('click', () => run(loadInvoiceHealth, 'invoiceResult'));
  $('markInvoiceUploaded').addEventListener('click', () => run(markInvoiceUploaded, 'invoiceResult'));
  $('voidInvoice').addEventListener('click', () => run(voidInvoice, 'invoiceResult'));
  $('loadReconciliation').addEventListener('click', () => run(loadReconciliation, 'reconcileResult'));
  $('loadPayments').addEventListener('click', () => run(loadPayments, 'reconcileResult'));
  $('loadPrintJobs').addEventListener('click', () => run(loadPrintJobs, 'printResult'));
  $('retryPrintJob').addEventListener('click', () => run(retryPrintJob, 'printResult'));
  $('loadSyncJobs').addEventListener('click', () => run(loadSyncJobs, 'syncRepairResult'));
  $('retrySyncJob').addEventListener('click', () => run(retrySyncJob, 'syncRepairResult'));
  $('resolveSyncJob').addEventListener('click', () => run(resolveSyncJob, 'syncRepairResult'));
  $('createReportExport').addEventListener('click', () => run(createReportExport, 'exportResult'));
  $('loadReportExport').addEventListener('click', () => run(loadReportExport, 'exportResult'));
  $('loadInventory').addEventListener('click', () => run(loadInventory, 'inventoryResult'));
  $('adjustInventory').addEventListener('click', () => run(adjustInventory, 'inventoryResult'));
  $('postStockCount').addEventListener('click', () => run(postStockCount, 'inventoryResult'));
  $('recordTransfer').addEventListener('click', () => run(recordTransfer, 'inventoryResult'));
  $('createMember').addEventListener('click', () => run(createMember, 'memberResult'));
  $('searchMember').addEventListener('click', () => run(searchMember, 'memberResult'));
  $('loadCoupons').addEventListener('click', () => run(loadCoupons, 'memberResult'));
  $('adjustPoints').addEventListener('click', () => run(adjustPoints, 'memberResult'));
  $('loadUsers').addEventListener('click', () => run(loadUsers, 'settingsResult'));
  $('createUser').addEventListener('click', () => run(createUser, 'settingsResult'));
  $('loadStoreSettings').addEventListener('click', () => run(loadStoreSettings, 'settingsResult'));
  $('loadAiBrief').addEventListener('click', () => run(loadAiBrief, 'aiResult'));
  $('sendHeartbeat').addEventListener('click', () => run(sendHeartbeat, 'telemetryResult'));
  $('loadTelemetry').addEventListener('click', () => run(loadTelemetry, 'telemetryResult'));
  $('loadAudit').addEventListener('click', () => run(loadAudit, 'auditResult'));
  if ($('loadSubscription')) $('loadSubscription').addEventListener('click', () => run(loadSubscription, 'subscriptionResult'));
  if ($('upgradeGrowth')) $('upgradeGrowth').addEventListener('click', () => run(() => changeSubscription('GROWTH'), 'subscriptionResult'));
  if ($('upgradeChain')) $('upgradeChain').addEventListener('click', () => run(() => changeSubscription('CHAIN'), 'subscriptionResult'));
  if ($('cancelSubscription')) $('cancelSubscription').addEventListener('click', () => run(cancelSubscriptionRequest, 'subscriptionResult'));

  // -- extras --
  const scanBtn = $('scanButton');
  if (scanBtn) scanBtn.addEventListener('click', () => run(async () => openScannerForSearch(), 'orderResult'));
  const invSettings = $('invoiceSettings');
  if (invSettings) invSettings.addEventListener('click', () => showInvoiceSettings());
  const reprintBtn = $('reprintReceipt');
  if (reprintBtn) reprintBtn.addEventListener('click', () => reprintReceipt());
  const orderQrBtn = $('showOrderQr');
  if (orderQrBtn) orderQrBtn.addEventListener('click', () => showOrderQr());
  const trainingToggle = $('trainingToggle');
  if (trainingToggle && window.PosExtras) {
    trainingToggle.checked = PosExtras.isTrainingMode();
    trainingToggle.addEventListener('change', () => {
      PosExtras.setTrainingMode(trainingToggle.checked);
      PosExtras.toast(trainingToggle.checked ? '訓練模式已啟用' : '訓練模式已關閉', trainingToggle.checked ? 'warn' : 'ok');
    });
  }
  const localCsv = $('localCsvExport');
  if (localCsv) localCsv.addEventListener('click', () => exportReportCsv());
}

async function bootData() {
  await loadProducts();
  await Promise.all([loadHub(), loadSyncBadge().catch(() => null), canUse('MANAGER') ? loadInventory().catch(() => null) : Promise.resolve()]);
  renderCart();
}

// Register service worker for offline shell + outbox queue.
let queuedOps = 0;
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch((err) => console.warn('SW register failed', err));
  navigator.serviceWorker.addEventListener('message', (event) => {
    const data = event.data || {};
    if (data.type === 'queued') {
      queuedOps += 1;
      window.PosExtras?.setNetQueued(queuedOps);
      window.PosExtras?.toast('已離線 — 操作已排入補傳佇列', 'warn');
    } else if (data.type === 'queue-drained') {
      queuedOps = 0;
      window.PosExtras?.setNetQueued(0);
      window.PosExtras?.toast('離線佇列已補傳完成' + (data.dropped ? `（放棄 ${data.dropped} 筆）` : ''), 'ok');
    } else if (data.type === 'queue-auth-expired') {
      window.PosExtras?.toast('Session 已過期，請重新登入後再補傳佇列', 'err');
    }
  });
  window.addEventListener('online', () => {
    navigator.serviceWorker.ready.then((reg) => {
      if (reg.sync) {
        reg.sync.register('store-captain-drain').catch(() => {
          navigator.serviceWorker.controller?.postMessage({ type: 'drain-now' });
        });
      } else {
        navigator.serviceWorker.controller?.postMessage({ type: 'drain-now' });
      }
    });
  });
}

bind();
// Demo profile gate: server reports demoProfilesEnabled in /health. In
// production the 3 hardcoded shortcut buttons (with cleartext PINs) are
// hidden and a "請以商家帳號登入" message takes their place.
async function applyDemoProfileGate() {
  try {
    const r = await fetch('/health', { cache: 'no-store' });
    if (!r.ok) return;
    const body = await r.json();
    const enabled = body.demoProfilesEnabled !== false;
    const demoEl = document.querySelector('[data-demo-profiles]');
    const prodEl = document.querySelector('[data-prod-profiles]');
    if (demoEl) demoEl.hidden = !enabled;
    if (prodEl) prodEl.hidden = enabled;
  } catch { /* health unreachable — leave demo visible for offline-shell access */ }
}
run(async () => {
  applyDemoProfileGate();
  await restoreSession();
  if (inSession()) await bootData();
  else showAuthGate(true);
}, 'orderResult');
