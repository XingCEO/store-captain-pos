(function () {
  'use strict';

  function readParamsFrom(raw) {
    var out = {};
    if (!raw) return out;
    raw.replace(/^[?#]/, '').split('&').forEach(function (pair) {
      var idx = pair.indexOf('=');
      if (idx < 0) return;
      // A corrupted QR scan can yield malformed %-sequences; decodeURIComponent
      // throws URIError on those. Skip the bad pair instead of crashing init().
      try {
        out[decodeURIComponent(pair.slice(0, idx))] = decodeURIComponent(pair.slice(idx + 1));
      } catch (e) { /* skip malformed pair */ }
    });
    return out;
  }

  function readParams() {
    return Object.assign({}, readParamsFrom(location.hash), readParamsFrom(location.search));
  }

  function fmt(num) {
    return Number(num || 0).toLocaleString('zh-TW');
  }

  function set(id, value) {
    var el = document.getElementById(id);
    if (el) el.textContent = value == null || value === '' ? '—' : value;
  }

  function setOrder(data) {
    set('orderId', data.orderNumber || data.orderId);
    set('orderSource', String(data.source || 'QR').toUpperCase());
    set('orderStore', data.storeName || data.storeId);
    set('storeName', data.storeName || '店家');
    set('orderTotal', fmt(data.grandTotal));
    var t = data.createdAt ? new Date(data.createdAt) : new Date();
    set('orderTime', isNaN(t.getTime()) ? '—' : t.toLocaleString('zh-TW'));
    set('orderTitle', data.state === 'CANCELLED' || data.state === 'VOIDED' ? '訂單已取消' : '訂單已建立');
    set('orderLead', '店家已收到您的訂單，正在準備中。請於到店時出示此頁面或單號。');
  }

  function setInvalid(message) {
    set('orderTitle', '請從有效 QR 連結進入');
    set('orderLead', message || '此頁面需要由店家 POS 產生的 QR / LINE 點餐連結進入。');
    set('orderId', '—');
    set('orderSource', 'QR');
    set('orderStore', '—');
    set('orderTime', '—');
    set('orderTotal', '0');
  }

  function setLegacy(params) {
    if (!params.id) {
      setInvalid();
      return;
    }
    setOrder({
      orderId: params.id,
      source: params.source || 'QR',
      storeId: params.store,
      storeName: params.storeName,
      grandTotal: params.total,
      createdAt: params.t ? new Date(Number(params.t)).toISOString() : new Date().toISOString(),
    });
    set('orderLead', '此為舊版未簽章連結，金額僅供參考。請以店家收銀台確認為準。');
  }

  async function lookup(token) {
    set('orderTitle', '正在查詢訂單');
    set('orderLead', '正在向店家系統確認訂單資訊。');
    var res = await fetch('/api/v1/channels/orders/lookup?token=' + encodeURIComponent(token), { cache: 'no-store' });
    var body = await res.json().catch(function () { return null; });
    if (!res.ok) {
      setInvalid(body && body.message ? body.message : '訂單連結無效或已過期。請洽店家重新產生 QR。');
      return;
    }
    setOrder(body);
  }

  function init() {
    var params = readParams();
    var print = document.getElementById('printOrder');
    if (print) print.addEventListener('click', function () { window.print(); });
    var token = params.token || params.t;
    if (token && token.indexOf('.') > 0) {
      lookup(token).catch(function () {
        setInvalid('暫時無法查詢訂單。請確認網路連線，或洽店家協助。');
      });
      return;
    }
    setLegacy(params);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
