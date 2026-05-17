/*
 * pos-extras.js
 * Real implementations of POS workstation auxiliary behaviour:
 *   - Modal infrastructure (showModal / closeModal)
 *   - Toast notifications
 *   - QR code display (uses /lib/qrcode.js)
 *   - Receipt print window (browser print)
 *   - CSV download from JSON
 *   - Webcam scanner via BarcodeDetector API
 *   - 統編 (TW BAN) algorithm validator
 *   - 手機條碼 / 自然人憑證 format check
 *   - Training mode toggle (persisted via localStorage)
 *   - Online / offline status pill
 *
 * Exposes globalThis.PosExtras.
 */
(function (root) {
  'use strict';

  // ------------------------------------------------------------
  // Modal infrastructure
  // ------------------------------------------------------------
  function ensureModalRoot() {
    var rootEl = document.getElementById('modalRoot');
    if (!rootEl) {
      rootEl = document.createElement('div');
      rootEl.id = 'modalRoot';
      rootEl.className = 'modal-root';
      rootEl.setAttribute('aria-hidden', 'true');
      document.body.appendChild(rootEl);
    }
    return rootEl;
  }

  var modalReturnFocus = null;
  function closeModal() {
    var rootEl = document.getElementById('modalRoot');
    if (!rootEl) return;
    rootEl.setAttribute('aria-hidden', 'true');
    while (rootEl.firstChild) rootEl.removeChild(rootEl.firstChild);
    document.removeEventListener('keydown', modalKeyHandler, true);
    if (modalReturnFocus && typeof modalReturnFocus.focus === 'function') {
      try { modalReturnFocus.focus(); } catch (e) {}
    }
    modalReturnFocus = null;
  }

  function getFocusables(container) {
    return Array.prototype.slice.call(
      container.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')
    );
  }

  function modalKeyHandler(event) {
    if (event.key === 'Escape') { event.stopPropagation(); closeModal(); return; }
    if (event.key !== 'Tab') return;
    var rootEl = document.getElementById('modalRoot');
    if (!rootEl || rootEl.getAttribute('aria-hidden') !== 'false') return;
    var card = rootEl.querySelector('.modal-card');
    if (!card) return;
    var focusables = getFocusables(card);
    if (!focusables.length) { event.preventDefault(); return; }
    var first = focusables[0];
    var last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  /**
   * showModal({ title, lead, body, footer, onClose })
   * `body` and `footer` can be strings (HTML) or HTMLElement.
   */
  function showModal(opts) {
    opts = opts || {};
    var rootEl = ensureModalRoot();
    while (rootEl.firstChild) rootEl.removeChild(rootEl.firstChild);
    var backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.addEventListener('click', closeModal);
    rootEl.appendChild(backdrop);

    var card = document.createElement('div');
    card.className = 'modal-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    if (opts.title) card.setAttribute('aria-label', opts.title);
    rootEl.appendChild(card);

    var head = document.createElement('div');
    head.className = 'modal-head';
    var titleWrap = document.createElement('div');
    if (opts.title) {
      var h = document.createElement('h2');
      h.textContent = opts.title;
      titleWrap.appendChild(h);
    }
    if (opts.lead) {
      var p = document.createElement('p');
      p.textContent = opts.lead;
      titleWrap.appendChild(p);
    }
    head.appendChild(titleWrap);
    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'modal-close';
    close.setAttribute('aria-label', '關閉');
    close.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6 L18 18 M18 6 L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    close.addEventListener('click', closeModal);
    head.appendChild(close);
    card.appendChild(head);

    var body = document.createElement('div');
    body.className = 'modal-body';
    if (opts.body instanceof HTMLElement) body.appendChild(opts.body);
    else if (typeof opts.body === 'string') body.innerHTML = opts.body;
    card.appendChild(body);

    if (opts.footer) {
      var foot = document.createElement('div');
      foot.className = 'modal-foot';
      if (opts.footer instanceof HTMLElement) foot.appendChild(opts.footer);
      else if (typeof opts.footer === 'string') foot.innerHTML = opts.footer;
      card.appendChild(foot);
    }

    rootEl.setAttribute('aria-hidden', 'false');
    modalReturnFocus = document.activeElement;
    document.addEventListener('keydown', modalKeyHandler, true);
    var focusables = getFocusables(card);
    if (focusables.length) focusables[0].focus();

    return { card: card, body: body, close: closeModal };
  }

  // ------------------------------------------------------------
  // Toast
  // ------------------------------------------------------------
  function ensureToastRoot() {
    var t = document.getElementById('toastRoot');
    if (!t) {
      t = document.createElement('div');
      t.id = 'toastRoot';
      t.className = 'toast-root';
      t.setAttribute('aria-live', 'polite');
      document.body.appendChild(t);
    }
    return t;
  }
  function toast(message, tone) {
    var t = ensureToastRoot();
    var el = document.createElement('div');
    el.className = 'toast ' + (tone ? 'toast--' + tone : '');
    el.textContent = message;
    t.appendChild(el);
    setTimeout(function () {
      el.style.transition = 'opacity .22s ease, transform .22s ease';
      el.style.opacity = '0';
      el.style.transform = 'translateY(6px)';
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 240);
    }, tone === 'err' ? 4200 : 2600);
  }

  // ------------------------------------------------------------
  // QR display (uses QRCode.toSVG)
  // ------------------------------------------------------------
  function buildCustomerUrl(order, extras) {
    extras = extras || {};
    var params = [];
    function add(k, v) { if (v != null && v !== '') params.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v))); }
    add('id', order.orderId || order.id);
    add('source', order.source || extras.source || 'QR');
    add('store', order.storeId || extras.storeId);
    add('storeName', extras.storeName);
    add('total', order.grandTotal != null ? order.grandTotal : order.amount);
    add('t', Date.now());
    return location.origin + '/o.html#' + params.join('&');
  }

  function showQR(order, extras) {
    extras = extras || {};
    if (!root.QRCode) {
      toast('QR 函式庫尚未載入', 'err');
      return;
    }
    var url = buildCustomerUrl(order, extras);
    var svg = root.QRCode.toSVG(url, { scale: 6, margin: 3, ecc: 'M' });
    var body = document.createElement('div');
    body.innerHTML =
      '<div class="qr-wrap">' + svg +
      '<div class="qr-meta"><strong>' + url + '</strong><small>QR 編碼 · ' + (extras.source || order.source || 'QR') + ' 來源 · 訂單 ' + (order.orderId || order.id || '—') + '</small></div>' +
      '</div>';
    var foot = document.createElement('div');
    var openBtn = document.createElement('a');
    openBtn.className = 'ghost';
    openBtn.href = url;
    openBtn.target = '_blank';
    openBtn.rel = 'noopener';
    openBtn.textContent = '在新分頁開啟客戶頁';
    openBtn.style.cssText = 'padding:.65rem 1rem;border-radius:.65rem;background:var(--cream);color:var(--ink);border:1px solid var(--line-2);font-weight:800;font-size:.9rem;text-decoration:none;display:inline-flex;align-items:center;';
    var copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.textContent = '複製連結';
    copyBtn.addEventListener('click', function () {
      navigator.clipboard.writeText(url).then(
        function () { toast('已複製連結', 'ok'); },
        function () { toast('複製失敗，請手動選取', 'err'); }
      );
    });
    var printBtn = document.createElement('button');
    printBtn.type = 'button';
    printBtn.className = 'ghost';
    printBtn.textContent = '列印 QR';
    printBtn.style.background = 'var(--paper-2)';
    printBtn.addEventListener('click', function () { printQR(url, order, extras); });
    foot.appendChild(copyBtn);
    foot.appendChild(printBtn);
    foot.appendChild(openBtn);
    showModal({
      title: 'QR 點餐連結已建立',
      lead: '掃描或開啟下方連結即可顯示顧客端訂單資訊。',
      body: body,
      footer: foot,
    });
  }

  function printQR(url, order, extras, target) {
    extras = extras || {};
    var svg = root.QRCode.toSVG(url, { scale: 8, margin: 4, ecc: 'M' });
    var win = target || window.open('', '_blank', 'width=420,height=600');
    if (!win) { toast('瀏覽器封鎖列印視窗 — 請允許彈跳視窗以列印 QR', 'warn'); return; }
    var html = '<!doctype html><html><head><meta charset="utf-8"><title>QR 點餐</title>' +
      '<style>body{font-family:"Noto Serif TC",serif;text-align:center;padding:2rem;color:#0f1419}.qr svg{width:80mm;height:auto;margin:1rem auto}@media print{@page{size:80mm auto;margin:5mm}}</style>' +
      '</head><body>' +
      '<h2 style="margin:0 0 .3rem;font-weight:900">' + escapeHtml(extras.storeName || '') + '</h2>' +
      '<div style="font-size:.85rem;color:#5b6470">' + escapeHtml(order.orderId || order.id || '') + '</div>' +
      '<div class="qr">' + svg + '</div>' +
      '<div style="font-size:.78rem;color:#5b6470;word-break:break-all">' + escapeHtml(url) + '</div>' +
      '<p style="font-size:.78rem;color:#5b6470;margin-top:1.2rem">掃描可開啟訂單詳情</p>' +
      '</body></html>';
    try { win.document.open(); win.document.write(html); win.document.close(); } catch (e) { toast('QR 列印視窗無法寫入', 'err'); return; }
    var doPrint = function () { try { win.focus(); win.print(); } catch (e) {} };
    if (win.document.readyState === 'complete') setTimeout(doPrint, 200);
    else win.onload = function () { setTimeout(doPrint, 200); };
  }

  // ------------------------------------------------------------
  // Receipt print
  // ------------------------------------------------------------
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  function fmtMoney(n) { return Number(n || 0).toLocaleString('zh-TW'); }
  function fmtDate(d) { return (d instanceof Date ? d : new Date(d || Date.now())).toLocaleString('zh-TW'); }

  /**
   * printReceipt({ store, order, items, payment, invoice, qrUrl, footer })
   * Renders an 80mm-style receipt and triggers window.print() in a popup.
   */
  /**
   * Pre-open a placeholder print window inside a user gesture so popup blockers
   * do not eat it later. Caller hands the returned `Window` to `printReceipt`
   * (or `printQR`) via opts.target after the async fetch resolves.
   */
  function preparePrintWindow() {
    var win = window.open('', '_blank', 'width=420,height=720');
    if (!win) return null;
    try {
      win.document.open();
      win.document.write('<!doctype html><html><head><meta charset="utf-8"><title>準備列印…</title><style>body{font-family:system-ui,sans-serif;padding:2rem;text-align:center;color:#5b6470}.spin{display:inline-block;width:36px;height:36px;border:3px solid #efece1;border-top-color:#0f8a6a;border-radius:50%;animation:s 1s linear infinite;margin-bottom:1rem}@keyframes s{to{transform:rotate(360deg)}}</style></head><body><div class="spin"></div><div>正在準備收據…</div></body></html>');
      win.document.close();
    } catch (e) { /* cross-origin or closed */ }
    return win;
  }

  function printReceipt(opts) {
    opts = opts || {};
    var win = opts.target || window.open('', '_blank', 'width=420,height=720');
    if (!win) { toast('瀏覽器封鎖列印視窗 — 請允許彈跳視窗以列印收據', 'warn'); return; }
    var qrSvg = '';
    if (opts.qrUrl && root.QRCode) {
      qrSvg = root.QRCode.toSVG(opts.qrUrl, { scale: 5, margin: 2, ecc: 'M' });
    }
    var itemsRows = (opts.items || []).map(function (it) {
      var qty = it.qty || it.quantity || 1;
      var price = it.unitPrice != null ? it.unitPrice : (it.price || 0);
      var line = qty * price;
      return '<tr><td>' + escapeHtml(it.name || it.productName || it.skuId) + '</td>' +
        '<td style="text-align:center">x' + qty + '</td>' +
        '<td style="text-align:right">' + fmtMoney(line) + '</td></tr>';
    }).join('');
    var html = '<!doctype html><html><head><meta charset="utf-8"><title>收據</title>' +
      '<style>' +
      'body{font-family:"Noto Serif TC","Microsoft JhengHei",serif;color:#0f1419;margin:0;padding:6mm 5mm;width:80mm;font-size:11pt}' +
      'h1{font-size:14pt;text-align:center;margin:0 0 2mm}' +
      '.meta{text-align:center;font-size:9pt;color:#3a4250;margin-bottom:3mm}' +
      '.divider{border-top:1px dashed #0f1419;margin:3mm 0}' +
      'table{width:100%;border-collapse:collapse}' +
      'td{padding:.5mm 0;font-size:10pt;vertical-align:top}' +
      '.row{display:flex;justify-content:space-between;font-size:10pt;padding:.4mm 0}' +
      '.total{font-size:13pt;font-weight:900;margin-top:2mm;display:flex;justify-content:space-between;border-top:2px dashed #0f1419;padding-top:2mm}' +
      '.invoice{font-size:9pt;margin-top:2mm;color:#3a4250}' +
      '.qr{text-align:center;margin-top:4mm}' +
      '.qr svg{width:30mm;height:30mm}' +
      '.foot{text-align:center;font-size:9pt;color:#5b6470;margin-top:3mm}' +
      '@media print{@page{size:80mm auto;margin:4mm}body{margin:0}}' +
      '</style></head><body>' +
      '<h1>' + escapeHtml(opts.store && opts.store.name || '店家') + '</h1>' +
      '<div class="meta">' + escapeHtml(opts.store && opts.store.address || '') + '<br>' + escapeHtml(opts.store && opts.store.phone || '') + '</div>' +
      '<div class="row"><span>訂單</span><span>' + escapeHtml(opts.order && opts.order.orderNumber || opts.order && opts.order.id || '') + '</span></div>' +
      '<div class="row"><span>時間</span><span>' + fmtDate(opts.order && opts.order.createdAt) + '</span></div>' +
      '<div class="row"><span>收銀員</span><span>' + escapeHtml(opts.order && opts.order.cashier || '') + '</span></div>' +
      '<div class="divider"></div>' +
      '<table>' + itemsRows + '</table>' +
      '<div class="divider"></div>' +
      '<div class="row"><span>小計</span><span>NT$' + fmtMoney(opts.order && opts.order.subtotal) + '</span></div>' +
      (opts.order && opts.order.discountTotal ? '<div class="row"><span>折扣</span><span>-NT$' + fmtMoney(opts.order.discountTotal) + '</span></div>' : '') +
      '<div class="total"><span>應收</span><span>NT$' + fmtMoney(opts.order && opts.order.grandTotal) + '</span></div>' +
      (opts.payment ? '<div class="row" style="margin-top:2mm"><span>付款</span><span>' + escapeHtml(opts.payment.method) + ' NT$' + fmtMoney(opts.payment.amount) + '</span></div>' : '') +
      (opts.payment && opts.payment.change ? '<div class="row"><span>找零</span><span>NT$' + fmtMoney(opts.payment.change) + '</span></div>' : '') +
      (opts.invoice ? '<div class="invoice"><div class="divider"></div>' +
        '發票：' + escapeHtml(opts.invoice.invoiceNumber || '—') + '<br>' +
        '隨機碼：' + escapeHtml(opts.invoice.randomCode || '—') + '<br>' +
        (opts.invoice.carrier ? '載具：' + escapeHtml(opts.invoice.carrier) + '<br>' : '') +
        (opts.invoice.buyerTaxId ? '統一編號：' + escapeHtml(opts.invoice.buyerTaxId) + '<br>' : '') +
        '</div>' : '') +
      (qrSvg ? '<div class="qr">' + qrSvg + '<div style="font-size:8pt;color:#5b6470;margin-top:1mm">掃描查訂單</div></div>' : '') +
      '<div class="foot">謝謝光臨 · ' + escapeHtml(opts.footer || '店長 AI POS') + '</div>' +
      '</body></html>';
    try {
      win.document.open();
      win.document.write(html);
      win.document.close();
    } catch (e) { toast('收據視窗無法寫入：' + e.message, 'err'); return; }
    var doPrint = function () { try { win.focus(); win.print(); } catch (e) {} };
    if (win.document.readyState === 'complete') setTimeout(doPrint, 200);
    else win.onload = function () { setTimeout(doPrint, 200); };
  }

  // ------------------------------------------------------------
  // CSV download
  // ------------------------------------------------------------
  function downloadCSV(filename, rows) {
    if (!Array.isArray(rows) || rows.length === 0) {
      toast('沒有可匯出資料', 'warn');
      return;
    }
    function esc(v) {
      if (v == null) return '';
      var s = typeof v === 'object' ? JSON.stringify(v) : String(v);
      if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
      return s;
    }
    var headers = Object.keys(rows[0]);
    var lines = [headers.join(',')];
    for (var i = 0; i < rows.length; i++) {
      lines.push(headers.map(function (h) { return esc(rows[i][h]); }).join(','));
    }
    var bom = '﻿'; // UTF-8 BOM so Excel reads Chinese correctly
    var blob = new Blob([bom + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 0);
    toast('CSV 已下載：' + filename, 'ok');
  }

  // ------------------------------------------------------------
  // Webcam barcode / QR scanner using BarcodeDetector API
  // ------------------------------------------------------------
  function openScanner(onCode) {
    if (typeof BarcodeDetector === 'undefined') {
      var foot = document.createElement('div');
      var ack = document.createElement('button');
      ack.type = 'button';
      ack.className = 'ghost';
      ack.textContent = '了解';
      ack.addEventListener('click', closeModal);
      foot.appendChild(ack);
      showModal({
        title: '此瀏覽器不支援掃碼',
        lead: 'BarcodeDetector API 尚未支援。請改用 Chrome 88+ / Edge 88+，或使用 USB 掃碼槍直接輸入到搜尋框。',
        body: '<div class="scanner-result">不支援的環境：' + escapeHtml(navigator.userAgent) + '</div>',
        footer: foot,
      });
      return;
    }
    var body = document.createElement('div');
    body.className = 'scanner-wrap';
    body.innerHTML =
      '<div class="scanner-frame"><video id="scannerVideo" playsinline muted></video><canvas id="scannerCanvas"></canvas><div class="scanner-overlay"></div></div>' +
      '<div class="scanner-result" id="scannerResult">對準商品條碼或 QR — 自動辨識</div>';
    var foot = document.createElement('div');
    foot.innerHTML = '<button type="button" class="ghost" id="scannerCancel">取消</button>';
    var modal = showModal({ title: '掃碼商品', lead: '使用裝置相機掃描商品條碼或 QR 點餐。', body: body, footer: foot });

    var video = body.querySelector('#scannerVideo');
    var result = body.querySelector('#scannerResult');
    var cancel = modal.card.querySelector('#scannerCancel');
    var stream = null;
    var stopped = false;
    var detector;
    function stop() {
      stopped = true;
      if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
      stream = null;
      document.removeEventListener('keydown', onEsc);
    }
    function onEsc(e) { if (e.key === 'Escape') stop(); }
    cancel.addEventListener('click', function () { stop(); closeModal(); });
    document.addEventListener('keydown', onEsc);

    var desiredFormats = ['qr_code', 'ean_13', 'ean_8', 'code_128', 'code_39', 'upc_a', 'upc_e'];
    BarcodeDetector.getSupportedFormats().then(function (fmts) {
      var avail = (fmts && fmts.length) ? desiredFormats.filter(function (f) { return fmts.indexOf(f) >= 0; }) : null;
      try {
        detector = avail && avail.length ? new BarcodeDetector({ formats: avail }) : new BarcodeDetector();
      } catch (e) {
        detector = new BarcodeDetector();
      }
      return navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    }).then(function (s) {
      stream = s;
      video.srcObject = s;
      var playPromise = video.play();
      if (playPromise && playPromise.catch) {
        playPromise.catch(function (err) {
          result.textContent = '自動播放被瀏覽器阻擋：' + err.message;
        });
      }
      var tick = function () {
        if (stopped || !detector) return;
        if (video.readyState < 2) { requestAnimationFrame(tick); return; }
        detector.detect(video).then(function (codes) {
          if (codes && codes.length) {
            var code = codes[0].rawValue;
            result.textContent = '偵測到：' + code;
            stop();
            closeModal();
            onCode(code, codes[0].format);
          } else {
            requestAnimationFrame(tick);
          }
        }).catch(function () { requestAnimationFrame(tick); });
      };
      tick();
    }).catch(function (err) {
      result.textContent = '無法存取相機：' + (err && err.message || err);
      toast('無法啟用相機 — ' + (err && err.message || ''), 'err');
    });
  }

  // ------------------------------------------------------------
  // TW BAN (統一編號) algorithm validator
  // ------------------------------------------------------------
  // Ref: 統一編號檢核規則 — 8 位數，加權 [1,2,1,2,1,2,4,1]
  // 各位數乘以加權後逐位數字相加，總和能被 5 整除即合法。
  // 若第 7 碼為 7，總和加 7 可被 5 整除亦合法。
  function isValidTaxId(s) {
    if (!/^\d{8}$/.test(s)) return false;
    var w = [1, 2, 1, 2, 1, 2, 4, 1];
    var sum = 0;
    for (var i = 0; i < 8; i++) {
      var product = Number(s[i]) * w[i];
      sum += Math.floor(product / 10) + (product % 10);
    }
    if (sum % 5 === 0) return true;
    if (s[6] === '7' && (sum + 1) % 5 === 0) return true;
    return false;
  }

  // 手機條碼: /^\/[0-9A-Z\.\-\+]{7}$/
  function isValidMobileBarcode(s) {
    return /^\/[0-9A-Z.\-+]{7}$/.test(s);
  }
  // 自然人憑證: 2 大寫英文字母 + 14 數字
  function isValidCitizenDigitalCert(s) {
    return /^[A-Z]{2}\d{14}$/.test(s);
  }
  // 捐贈碼: 3-7 位數字
  function isValidDonationCode(s) {
    return /^\d{3,7}$/.test(s);
  }

  // ------------------------------------------------------------
  // Training mode
  // ------------------------------------------------------------
  var TRAINING_KEY = 'storeCaptain.trainingMode';
  function isTrainingMode() {
    try { return localStorage.getItem(TRAINING_KEY) === '1'; } catch (e) { return false; }
  }
  function setTrainingMode(on) {
    try { localStorage.setItem(TRAINING_KEY, on ? '1' : '0'); } catch (e) {}
    applyTrainingUI();
  }
  function applyTrainingUI() {
    var on = isTrainingMode();
    document.body.classList.toggle('training-mode', on);
    var ribbon = document.getElementById('trainingRibbon');
    if (on && !ribbon) {
      ribbon = document.createElement('div');
      ribbon.id = 'trainingRibbon';
      ribbon.className = 'training-ribbon';
      ribbon.textContent = '訓練模式啟用中 — 訂單不會送出至雲端，不會開立發票';
      document.body.appendChild(ribbon);
    } else if (!on && ribbon) {
      ribbon.parentNode.removeChild(ribbon);
    }
  }

  // ------------------------------------------------------------
  // Network status
  // ------------------------------------------------------------
  function netStatus() {
    var pill = document.getElementById('netStatus');
    if (!pill) return;
    if (!navigator.onLine) {
      pill.setAttribute('data-state', 'offline');
      pill.textContent = '離線中';
    } else {
      pill.setAttribute('data-state', 'online');
      pill.textContent = '已連線';
    }
  }
  function setNetQueued(n) {
    var pill = document.getElementById('netStatus');
    if (!pill) return;
    pill.setAttribute('data-state', n > 0 ? 'queued' : (navigator.onLine ? 'online' : 'offline'));
    pill.textContent = n > 0 ? ('待補傳 ' + n) : (navigator.onLine ? '已連線' : '離線中');
  }
  window.addEventListener('online', function () { netStatus(); toast('已重新連線', 'ok'); });
  window.addEventListener('offline', function () { netStatus(); toast('已離線 — 操作會排入補傳佇列', 'warn'); });

  // ------------------------------------------------------------
  // Bootstrap UI elements that other code needs (ribbon / pill)
  // ------------------------------------------------------------
  function bootstrap() {
    applyTrainingUI();
    netStatus();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }

  root.PosExtras = {
    showModal: showModal,
    closeModal: closeModal,
    toast: toast,
    showQR: showQR,
    printQR: printQR,
    printReceipt: printReceipt,
    preparePrintWindow: preparePrintWindow,
    downloadCSV: downloadCSV,
    openScanner: openScanner,
    isValidTaxId: isValidTaxId,
    isValidMobileBarcode: isValidMobileBarcode,
    isValidCitizenDigitalCert: isValidCitizenDigitalCert,
    isValidDonationCode: isValidDonationCode,
    isTrainingMode: isTrainingMode,
    setTrainingMode: setTrainingMode,
    setNetQueued: setNetQueued,
    netStatus: netStatus,
  };
})(typeof window !== 'undefined' ? window : globalThis);
