const crypto = require('crypto');
const { orderItems, paidOrders, paymentsFor, ensureInvoice } = require('./commerce');
const { inventoryRows } = require('./operations');
const { roleRank } = require('../core/runtime');

function dayRange(date) {
  return { from: `${date}T00:00:00.000Z`, to: `${date}T23:59:59.999Z` };
}

function invoiceRows(runtime, ctx, storeId = null) {
  return [...runtime.store.data.invoices.values()].filter((invoice) => invoice.tenantId === ctx.tenantId).filter((invoice) => !storeId || invoice.storeId === storeId);
}

function reconciliationMismatchReason(orderSubtotal, paymentSum, invoiceSum) {
  if (paymentSum === 0 && invoiceSum > 0) return 'PAYMENT_MISSING';
  if (invoiceSum === 0 && paymentSum > 0) return 'INVOICE_MISSING';
  return 'AMOUNT_DRIFT';
}

function reconcileForStores(runtime, ctx, storeIds, date) {
  const INCLUDED_STATES = new Set(['PAID_CASH', 'PAID_CARD', 'PAID_PENDING', 'VOIDED']);
  const orders = [...runtime.store.data.orders.values()].filter((order) =>
    order.tenantId === ctx.tenantId &&
    storeIds.includes(order.storeId) &&
    order.businessDate === date &&
    INCLUDED_STATES.has(order.state)
  );

  let orderTotal = 0;
  let paymentTotal = 0;
  let invoiceTotal = 0;
  const mismatches = [];
  const voidedOrders = [];

  for (const order of orders) {
    const isVoided = order.state === 'VOIDED';
    if (isVoided) {
      voidedOrders.push(order.id);
    }

    const orderSubtotal = isVoided ? 0 : (order.grandTotal || 0);

    const paymentSum = paymentsFor(runtime, order.id)
      .filter((p) => p.status === 'CAPTURED')
      .reduce((sum, p) => sum + Number(p.amount || 0), 0);

    const invoiceSum = [...runtime.store.data.invoices.values()]
      .filter((inv) => inv.orderId === order.id && inv.lifecycleState !== 'VOIDED' && inv.lifecycleState !== 'VOIDED_SANDBOX')
      .reduce((sum, inv) => sum + Number(inv.amount || 0), 0);

    orderTotal += orderSubtotal;
    paymentTotal += paymentSum;
    invoiceTotal += invoiceSum;

    if (!isVoided && (orderSubtotal !== paymentSum || paymentSum !== invoiceSum)) {
      const maxVal = Math.max(orderSubtotal, paymentSum, invoiceSum);
      const minVal = Math.min(orderSubtotal, paymentSum, invoiceSum);
      mismatches.push({
        order_id: order.id,
        order_subtotal: orderSubtotal,
        payment_sum: paymentSum,
        invoice_sum: invoiceSum,
        delta: maxVal - minVal,
        reason: reconciliationMismatchReason(orderSubtotal, paymentSum, invoiceSum),
      });
    }
  }

  return {
    orderTotal,
    paymentTotal,
    invoiceTotal,
    mismatches,
    voidedOrders,
    voidedCount: voidedOrders.length,
    mismatchCount: mismatches.length,
    consistent: orderTotal === paymentTotal && paymentTotal === invoiceTotal && mismatches.length === 0,
  };
}

function terminalState(snapshot) {
  if (!snapshot) return 'UNREACHABLE';
  const age = (Date.now() - new Date(snapshot.receivedAt).getTime()) / 1000;
  if (age > 300) return 'UNREACHABLE';
  if (snapshot.deviceStatus === 'CRITICAL' || snapshot.printErrorCount > 10 || snapshot.syncLagSeconds > 300) return 'CRITICAL';
  if (snapshot.deviceStatus === 'DEGRADED' || snapshot.printErrorCount > 4 || snapshot.syncLagSeconds > 120) return 'DEGRADED';
  return 'OK';
}

function register(router, runtime) {
  const { store } = runtime;

  router.add('GET', '/api/v1/invoices/health', async ({ res, ctx, url }) => {
    if (!runtime.requireTenant(res, ctx) || !runtime.requireRole(res, ctx, 'MANAGER')) return;
    const storeId = url.searchParams.get('storeId') || ctx.storeId;
    if (!runtime.requireStoreScope(res, ctx, storeId)) return;
    const invoices = invoiceRows(runtime, ctx, storeId);
    const exceptions = invoices.filter((invoice) => invoice.uploadState !== 'UPLOADED');
    res.setHeader('x-environment', 'sandbox');
    runtime.json(res, 200, { environment: 'sandbox', mode: 'SANDBOX_UNTIL_GO_GATE', warning: '正式電子發票需完成會計師、加值中心、sandbox、字軌與補傳 gate。', totals: { invoices: invoices.length, pendingUpload: invoices.filter((invoice) => invoice.uploadState === 'PENDING_UPLOAD').length, uploaded: invoices.filter((invoice) => invoice.uploadState === 'UPLOADED').length, exceptions: exceptions.length }, exceptions: exceptions.map((invoice) => ({ invoiceId: invoice.id, orderId: invoice.orderId, invoiceNumber: invoice.invoiceNumber, uploadState: invoice.uploadState, lifecycleState: invoice.lifecycleState, lastErrorCode: invoice.lastErrorCode })) });
  });

  router.add('POST', '/api/v1/invoices/issue-sandbox', async ({ req, res, ctx }) => {
    if (!runtime.requireTenant(res, ctx) || !runtime.requireRole(res, ctx, 'MANAGER')) return;
    const body = await runtime.parseBody(req);
    const order = store.data.orders.get(body.orderId);
    if (!order || order.tenantId !== ctx.tenantId || order.paymentState !== 'PAID') { runtime.json(res, 404, runtime.error('INVOICE_ORDER_NOT_READY', 'paid order not found')); return; }
    if (!runtime.requireStoreScope(res, ctx, order.storeId)) return;
    res.setHeader('x-environment', 'sandbox');
    runtime.json(res, 200, { ...ensureInvoice(runtime, ctx, order), environment: 'sandbox', warning: 'SANDBOX_ONLY_DO_NOT_TRUST_FOR_REAL_TAX' });
  });

  router.add('POST', /^\/api\/v1\/invoices\/([\w-]+)\/mark-uploaded$/, async ({ res, ctx, params }) => {
    if (!runtime.requireTenant(res, ctx) || !runtime.requireRole(res, ctx, 'MANAGER')) return;
    const invoice = store.data.invoices.get(params[0]);
    if (!invoice || invoice.tenantId !== ctx.tenantId) { runtime.json(res, 404, runtime.error('INVOICE_NOT_FOUND', 'invoice not found')); return; }
    if (!runtime.requireStoreScope(res, ctx, invoice.storeId)) return;
    const next = { ...invoice, uploadState: 'UPLOADED', lifecycleState: 'ISSUED_UPLOADED_SANDBOX', lastErrorCode: null, updatedAt: runtime.nowIso() };
    store.data.invoices.set(invoice.id, next);
    runtime.addAudit(ctx, 'invoices.mark_uploaded_sandbox', 'INVOICE', invoice.id, invoice, next);
    res.setHeader('x-environment', 'sandbox');
    runtime.json(res, 200, { ...next, environment: 'sandbox' });
  });

  router.add('POST', /^\/api\/v1\/invoices\/([\w-]+)\/void-sandbox$/, async ({ req, res, ctx, params }) => {
    if (!runtime.requireTenant(res, ctx) || !runtime.requireRole(res, ctx, 'MANAGER')) return;
    const invoice = store.data.invoices.get(params[0]);
    if (!invoice || invoice.tenantId !== ctx.tenantId) { runtime.json(res, 404, runtime.error('INVOICE_NOT_FOUND', 'invoice not found')); return; }
    if (!runtime.requireStoreScope(res, ctx, invoice.storeId)) return;
    const body = await runtime.parseBody(req);
    if (!['ORDER_VOID', 'INPUT_ERROR', 'CUSTOMER_RETURN'].includes(body.reasonCode)) { runtime.json(res, 400, runtime.error('INVOICE_VOID_INVALID', 'reasonCode invalid')); return; }
    const id = store.nextId('invoiceVoid');
    const record = { id, tenantId: ctx.tenantId, invoiceId: invoice.id, orderId: invoice.orderId, state: 'VOID_CREATED_SANDBOX', reasonCode: body.reasonCode, createdBy: ctx.userId, createdAt: runtime.nowIso() };
    store.data.invoiceVoids.set(id, record);
    const next = { ...invoice, lifecycleState: 'VOIDED_SANDBOX', uploadState: 'VOID_PENDING_UPLOAD', updatedAt: runtime.nowIso() };
    store.data.invoices.set(invoice.id, next);
    runtime.addAudit(ctx, 'invoices.void_sandbox', 'INVOICE', invoice.id, invoice, next);
    res.setHeader('x-environment', 'sandbox');
    runtime.json(res, 200, { invoice: { ...next, environment: 'sandbox', warning: 'SANDBOX_ONLY_DO_NOT_TRUST_FOR_REAL_TAX' }, void: record, environment: 'sandbox', warning: 'SANDBOX_ONLY_DO_NOT_TRUST_FOR_REAL_TAX' });
  });

  router.add('GET', '/api/v1/reconciliation/daily', async ({ res, ctx, url }) => {
    if (!runtime.requireTenant(res, ctx)) return;
    if ((roleRank[ctx.role] || 0) < roleRank['MANAGER']) {
      runtime.json(res, 403, runtime.error('PERMISSION_DENIED', 'MANAGER or above required'));
      return;
    }

    const dateParam = url.searchParams.get('date');
    if (!dateParam || !/^\d{4}-\d{2}-\d{2}$/.test(dateParam) || Number.isNaN(new Date(`${dateParam}T00:00:00.000Z`).getTime())) {
      runtime.json(res, 400, runtime.error('DATE_RANGE_INVALID', 'date param required in YYYY-MM-DD format'));
      return;
    }
    const date = dateParam;

    const storeIdParam = url.searchParams.get('storeId') || ctx.storeIds[0] || ctx.storeId;

    let targetStoreIds;
    if (storeIdParam === 'all') {
      targetStoreIds = ctx.storeIds.length > 0 ? ctx.storeIds : (ctx.storeId ? [ctx.storeId] : []);
    } else {
      if (!runtime.requireStoreScope(res, ctx, storeIdParam)) {
        runtime.json(res, 403, runtime.error('RECONCILIATION_STORE_SCOPE_VIOLATION', 'storeId outside tenant scope'));
        return;
      }
      targetStoreIds = [storeIdParam];
    }

    const result = reconcileForStores(runtime, ctx, targetStoreIds, date);
    const { orderTotal, paymentTotal, invoiceTotal, mismatches, voidedOrders, voidedCount, mismatchCount, consistent } = result;

    runtime.addAudit(ctx, 'RECONCILIATION_VIEWED', 'reconciliation', `${date}:${storeIdParam}`, null, { mismatchCount, consistent });

    runtime.json(res, 200, {
      date,
      store_id: storeIdParam,
      totals: {
        order_total: orderTotal,
        payment_total: paymentTotal,
        invoice_total: invoiceTotal,
        mismatch_count: mismatchCount,
        voided_count: voidedCount,
      },
      consistent,
      mismatches,
      voided_orders: voidedOrders,
    });
  });

  router.add('GET', '/api/v1/reports/daily', async ({ res, ctx, url }) => {
    if (!runtime.requireTenant(res, ctx) || !runtime.requireRole(res, ctx, 'MANAGER')) return;
    const date = url.searchParams.get('date');
    const storeId = url.searchParams.get('storeId');
    if (!date || Number.isNaN(new Date(`${date}T00:00:00.000Z`).getTime())) { runtime.json(res, 400, runtime.error('DATE_RANGE_INVALID', 'date required')); return; }
    if (!runtime.requireStoreScope(res, ctx, storeId)) return;
    const range = dayRange(date);
    const orders = paidOrders(runtime, ctx, storeId, range.from, range.to);
    const paymentMap = new Map();
    for (const order of orders) for (const payment of paymentsFor(runtime, order.id)) {
      const row = paymentMap.get(payment.method) || { method: payment.method, count: 0, amount: 0 };
      row.count += 1;
      row.amount += payment.amount;
      paymentMap.set(payment.method, row);
    }
    runtime.addAudit(ctx, 'reports.daily.read', 'REPORT', date, null, { storeId });
    runtime.json(res, 200, { date, storeId: storeId || null, totals: { revenue: orders.reduce((sum, order) => sum + (order.grandTotal || 0), 0), orderCount: orders.length, lineItemCount: orders.reduce((sum, order) => sum + orderItems(runtime, order.id).reduce((lineSum, item) => lineSum + item.qty, 0), 0) }, payments: [...paymentMap.values()], exceptions: { syncLagOrderCount: [...store.data.outboxJobs.values()].filter((job) => job.tenantId === ctx.tenantId && job.state !== 'DONE').length, printFailCount: [...store.data.printJobs.values()].filter((job) => job.tenantId === ctx.tenantId && job.state === 'FAILED').length } });
  });

  router.add('GET', '/api/v1/reports/payment-breakdown', async ({ res, ctx, url }) => {
    if (!runtime.requireTenant(res, ctx) || !runtime.requireRole(res, ctx, 'MANAGER')) return;
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    const storeId = url.searchParams.get('storeId');
    if (!from || !to || new Date(from) > new Date(to)) { runtime.json(res, 400, runtime.error('DATE_RANGE_INVALID', 'from/to invalid')); return; }
    if (!runtime.requireStoreScope(res, ctx, storeId)) return;
    const rowsByKey = new Map();
    for (const order of paidOrders(runtime, ctx, storeId, from, to)) for (const payment of paymentsFor(runtime, order.id)) {
      const date = payment.createdAt.slice(0, 10);
      const key = `${date}:${payment.method}`;
      const row = rowsByKey.get(key) || { date, method: payment.method, orderAmount: 0, orderCount: 0 };
      row.orderAmount += payment.amount;
      row.orderCount += 1;
      rowsByKey.set(key, row);
    }
    const rows = [...rowsByKey.values()];
    runtime.json(res, 200, { rows, total: { amount: rows.reduce((sum, row) => sum + row.orderAmount, 0), transactions: rows.reduce((sum, row) => sum + row.orderCount, 0) } });
  });

  router.add('GET', '/api/v1/reports/top-products', async ({ res, ctx, url }) => {
    if (!runtime.requireTenant(res, ctx) || !runtime.requireRole(res, ctx, 'MANAGER')) return;
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    const storeId = url.searchParams.get('storeId');
    const limit = Number(url.searchParams.get('limit') || 10);
    if (!from || !to || !Number.isInteger(limit) || limit < 1 || limit > 50) { runtime.json(res, 400, runtime.error('DATE_RANGE_INVALID', 'from/to/limit invalid')); return; }
    if (!runtime.requireStoreScope(res, ctx, storeId)) return;
    const bySku = new Map();
    for (const order of paidOrders(runtime, ctx, storeId, from, to)) for (const item of orderItems(runtime, order.id)) {
      const row = bySku.get(item.skuId) || { productId: item.productId, skuId: item.skuId, name: item.name, soldQty: 0, grossAmount: 0, netAmount: 0 };
      row.soldQty += item.qty;
      row.grossAmount += item.unitPrice * item.qty;
      row.netAmount += item.subtotal;
      bySku.set(item.skuId, row);
    }
    runtime.json(res, 200, { items: [...bySku.values()].sort((a, b) => b.netAmount - a.netAmount).slice(0, limit) });
  });

  router.add('POST', '/api/v1/reports/exports', async ({ req, res, ctx }) => {
    if (!runtime.requireTenant(res, ctx) || !runtime.requireRole(res, ctx, 'MANAGER')) return;
    const body = await runtime.parseBody(req);

    if (!body.reportType || !body.from || !body.to || !['daily', 'weekly', 'monthly'].includes(body.reportType)) {
      runtime.json(res, 400, runtime.error('EXPORT_RANGE_INVALID', 'reportType/from/to required'));
      return;
    }

    const fromMs = new Date(body.from).getTime();
    const toMs = new Date(body.to).getTime();
    if (Number.isNaN(fromMs) || Number.isNaN(toMs) || toMs < fromMs) {
      runtime.json(res, 400, runtime.error('DATE_RANGE_INVALID', 'from/to invalid'));
      return;
    }
    const daysDiff = (toMs - fromMs) / (24 * 60 * 60 * 1000);
    if (daysDiff > 92) {
      runtime.json(res, 400, runtime.error('EXPORT_RANGE_TOO_LARGE', 'date range must not exceed 92 days'));
      return;
    }

    const storeIds = Array.isArray(body.storeIds) && body.storeIds.length > 0 ? body.storeIds : [];
    if (storeIds.length === 0) {
      runtime.json(res, 400, runtime.error('EXPORT_RANGE_INVALID', 'storeIds required'));
      return;
    }
    for (const sid of storeIds) {
      if (!runtime.requireStoreScope(res, ctx, sid)) return;
    }

    const fromIso = new Date(body.from).toISOString();
    const toIso = new Date(body.to).toISOString();

    // Compute real row count from orders in range × storeIds
    const rowsArray = [...store.data.orders.values()].filter((order) =>
      order.tenantId === ctx.tenantId &&
      order.paymentState === 'PAID' &&
      storeIds.includes(order.storeId) &&
      order.createdAt >= fromIso &&
      order.createdAt <= toIso
    );
    const rowCount = rowsArray.length;

    const exportId = store.nextId('export');
    const token = Math.random().toString(36).slice(2);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const checksum = 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(rowsArray)).digest('hex');

    const exportWarning = rowCount === 0 ? 'EMPTY_REPORT' : undefined;

    const record = {
      id: exportId,
      tenantId: ctx.tenantId,
      reportType: body.reportType,
      from: fromIso,
      to: toIso,
      storeIds,
      format: body.format || 'JSON',
      state: 'READY',
      rows: rowCount,
      checksum,
      token,
      createdBy: ctx.userId,
      createdAt: runtime.nowIso(),
      expiresAt,
    };
    store.data.reportExports.set(exportId, record);
    runtime.addAudit(ctx, 'EXPORT_CREATED', 'REPORT_EXPORT', exportId, null, { actor: ctx.userId, tenantId: ctx.tenantId, storeIds, row_count: rowCount });

    const payload = { export_id: exportId, state: 'READY', rows: rowCount, checksum, expires_at: expiresAt };
    if (exportWarning) payload.warning = exportWarning;
    runtime.json(res, 200, payload);
  });

  router.add('GET', /^\/api\/v1\/reports\/exports\/([\w-]+)$/, async ({ res, ctx, params }) => {
    if (!runtime.requireTenant(res, ctx) || !runtime.requireRole(res, ctx, 'MANAGER')) return;
    const record = store.data.reportExports.get(params[0]);
    if (!record || record.tenantId !== ctx.tenantId) { runtime.json(res, 404, runtime.error('TENANT_NOT_AUTHORIZED', 'report not found')); return; }
    for (const sid of (record.storeIds || [])) {
      if (!runtime.requireStoreScope(res, ctx, sid)) return;
    }
    runtime.json(res, 200, { id: record.id || params[0], report_type: record.reportType, state: record.state, rows: record.rows, checksum: record.checksum, expires_at: record.expiresAt, download_url: `/api/v1/reports/exports/${params[0]}/download?token=${record.token}` });
  });

  router.add('GET', /^\/api\/v1\/reports\/exports\/([\w-]+)\/download$/, async ({ res, ctx, params, url }) => {
    if (!runtime.requireTenant(res, ctx)) return;
    const record = store.data.reportExports.get(params[0]);
    if (!record || record.tenantId !== ctx.tenantId || url.searchParams.get('token') !== record.token) {
      runtime.json(res, 403, runtime.error('TENANT_NOT_AUTHORIZED', 'download token invalid'));
      return;
    }
    if (new Date(record.expiresAt).getTime() < Date.now()) {
      runtime.json(res, 410, runtime.error('FILE_EXPIRED', 'export has expired'));
      return;
    }
    // Re-derive rows array for streaming
    const rowsArray = [...store.data.orders.values()].filter((order) =>
      order.tenantId === ctx.tenantId &&
      order.paymentState === 'PAID' &&
      (record.storeIds || []).includes(order.storeId) &&
      order.createdAt >= record.from &&
      order.createdAt <= record.to
    );
    const body = JSON.stringify(rowsArray);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${params[0]}.json"`,
      'x-content-checksum': record.checksum,
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
    runtime.addAudit(ctx, 'EXPORT_DOWNLOADED', 'REPORT_EXPORT', params[0], null, { actor: ctx.userId, tenantId: ctx.tenantId, storeIds: record.storeIds, row_count: record.rows });
  });

  const VALID_PRINT_JOB_STATES = new Set(['FAILED', 'RETRYING', 'DEAD_LETTER', 'QUEUED', 'SENT', 'ACKED']);

  router.add('GET', '/api/v1/print-jobs', async ({ res, ctx, url }) => {
    if (!runtime.requireTenant(res, ctx)) return;
    const storeId = url.searchParams.get('storeId');
    const state = url.searchParams.get('state');
    if (state && !VALID_PRINT_JOB_STATES.has(state)) { runtime.json(res, 400, runtime.error('PRINT_JOB_STATE_INVALID', 'state must be one of FAILED|RETRYING|DEAD_LETTER|QUEUED|SENT|ACKED')); return; }
    if (!runtime.requireStoreScope(res, ctx, storeId)) return;
    const items = [...store.data.printJobs.values()]
      .filter((job) => job.tenantId === ctx.tenantId)
      .filter((job) => !storeId || job.storeId === storeId)
      .filter((job) => !state || job.state === state)
      .slice(0, 200)
      .map((job) => ({ id: job.id, orderId: job.orderId, documentType: job.documentType, state: job.state, attempts: job.attempts || 0, lastErrorCode: job.lastErrorCode, lastTriedAt: job.lastTriedAt || null, nextRetryAt: job.nextRetryAt || null }));
    runtime.json(res, 200, { items, nextCursor: null });
  });

  router.add('POST', /^\/api\/v1\/print-jobs\/([\w-]+)\/retry$/, async ({ req, res, ctx, params }) => {
    if (!runtime.requireTenant(res, ctx) || !runtime.requireRole(res, ctx, 'MANAGER')) return;
    const job = store.data.printJobs.get(params[0]);
    if (!job || job.tenantId !== ctx.tenantId) { runtime.json(res, 404, runtime.error('PRINTER_OFFLINE', 'print job not found')); return; }
    if (!runtime.requireStoreScope(res, ctx, job.storeId)) return;
    const body = await runtime.parseBody(req);
    const requestedBy = body.requestedBy || ctx.userId;

    // Idempotency: same requestedBy within 5 s returns cached response
    if (job.lastRetryRequestedBy === requestedBy && job.lastRetryRequestedAt && (Date.now() - new Date(job.lastRetryRequestedAt).getTime()) < 5_000) {
      runtime.json(res, 200, { printJobId: job.id, state: job.state, retryCount: job.attempts || 0, nextRetryAt: job.nextRetryAt || null, cached: true });
      return;
    }

    const attempts = job.attempts || 0;

    // Dead-letter after 6 attempts
    if (attempts >= 6) {
      const deadNext = { ...job, state: 'DEAD_LETTER', lastRetryRequestedBy: requestedBy, lastRetryRequestedAt: runtime.nowIso(), updatedAt: runtime.nowIso() };
      store.data.printJobs.set(job.id, deadNext);
      runtime.addAudit(ctx, 'PRINT_JOB_RETRY', 'PRINT_JOB', job.id, { attempts, state: job.state }, { attempts, state: 'DEAD_LETTER' });
      runtime.json(res, 409, runtime.error('RETRY_LIMIT_EXCEEDED', 'print job exceeded maximum retry attempts'));
      return;
    }

    if (!['NETWORK_RECOVERY', 'MANUAL_REPRINT', 'PRINT_TEMPLATE_UPDATE'].includes(body.reason) || job.state !== 'FAILED') {
      runtime.json(res, 409, runtime.error('PRINT_JOB_NOT_RETRYABLE', 'only failed print jobs can be retried'));
      return;
    }

    const nowMs = Date.now();
    const nowIsoStr = runtime.nowIso();
    const newAttempts = attempts + 1;
    const nextRetryAt = new Date(nowMs + Math.min(60_000 * Math.pow(2, attempts), 30 * 60_000)).toISOString();

    const next = {
      ...job,
      state: 'RETRYING',
      attempts: newAttempts,
      lastErrorCode: null,
      lastTriedAt: nowIsoStr,
      nextRetryAt,
      lastRetryRequestedBy: requestedBy,
      lastRetryRequestedAt: nowIsoStr,
      updatedAt: nowIsoStr,
      requestedBy,
    };
    store.data.printJobs.set(job.id, next);
    runtime.addAudit(ctx, 'PRINT_JOB_RETRY', 'PRINT_JOB', job.id, { attempts, state: job.state }, { attempts: newAttempts, state: 'RETRYING' });
    runtime.json(res, 200, { printJobId: job.id, state: next.state, retryCount: next.attempts, nextRetryAt });
  });

  router.add('POST', '/api/v1/customers', async ({ req, res, ctx }) => {
    if (!runtime.requireTenant(res, ctx) || !runtime.requireRole(res, ctx, 'CASHIER')) return;
    const body = await runtime.parseBody(req);
    const phone = String(body.phone || '').trim();
    if (!/^09\d{8}$/.test(phone)) { runtime.json(res, 400, runtime.error('CUSTOMER_PHONE_INVALID', 'Taiwan mobile phone required')); return; }
    const existing = [...store.data.customers.values()].find((customer) => customer.tenantId === ctx.tenantId && customer.phone === phone);
    if (existing) { runtime.json(res, 200, { ...existing, duplicated: true }); return; }
    const id = store.nextId('customer');
    const customer = { id, tenantId: ctx.tenantId, phone, name: String(body.name || '未命名會員'), lineBound: Boolean(body.lineBound), points: 0, tags: Array.isArray(body.tags) ? body.tags.map(String) : [], status: 'ACTIVE', createdAt: runtime.nowIso(), updatedAt: runtime.nowIso() };
    store.data.customers.set(id, customer);
    runtime.addAudit(ctx, 'customers.create', 'CUSTOMER', id, null, { phone, lineBound: customer.lineBound });
    runtime.json(res, 200, customer);
  });

  router.add('GET', '/api/v1/customers/search', async ({ res, ctx, url }) => {
    if (!runtime.requireTenant(res, ctx) || !runtime.requireRole(res, ctx, 'CASHIER')) return;
    const phone = (url.searchParams.get('phone') || '').trim();
    runtime.json(res, 200, { items: [...store.data.customers.values()].filter((customer) => customer.tenantId === ctx.tenantId && (!phone || customer.phone.includes(phone))) });
  });

  router.add('GET', '/api/v1/coupons', async ({ res, ctx }) => {
    if (!runtime.requireTenant(res, ctx) || !runtime.requireRole(res, ctx, 'CASHIER')) return;
    runtime.json(res, 200, { items: [...store.data.coupons.values()].filter((coupon) => coupon.tenantId === ctx.tenantId && coupon.status === 'ACTIVE') });
  });

  router.add('POST', '/api/v1/coupons/redeem', async ({ req, res, ctx }) => {
    if (!runtime.requireTenant(res, ctx) || !runtime.requireRole(res, ctx, 'CASHIER')) return;
    const body = await runtime.parseBody(req);
    const coupon = [...store.data.coupons.values()].find((item) => item.tenantId === ctx.tenantId && item.code === body.code && item.status === 'ACTIVE');
    const order = store.data.orders.get(body.orderId);
    if (!coupon || !order || order.tenantId !== ctx.tenantId || order.paymentState === 'PAID') { runtime.json(res, 400, runtime.error('COUPON_NOT_APPLICABLE', 'coupon or order invalid')); return; }
    if (!runtime.requireStoreScope(res, ctx, order.storeId)) return;
    if ((order.grandTotal || 0) < coupon.minSpend) { runtime.json(res, 409, runtime.error('COUPON_NOT_APPLICABLE', 'minimum spend not reached')); return; }
    const amount = Math.min(coupon.amount, order.grandTotal || 0);
    const redemptionId = store.nextId('redemption');
    const nextOrder = { ...order, discountTotal: (order.discountTotal || 0) + amount, grandTotal: Math.max(0, (order.grandTotal || 0) - amount), couponCode: coupon.code, updatedAt: runtime.nowIso() };
    const nextCoupon = { ...coupon, usedCount: (coupon.usedCount || 0) + 1, updatedAt: runtime.nowIso() };
    store.data.orders.set(order.id, nextOrder);
    store.data.coupons.set(coupon.id, nextCoupon);
    store.data.couponRedemptions.set(redemptionId, { id: redemptionId, tenantId: ctx.tenantId, couponId: coupon.id, orderId: order.id, amount, createdBy: ctx.userId, createdAt: runtime.nowIso() });
    runtime.addAudit(ctx, 'coupons.redeem', 'COUPON_REDEMPTION', redemptionId, null, { orderId: order.id, amount });
    runtime.json(res, 200, { redemptionId, amount, order: nextOrder });
  });

  router.add('POST', '/api/v1/customers/points/adjust', async ({ req, res, ctx }) => {
    if (!runtime.requireTenant(res, ctx) || !runtime.requireRole(res, ctx, 'MANAGER')) return;
    const body = await runtime.parseBody(req);
    const customer = store.data.customers.get(body.customerId);
    const points = Number(body.points);
    if (!customer || customer.tenantId !== ctx.tenantId || !Number.isInteger(points) || points === 0 || !['EARN', 'REDEEM', 'ADJUST'].includes(body.reasonCode)) { runtime.json(res, 400, runtime.error('POINTS_INVALID', 'customerId, integer points, reasonCode required')); return; }
    const id = store.nextId('point');
    const nextPoints = Math.max(0, Number(customer.points || 0) + points);
    const nextCustomer = { ...customer, points: nextPoints, updatedAt: runtime.nowIso() };
    store.data.customers.set(customer.id, nextCustomer);
    store.data.customerPoints.set(id, { id, tenantId: ctx.tenantId, customerId: customer.id, points, before: customer.points || 0, after: nextPoints, reasonCode: body.reasonCode, orderId: body.orderId || null, createdBy: ctx.userId, createdAt: runtime.nowIso() });
    runtime.addAudit(ctx, 'customers.points.adjust', 'CUSTOMER_POINT', id, customer, nextCustomer);
    runtime.json(res, 200, { pointLedgerId: id, customerId: customer.id, before: customer.points || 0, after: nextPoints });
  });

  router.add('GET', '/api/v1/ai/daily-brief', async ({ res, ctx }) => {
    if (!runtime.requireTenant(res, ctx) || !runtime.requireRole(res, ctx, 'MANAGER')) return;
    const date = runtime.nowIso().slice(0, 10);
    const range = dayRange(date);
    const orders = paidOrders(runtime, ctx, ctx.storeId, range.from, range.to);
    const lowStock = inventoryRows(runtime, ctx).filter((row) => row.state !== 'OK');
    const invoiceExceptions = invoiceRows(runtime, ctx, ctx.storeId).filter((invoice) => invoice.uploadState !== 'UPLOADED');
    const revenue = orders.reduce((sum, order) => sum + (order.grandTotal || 0), 0);
    const id = store.nextId('insight');
    const insight = { id, tenantId: ctx.tenantId, storeId: ctx.storeId, type: 'DAILY_BRIEF', confidence: orders.length >= 3 ? 'MEDIUM' : 'LOW', dataWindow: range, summary: `今日已付款 ${orders.length} 筆，營收 NT$${revenue}，低庫存 ${lowStock.length} 項，發票待處理 ${invoiceExceptions.length} 筆。`, evidence: { orderCount: orders.length, revenue, lowStock: lowStock.slice(0, 5), invoiceExceptions: invoiceExceptions.slice(0, 5), voidCount: [...store.data.orders.values()].filter((order) => order.tenantId === ctx.tenantId && order.state === 'VOIDED').length }, recommendations: [lowStock.length ? '先處理低庫存商品，避免尖峰缺貨。' : '庫存風險目前正常。', invoiceExceptions.length ? '發票上傳佇列需人工確認。' : '發票佇列目前無異常。'], createdAt: runtime.nowIso() };
    store.data.aiInsights.set(id, insight);
    runtime.addAudit(ctx, 'ai.daily_brief.read', 'AI_INSIGHT', id, null, { confidence: insight.confidence, evidence: insight.evidence });
    runtime.json(res, 200, insight);
  });

  router.add('POST', '/api/v1/telemetry/heartbeat', async ({ req, res, ctx }) => {
    if (!runtime.requireTenant(res, ctx) || !runtime.requireRole(res, ctx, 'CASHIER')) return;
    const body = await runtime.parseBody(req);
    if (!body.terminalId || typeof body.syncLagSeconds !== 'number') { runtime.json(res, 400, runtime.error('SYNC_STALE', 'terminalId and syncLagSeconds required')); return; }
    const storeId = body.storeId || ctx.storeId;
    if (!runtime.requireStoreScope(res, ctx, storeId)) return;
    const snapshot = { tenantId: ctx.tenantId, terminalId: body.terminalId, storeId, appVersion: body.appVersion || '1.0.0', deviceStatus: body.deviceStatus || 'OK', syncLagSeconds: body.syncLagSeconds, printerStatus: body.printerStatus || 'OK', queuedOutbox: Number.isInteger(body.queuedOutbox) ? body.queuedOutbox : 0, printErrorCount: body.printErrorCount || 0, receivedAt: runtime.nowIso() };
    snapshot.state = terminalState(snapshot);
    store.data.telemetrySnapshots.set(`${ctx.tenantId}:${snapshot.terminalId}`, snapshot);
    runtime.json(res, 200, { accepted: true, terminalId: snapshot.terminalId, storeId: snapshot.storeId, state: snapshot.state, syncLagSeconds: snapshot.syncLagSeconds, printerStatus: snapshot.printerStatus, queuedOutbox: snapshot.queuedOutbox, nextHeartbeatAt: new Date(Date.now() + 60_000).toISOString(), advice: snapshot.state === 'OK' ? 'none' : 'check_now' });
  });

  router.add('GET', '/api/v1/telemetry/dashboard', async ({ res, ctx, url }) => {
    if (!runtime.requireTenant(res, ctx) || !runtime.requireRole(res, ctx, 'MANAGER')) return;
    const storeId = url.searchParams.get('storeId');
    if (url.searchParams.has('tenantId')) { runtime.json(res, 400, runtime.error('DEVICE_MISMATCH', 'tenantId is server-derived')); return; }
    if (!runtime.requireStoreScope(res, ctx, storeId)) return;
    const terminals = [...store.data.telemetrySnapshots.values()].filter((row) => row.tenantId === ctx.tenantId).filter((row) => !storeId || row.storeId === storeId).map((row) => ({ terminalId: row.terminalId, syncLagSeconds: row.syncLagSeconds, printerStatus: row.printerStatus, queuedOutbox: row.queuedOutbox, printErrorCount: row.printErrorCount, softwareVersion: row.appVersion, state: terminalState(row) }));
    const overall = terminals.some((item) => ['CRITICAL', 'UNREACHABLE'].includes(item.state)) ? 'CRITICAL' : terminals.some((item) => item.state === 'DEGRADED') ? 'DEGRADED' : 'OK';
    runtime.json(res, 200, { storeId, timeRange: url.searchParams.get('timeRange') || 'day', overall, terminals });
  });

  router.add('GET', '/api/v1/sync/jobs', async ({ res, ctx, url }) => {
    if (!runtime.requireTenant(res, ctx) || !runtime.requireRole(res, ctx, 'MANAGER')) return;
    if (url.searchParams.has('tenantId')) { runtime.json(res, 400, runtime.error('TENANT_NOT_AUTHORIZED', 'tenantId is server-derived')); return; }
    const state = url.searchParams.get('state');
    const items = [...store.data.outboxJobs.values()].filter((job) => job.tenantId === ctx.tenantId).filter((job) => !state || job.state === state).map((job) => ({ id: job.id, resourceType: job.resourceType, resourceId: job.resourceId, state: job.state, attempts: job.attempts, lastErrorCode: job.lastErrorCode, lastErrorMessage: job.lastErrorMessage, createdAt: job.createdAt, updatedAt: job.updatedAt }));
    runtime.json(res, 200, { items, nextPageToken: null });
  });

  router.add('POST', /^\/api\/v1\/sync\/jobs\/([\w-]+)\/retry$/, async ({ req, res, ctx, params }) => {
    if (!runtime.requireTenant(res, ctx) || !runtime.requireRole(res, ctx, 'SUPERVISOR')) return;
    const job = store.data.outboxJobs.get(params[0]);
    if (!job || job.tenantId !== ctx.tenantId) { runtime.json(res, 404, runtime.error('SYNC_JOB_NOT_FOUND', 'sync job not found')); return; }
    const body = await runtime.parseBody(req);
    const attempts = (job.attempts || 0) + 1;
    const state = body.forceDeadLetter || attempts >= 3 ? 'DEAD_LETTER' : 'RETRYABLE_ERROR';
    const next = { ...job, state, attempts, lastErrorCode: body.errorCode || (state === 'DEAD_LETTER' ? 'RETRY_LIMIT_EXCEEDED' : 'SYNC_TIMEOUT'), lastErrorMessage: body.message || 'manual retry simulation', nextRetryAt: state === 'DEAD_LETTER' ? null : new Date(Date.now() + attempts * 60_000).toISOString(), updatedAt: runtime.nowIso() };
    store.data.outboxJobs.set(job.id, next);
    runtime.addAudit(ctx, 'sync.jobs.retry', 'OUTBOX_JOB', job.id, job, next);
    runtime.json(res, 200, next);
  });

  router.add('POST', /^\/api\/v1\/sync\/jobs\/([\w-]+)\/resolve$/, async ({ req, res, ctx, params }) => {
    if (!runtime.requireTenant(res, ctx) || !runtime.requireRole(res, ctx, 'SUPERVISOR')) return;
    const job = store.data.outboxJobs.get(params[0]);
    if (!job || job.tenantId !== ctx.tenantId) { runtime.json(res, 404, runtime.error('SYNC_JOB_NOT_FOUND', 'sync job not found')); return; }
    const body = await runtime.parseBody(req);
    if (!['MARK_SYNCED', 'ABANDON_WITH_AUDIT'].includes(body.resolution)) { runtime.json(res, 400, runtime.error('SYNC_RESOLUTION_INVALID', 'resolution invalid')); return; }
    const next = { ...job, state: body.resolution === 'MARK_SYNCED' ? 'SYNCED' : 'ABANDONED', resolvedBy: ctx.userId, resolvedReason: body.reason || null, updatedAt: runtime.nowIso() };
    store.data.outboxJobs.set(job.id, next);
    runtime.addAudit(ctx, 'sync.jobs.resolve', 'OUTBOX_JOB', job.id, job, next);
    runtime.json(res, 200, next);
  });
}

module.exports = { register };
