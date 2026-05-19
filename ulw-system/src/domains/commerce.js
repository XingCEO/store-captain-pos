const { normalizeBusinessDate, isValidBusinessDate } = require('../core/tz');
const paymentProvider = require('../core/paymentProvider');
const invoiceProvider = require('../core/invoiceProvider');
const metrics = require('../core/metrics');

// Invoice lifecycleState FSM. Disallowed transitions are rejected to prevent
// fields drifting via partial-update bugs. Used by ensureInvoice + future
// adapters.
const INVOICE_TRANSITIONS = {
  ISSUED_SANDBOX:   ['UPLOAD_PENDING', 'VOIDED_SANDBOX', 'ALLOWANCE_SANDBOX'],
  UPLOAD_PENDING:   ['UPLOADED', 'UPLOAD_FAILED', 'VOIDED_SANDBOX'],
  UPLOAD_FAILED:    ['UPLOAD_PENDING', 'VOIDED_SANDBOX'],
  UPLOADED:         ['VOIDED', 'ALLOWANCE'],
  VOIDED_SANDBOX:   [],
  VOIDED:           [],
  ALLOWANCE_SANDBOX:['VOIDED_SANDBOX'],
  ALLOWANCE:        ['VOIDED'],
};

function invoiceTransitionAllowed(from, to) {
  if (from === to) return true;
  const next = INVOICE_TRANSITIONS[from] || [];
  return next.includes(to);
}

function orderItems(runtime, orderId) {
  return [...runtime.store.data.orderItems.values()].filter((item) => item.orderId === orderId);
}

function paymentsFor(runtime, orderId) {
  return [...runtime.store.data.payments.values()].filter((payment) => payment.orderId === orderId);
}

function getOutboxJob(runtime, orderId) {
  return [...runtime.store.data.outboxJobs.values()].find((job) => job.resourceType === 'order' && job.resourceId === orderId) || null;
}

function orderResponse(runtime, order) {
  const syncJob = getOutboxJob(runtime, order.id);
  const refunds = [...runtime.store.data.refunds.values()].filter((refund) => refund.orderId === order.id);
  return {
    id: order.id,
    tenantId: order.tenantId,
    storeId: order.storeId,
    terminalId: order.terminalId,
    orderNumber: order.orderNumber,
    state: order.state,
    paymentState: order.paymentState,
    source: order.source || 'POS',
    sourceRef: order.sourceRef || order.clientRef || null,
    items: orderItems(runtime, order.id).map((item) => ({ id: item.id, productId: item.productId, skuId: item.skuId, name: item.name, qty: item.qty, unitPrice: item.unitPrice, discountAmount: item.discountAmount || 0, modifiers: item.modifiers || [], notes: item.notes || null, subtotal: item.subtotal })),
    payments: paymentsFor(runtime, order.id),
    refunds,
    createdBy: order.createdBy,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    paidAt: order.paidAt || null,
    outbox: { jobId: syncJob ? syncJob.id : null, state: syncJob ? syncJob.state : 'DONE' },
    subtotal: order.subtotal || 0,
    discountTotal: order.discountTotal || 0,
    taxTotal: order.taxTotal || 0,
    grandTotal: order.grandTotal || 0,
  };
}

function appendOrderEvent(runtime, ctx, orderId, eventType, meta) {
  const at = runtime.nowIso();
  const event = { id: runtime.store.nextId('orderEvent'), tenantId: ctx.tenantId, orderId, eventType, actorId: ctx.userId, at, payloadFingerprint: runtime.requestFingerprint(meta), meta };
  runtime.store.data.orderEvents.set(orderId, [...(runtime.store.data.orderEvents.get(orderId) || []), event]);
  return event;
}

function applyInventoryForOrder(runtime, ctx, order, direction, reason) {
  const movements = [];
  const levelUpdates = [];
  const ledgerRows = [];
  for (const item of orderItems(runtime, order.id)) {
    const sku = runtime.store.data.skus.get(item.skuId);
    if (!sku || sku.tenantId !== ctx.tenantId || !sku.stockTracked) continue;
    const key = `${ctx.tenantId}:${sku.id}`;
    const current = runtime.store.data.inventoryLevels.get(key) || { tenantId: ctx.tenantId, skuId: sku.id, stockOnHand: Number(sku.stock || 0) };
    const nextStock = current.stockOnHand + (direction === 'decrement' ? -item.qty : item.qty);
    if (nextStock < 0) return { success: false, errorCode: 'OUT_OF_STOCK', message: `insufficient stock for sku ${sku.id}` };
    const movementId = runtime.store.nextId('inventoryMove');
    const at = runtime.nowIso();
    levelUpdates.push([key, { ...current, stockOnHand: nextStock, updatedAt: at }]);
    ledgerRows.push([movementId, { id: movementId, tenantId: ctx.tenantId, skuId: sku.id, skuCode: sku.skuCode, orderId: order.id, direction, qty: item.qty, before: current.stockOnHand, after: nextStock, reason, at }]);
    movements.push({ movementId, skuId: sku.id, before: current.stockOnHand, after: nextStock });
  }
  for (const [key, level] of levelUpdates) runtime.store.data.inventoryLevels.set(key, level);
  for (const [movementId, row] of ledgerRows) runtime.store.data.inventoryLedger.set(movementId, row);
  return { success: true, movements };
}

function paidOrders(runtime, ctx, storeId = null, from = null, to = null) {
  const fromTs = from ? new Date(from).getTime() : null;
  const toTs = to ? new Date(to).getTime() : null;
  return [...runtime.store.data.orders.values()].filter((order) => {
    if (order.tenantId !== ctx.tenantId || order.paymentState !== 'PAID') return false;
    if (storeId && order.storeId !== storeId) return false;
    const ts = new Date(order.paidAt || order.createdAt).getTime();
    if (fromTs && ts < fromTs) return false;
    if (toTs && ts > toTs) return false;
    return true;
  });
}

function paymentsTotal(runtime, orderId) {
  return paymentsFor(runtime, orderId).reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
}

function invoiceForOrder(runtime, orderId) {
  return [...runtime.store.data.invoices.values()].find((invoice) => invoice.orderId === orderId) || null;
}

async function ensureInvoice(runtime, ctx, order) {
  const existing = invoiceForOrder(runtime, order.id);
  if (existing) return existing;
  const paidAmount = paymentsTotal(runtime, order.id);
  const invoiceId = runtime.store.nextId('invoice');
  const at = runtime.nowIso();
  const provider = invoiceProvider.active();
  // Provider issues the invoice — real adapter would round-trip 加值中心 here.
  const issued = await provider.issue({
    orderId: order.id,
    tenantId: ctx.tenantId,
    storeId: order.storeId,
    amount: order.grandTotal || paidAmount,
    invoiceLocalId: invoiceId,
  });
  const invoice = {
    id: invoiceId,
    tenantId: ctx.tenantId,
    orderId: order.id,
    storeId: order.storeId,
    invoiceNumber: issued.invoiceNumber,
    buyerIdentifier: null,
    carrierType: 'NONE',
    carrierNumber: null,
    donateCode: null,
    amount: order.grandTotal || paidAmount,
    paymentAmount: paidAmount,
    uploadState: paidAmount === (order.grandTotal || 0) ? 'PENDING_UPLOAD' : 'AMOUNT_MISMATCH',
    lifecycleState: issued.lifecycleState || 'ISSUED_SANDBOX',
    migVersion: provider.capabilities.migVersion,
    turnkeyVersion: provider.capabilities.turnkeyVersion,
    providerCode: provider.code,
    providerRaw: issued.raw || null,
    attempts: 0,
    lastErrorCode: paidAmount === (order.grandTotal || 0) ? null : 'INVOICE_AMOUNT_MISMATCH',
    createdBy: ctx.userId,
    createdAt: at,
    updatedAt: at,
  };
  runtime.store.data.invoices.set(invoiceId, invoice);
  runtime.addAudit(ctx, 'invoices.issue_sandbox', 'INVOICE', invoiceId, null, invoice);
  return invoice;
}

function register(router, runtime) {
  const { store } = runtime;

  router.add('POST', '/api/v1/orders', async ({ req, res, ctx }) => {
    if (!runtime.requireTenant(res, ctx) || !runtime.requireRole(res, ctx, 'CASHIER')) return;
    let body;
    try { body = await runtime.parseBody(req); } catch { runtime.json(res, 400, runtime.error('PAYLOAD_PARSE_ERROR', 'invalid JSON body')); return; }
    const { clientRef, storeId, terminalId, businessDate, customerTag = null, items = [], notes = null, idempotencyKey } = body;
    if (!String(idempotencyKey || '').trim()) { runtime.json(res, 400, runtime.error('IDEMPOTENCY_KEY_MISMATCH', 'Idempotency key required')); return; }
    if (!storeId || !terminalId || !businessDate || !Array.isArray(items) || items.length === 0) { runtime.json(res, 400, runtime.error('ORDER_ITEM_INVALID', 'storeId, terminalId, businessDate, items required')); return; }
    if (!isValidBusinessDate(businessDate)) { runtime.json(res, 400, runtime.error('ORDER_ITEM_INVALID', 'businessDate must be YYYY-MM-DD (Asia/Taipei)')); return; }
    if (!runtime.requireStoreScope(res, ctx, storeId)) return;
    const idemKey = `${ctx.tenantId}:${storeId}:${idempotencyKey}`;
    const previous = store.data.orderIdempotency.get(idemKey);
    if (previous) {
      if (previous.fingerprint === runtime.requestFingerprint(body)) runtime.json(res, 200, { ...previous.response, duplicated: true });
      else runtime.json(res, 409, runtime.error('ORDER_IDEMPOTENCY_CONFLICT', 'idempotency key payload mismatch'));
      return;
    }
    const at = runtime.nowIso();
    const lineRecords = [];
    let subtotal = 0;
    let discountTotal = 0;
    for (const item of items) {
      const sku = store.data.skus.get(item.skuId);
      if (!sku || sku.tenantId !== ctx.tenantId || !Number.isInteger(item.qty) || item.qty <= 0) {
        runtime.json(res, 400, runtime.error('ORDER_ITEM_INVALID', 'invalid item payload'));
        return;
      }
      if (typeof sku.price !== 'number' || sku.price < 0) {
        runtime.json(res, 400, runtime.error('ORDER_ITEM_INVALID', `sku ${sku.id} has no valid server price`));
        return;
      }
      // Server-derived unitPrice. Client-sent `item.unitPrice` is ignored so a
      // CASHIER cannot submit price=0 to give items away or inflate a refund
      // laundering cycle. An explicit override path (e.g. clerk discount)
      // would route through PATCH /orders/:id/discount with audit, not here.
      const unitPrice = sku.price;
      // Reject discount injection on the client side; manager discount path
      // is the only legitimate route.
      const discountAmount = 0;
      const lineSubtotal = item.qty * unitPrice;
      const line = { id: store.nextId('orderItem'), tenantId: ctx.tenantId, orderId: null, productId: sku.productId, skuId: sku.id, name: item.name || sku.name, qty: item.qty, unitPrice, discountAmount, modifiers: Array.isArray(item.modifiers) ? item.modifiers.map(String) : [], notes: item.notes || null, subtotal: lineSubtotal - discountAmount };
      subtotal += lineSubtotal;
      discountTotal += discountAmount;
      lineRecords.push(line);
    }
    const orderId = store.nextId('order');
    const order = { id: orderId, tenantId: ctx.tenantId, storeId, terminalId, businessDate: normalizeBusinessDate(businessDate), customerTag, notes, clientRef: clientRef || null, lineItems: lineRecords.map((line) => ({ skuId: line.skuId, qty: line.qty })), state: 'DRAFT', paymentState: 'UNPAID', orderNumber: `ORD-${orderId}`, actor: ctx.userId, createdBy: ctx.userId, itemCount: lineRecords.length, subtotal, discountTotal, taxTotal: 0, grandTotal: Math.max(0, subtotal - discountTotal), createdAt: at, updatedAt: at };
    store.data.orders.set(orderId, order);
    for (const line of lineRecords) { line.orderId = orderId; store.data.orderItems.set(line.id, line); }
    const outbox = { id: store.nextId('outbox'), tenantId: ctx.tenantId, resourceType: 'order', resourceId: orderId, state: 'PENDING', attempts: 0, payloadFingerprint: runtime.requestFingerprint({ clientRef, orderId, storeId, terminalId, businessDate, items }), lastErrorCode: null, lastErrorMessage: null, nextRetryAt: null, createdAt: at, updatedAt: at };
    store.data.outboxJobs.set(outbox.id, outbox);
    const event = { id: store.nextId('orderEvent'), tenantId: ctx.tenantId, orderId, eventType: 'ORDER_CREATED', actorId: ctx.userId, at, payloadFingerprint: outbox.payloadFingerprint, meta: { orderNumber: order.orderNumber, subtotal, grandTotal: order.grandTotal } };
    store.data.orderEvents.set(orderId, [event]);
    const response = { id: order.id, orderNumber: order.orderNumber, state: order.state, currency: 'TWD', subtotal, discountTotal, taxTotal: 0, grandTotal: order.grandTotal, createdAt: at, sync: { jobId: outbox.id, state: outbox.state }, items: lineRecords.map((line) => ({ id: line.id, skuId: line.skuId, name: line.name, qty: line.qty, unitPrice: line.unitPrice, subtotal: line.subtotal })), duplicated: false };
    store.data.orderIdempotency.set(idemKey, { fingerprint: runtime.requestFingerprint(body), orderId, response });
    runtime.addAudit(ctx, 'ORDER_CREATED', 'order', orderId, null, { id: order.id, orderNumber: order.orderNumber, state: order.state, storeId: order.storeId, itemCount: lineRecords.length, subtotal: order.subtotal, discountTotal: order.discountTotal, grandTotal: order.grandTotal, createdBy: order.createdBy, createdAt: order.createdAt });
    try {
      metrics.ordersCreatedTotal.inc({ tenant_id: ctx.tenantId, store_id: storeId });
      metrics.ordersStateTotal.inc({ state: 'DRAFT' });
      metrics.orderGrandTotalTwd.observe(order.grandTotal || 0);
    } catch { /* metric optional */ }
    runtime.json(res, 201, response);
  });

  router.add('PATCH', /^\/api\/v1\/orders\/([\w-]+)\/discount$/, async ({ req, res, ctx, params }) => {
    if (!runtime.requireTenant(res, ctx) || !runtime.requireRole(res, ctx, 'MANAGER')) return;
    const order = store.data.orders.get(params[0]);
    if (!order || order.tenantId !== ctx.tenantId) { runtime.json(res, 404, runtime.error('ORDER_NOT_FOUND', 'order not found')); return; }
    if (!runtime.requireStoreScope(res, ctx, order.storeId)) return;
    if (order.paymentState === 'PAID' || order.state === 'VOIDED') { runtime.json(res, 409, runtime.error('ORDER_STATE_INVALID', 'paid or voided order cannot be discounted')); return; }
    const body = await runtime.parseBody(req);
    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount < 0 || amount > order.subtotal || !['ORDER_FIXED', 'MANAGER_APPROVAL', 'COUPON'].includes(body.reasonCode)) { runtime.json(res, 400, runtime.error('DISCOUNT_INVALID', 'amount and reasonCode invalid')); return; }
    const next = { ...order, discountTotal: amount, discountReasonCode: body.reasonCode, discountApprovedBy: ctx.userId, grandTotal: Math.max(0, order.subtotal - amount), updatedAt: runtime.nowIso() };
    store.data.orders.set(order.id, next);
    appendOrderEvent(runtime, ctx, order.id, 'ORDER_DISCOUNT_APPLIED', { amount, reasonCode: body.reasonCode });
    runtime.addAudit(ctx, 'ORDER_DISCOUNT_APPLIED', 'order', order.id, { id: order.id, discountTotal: order.discountTotal, grandTotal: order.grandTotal, state: order.state }, { id: next.id, discountTotal: next.discountTotal, grandTotal: next.grandTotal, state: next.state });
    runtime.json(res, 200, orderResponse(runtime, next));
  });

  router.add('POST', /^\/api\/v1\/orders\/([\w-]+)\/pay\/manual$/, async ({ req, res, ctx, params }) => {
    if (!runtime.requireTenant(res, ctx) || !runtime.requireRole(res, ctx, 'CASHIER')) return;
    const order = store.data.orders.get(params[0]);
    if (!order || order.tenantId !== ctx.tenantId) { runtime.json(res, 404, runtime.error('ORDER_NOT_FOUND', 'order not found')); return; }
    if (!runtime.requireStoreScope(res, ctx, order.storeId)) return;
    const body = await runtime.parseBody(req);
    const amount = Number(body.amount);
    const method = body.paymentMethod || 'CASH';
    const cashReceived = Number(body.cashReceived ?? amount);
    const alreadyPaid = paymentsTotal(runtime, order.id);
    const due = Math.max(0, (order.grandTotal || 0) - alreadyPaid);
    if (order.paymentState === 'PAID' || order.state === 'VOIDED') {
      runtime.json(res, 409, runtime.error('ORDER_STATE_INVALID', 'order already paid or voided'));
      return;
    }
    if (!['CASH', 'CARD', 'QR', 'MOBILE'].includes(method) || !Number.isFinite(amount) || amount <= 0 || amount > due || cashReceived < amount) {
      runtime.json(res, 400, runtime.error('PAYMENT_INVALID', 'payment payload invalid'));
      return;
    }
    const at = runtime.nowIso();
    const paymentId = store.nextId('payment');
    // Delegate to payment provider — POS core never speaks to PSP directly.
    // See src/core/paymentProvider.js for the contract.
    const provider = paymentProvider.defaultProviderFor(method);
    if (!provider) { runtime.json(res, 400, runtime.error('PAYMENT_INVALID', `no provider registered for method ${method}`)); return; }
    let providerResult;
    try {
      providerResult = await provider.charge({
        tenantId: ctx.tenantId,
        orderId: order.id,
        amount,
        currency: 'TWD',
        method,
        idempotencyKey: body.idempotencyKey || null,
        metadata: body.providerMetadata || {},
      });
    } catch (err) {
      const code = err.errorCode || 'PAYMENT_DECLINED';
      runtime.addAudit(ctx, 'PAYMENT_DECLINED', 'order', order.id, null, { method, amount, providerCode: provider.code, reason: err.message });
      runtime.json(res, 402, runtime.error(code, err.message || 'payment declined by provider'));
      return;
    }
    // correlationId is server-generated. Client cannot inject — prevents
    // attackers from forging settlement reconciliation keys.
    const payment = {
      id: paymentId, tenantId: ctx.tenantId, orderId: order.id, method,
      paymentProvider: provider.code,
      providerTransactionId: providerResult.providerTransactionId,
      authorizationCode: providerResult.authorizationCode,
      amount, received: cashReceived, change: cashReceived - amount,
      status: 'CAPTURED',
      settlementState: providerResult.settlementState,
      fee: providerResult.fee || 0,
      netSettledAmount: providerResult.netSettledAmount || amount,
      correlationId: `corr-${paymentId}`,
      cashierMemo: body.cashierMemo || null,
      providerRaw: providerResult.raw || null,
      createdAt: at, createdBy: ctx.userId,
    };
    const nextPaid = alreadyPaid + amount;
    const fullyPaid = nextPaid >= (order.grandTotal || 0);
    const stock = fullyPaid && !order.inventoryAppliedAt ? applyInventoryForOrder(runtime, ctx, order, 'decrement', 'POS_SALE') : { success: true, movements: [] };
    if (!stock.success) { runtime.json(res, 409, runtime.error(stock.errorCode, stock.message)); return; }
    store.data.payments.set(paymentId, payment);
    const printJobId = fullyPaid ? store.nextId('job') : null;
    if (fullyPaid) store.data.printJobs.set(printJobId, { id: printJobId, tenantId: ctx.tenantId, storeId: order.storeId, orderId: order.id, documentType: 'RECEIPT', state: 'QUEUED', attempts: 0, lastErrorCode: null, createdAt: at, updatedAt: at });
    const next = { ...order, state: fullyPaid ? (method === 'CASH' ? 'PAID_CASH' : 'PAID_PENDING') : 'PARTIALLY_PAID', paymentState: fullyPaid ? 'PAID' : 'PARTIALLY_PAID', paidAt: fullyPaid ? at : order.paidAt || null, inventoryAppliedAt: fullyPaid ? (order.inventoryAppliedAt || at) : order.inventoryAppliedAt || null, updatedAt: at };
    store.data.orders.set(order.id, next);
    const invoice = fullyPaid ? await ensureInvoice(runtime, ctx, next) : null;
    appendOrderEvent(runtime, ctx, order.id, fullyPaid ? 'ORDER_PAID' : 'ORDER_PARTIAL_PAYMENT', { paymentId, method, amount, paidTotal: nextPaid, due: Math.max(0, (order.grandTotal || 0) - nextPaid), inventoryMovements: stock.movements });
    runtime.addAudit(ctx, 'ORDER_PAID_MANUAL', 'order', order.id,
      { id: order.id, state: order.state, paymentState: order.paymentState, grandTotal: order.grandTotal },
      { id: next.id, state: next.state, paymentState: next.paymentState, grandTotal: next.grandTotal, payment: { method: payment.method, amount: payment.amount, status: payment.status, providerTransactionId: payment.providerTransactionId } });
    try {
      metrics.paymentsTotal.inc({ method, status: payment.status });
      metrics.paymentAmountTwd.observe({ method }, amount);
      metrics.ordersStateTotal.inc({ state: next.state });
      if (invoice) metrics.invoicesIssuedTotal.inc({ provider: invoice.providerCode || 'UNKNOWN', lifecycle: invoice.lifecycleState });
    } catch { /* metric optional */ }
    runtime.json(res, 200, { orderId: order.id, state: next.state, paymentState: next.paymentState, paymentSummary: { method, amount, received: payment.received, change: payment.change, paidTotal: nextPaid, due: Math.max(0, (order.grandTotal || 0) - nextPaid), providerTransactionId: payment.providerTransactionId, authorizationCode: payment.authorizationCode, settlementState: payment.settlementState, paymentProvider: payment.paymentProvider, fee: payment.fee, netSettledAmount: payment.netSettledAmount }, invoice: invoice ? { invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber, uploadState: invoice.uploadState } : null, printQueueId: printJobId });
  });

  router.add('POST', /^\/api\/v1\/orders\/([\w-]+)\/refund$/, async ({ req, res, ctx, params }) => {
    if (!runtime.requireTenant(res, ctx) || !runtime.requireRole(res, ctx, 'SUPERVISOR')) return;
    const order = store.data.orders.get(params[0]);
    if (!order || order.tenantId !== ctx.tenantId) { runtime.json(res, 404, runtime.error('ORDER_NOT_FOUND', 'order not found')); return; }
    if (!runtime.requireStoreScope(res, ctx, order.storeId)) return;
    const body = await runtime.parseBody(req);
    const { idempotencyKey } = body;
    if (idempotencyKey) {
      const idemKey = `${ctx.tenantId}:${order.storeId}:refund:${idempotencyKey}`;
      const previous = store.data.idempotency.get(idemKey);
      if (previous) {
        if (previous.fingerprint === runtime.requestFingerprint(body)) { runtime.json(res, 200, { ...previous.response, duplicated: true }); return; }
        runtime.json(res, 409, runtime.error('ORDER_IDEMPOTENCY_CONFLICT', 'idempotency key payload mismatch'));
        return;
      }
    }
    const amount = Number(body.amount);
    const paid = paymentsTotal(runtime, order.id);
    const refunded = [...store.data.refunds.values()].filter((refund) => refund.orderId === order.id && refund.status !== 'REJECTED').reduce((sum, refund) => sum + refund.amount, 0);
    if (order.paymentState !== 'PAID') { runtime.json(res, 409, runtime.error('ORDER_STATE_INVALID', 'order must be in PAID state to refund')); return; }
    if (!Number.isFinite(amount) || amount <= 0 || amount > paid - refunded) { runtime.json(res, 400, runtime.error('REFUND_AMOUNT_INVALID', 'refund amount exceeds refundable balance or is invalid')); return; }
    if (!['CUSTOMER_RETURN', 'WRONG_ITEM', 'SERVICE_RECOVERY'].includes(body.reasonCode)) { runtime.json(res, 400, runtime.error('REFUND_AMOUNT_INVALID', 'reasonCode invalid')); return; }
    const refundId = store.nextId('refund');
    const at = runtime.nowIso();
    const refund = { id: refundId, tenantId: ctx.tenantId, orderId: order.id, storeId: order.storeId, amount, reasonCode: body.reasonCode, method: body.method || 'CASH', status: 'APPROVED_MANUAL', restock: Boolean(body.restock), createdBy: ctx.userId, createdAt: at };
    const next = { ...order, state: amount === paid - refunded ? 'REFUNDED' : 'PARTIALLY_REFUNDED', refundTotal: refunded + amount, updatedAt: at };
    if (refund.restock) {
      // applyInventoryForOrder may fail only if the increment would push another
      // item negative (impossible here since we never decrement on refund). Still
      // we audit each movement so support can reconcile.
      const restockResult = applyInventoryForOrder(runtime, ctx, order, 'increment', 'REFUND_RESTOCK');
      if (!restockResult.success) {
        runtime.json(res, 409, runtime.error('RESTOCK_NEGATIVE_BLOCKED', restockResult.message || 'restock blocked'));
        return;
      }
      for (const m of restockResult.movements) {
        runtime.addAudit(ctx, 'INVENTORY_RESTOCK', 'INVENTORY_LEDGER', m.movementId,
          { skuId: m.skuId, stockOnHand: m.before },
          { skuId: m.skuId, stockOnHand: m.after, refundId, orderId: order.id });
      }
    }
    store.data.refunds.set(refundId, refund);
    store.data.orders.set(order.id, next);
    appendOrderEvent(runtime, ctx, order.id, 'ORDER_REFUNDED', { refundId, amount, reasonCode: body.reasonCode, restock: refund.restock });
    const invoice = invoiceForOrder(runtime, order.id);
    if (invoice) {
      const allowanceId = store.nextId('allowance');
      store.data.invoiceAllowances.set(allowanceId, { id: allowanceId, tenantId: ctx.tenantId, invoiceId: invoice.id, orderId: order.id, amount, state: 'ALLOWANCE_CREATED_SANDBOX', reasonCode: body.reasonCode, createdAt: at, createdBy: ctx.userId });
    }
    runtime.addAudit(ctx, 'ORDER_REFUNDED', 'order', order.id,
      { id: order.id, state: order.state, paymentState: order.paymentState, refundTotal: order.refundTotal || 0 },
      { id: next.id, state: next.state, paymentState: next.paymentState, refundTotal: next.refundTotal });
    try { metrics.refundsTotal.inc({ reason: body.reasonCode }); metrics.ordersStateTotal.inc({ state: next.state }); } catch { /* metric optional */ }
    const response = { refund, order: orderResponse(runtime, next) };
    if (idempotencyKey) {
      const idemKey = `${ctx.tenantId}:${order.storeId}:refund:${idempotencyKey}`;
      store.data.idempotency.set(idemKey, { fingerprint: runtime.requestFingerprint(body), response });
    }
    runtime.json(res, 200, response);
  });

  router.add('POST', /^\/api\/v1\/orders\/([\w-]+)\/void$/, async ({ req, res, ctx, params }) => {
    if (!runtime.requireTenant(res, ctx) || !runtime.requireRole(res, ctx, 'MANAGER')) return;
    const order = store.data.orders.get(params[0]);
    if (!order || order.tenantId !== ctx.tenantId) { runtime.json(res, 404, runtime.error('ORDER_NOT_FOUND', 'order not found')); return; }
    if (!runtime.requireStoreScope(res, ctx, order.storeId)) return;
    const body = await runtime.parseBody(req);
    const { idempotencyKey } = body;
    if (idempotencyKey) {
      const idemKey = `${ctx.tenantId}:${order.storeId}:void:${idempotencyKey}`;
      const previous = store.data.idempotency.get(idemKey);
      if (previous) {
        if (previous.fingerprint === runtime.requestFingerprint(body)) { runtime.json(res, 200, { ...previous.response, duplicated: true }); return; }
        runtime.json(res, 409, runtime.error('ORDER_IDEMPOTENCY_CONFLICT', 'idempotency key payload mismatch'));
        return;
      }
    }
    if (order.state === 'VOIDED') { runtime.json(res, 409, runtime.error('ORDER_STATE_INVALID', 'order already voided')); return; }
    if (order.paymentState === 'PAID') { runtime.json(res, 409, runtime.error('VOID_NOT_ALLOWED', 'paid order cannot be voided')); return; }
    if (!['CUST_CANCEL', 'INPUT_ERROR', 'VOID_AFTER_PRINT'].includes(body.reasonCode)) { runtime.json(res, 400, runtime.error('VOID_NOT_ALLOWED', 'invalid reasonCode for void')); return; }
    const next = { ...order, state: 'VOIDED', voidReasonCode: body.reasonCode, voidNote: body.note || null, updatedAt: runtime.nowIso() };
    store.data.orders.set(order.id, next);
    runtime.addAudit(ctx, 'ORDER_VOIDED', 'order', order.id,
      { id: order.id, state: order.state, paymentState: order.paymentState },
      { id: next.id, state: next.state, voidReasonCode: next.voidReasonCode, voidNote: next.voidNote });
    try { metrics.voidsTotal.inc({ reason: body.reasonCode }); metrics.ordersStateTotal.inc({ state: 'VOIDED' }); } catch { /* metric optional */ }
    const response = { orderId: order.id, state: next.state, reasonCode: next.voidReasonCode };
    if (idempotencyKey) {
      const idemKey = `${ctx.tenantId}:${order.storeId}:void:${idempotencyKey}`;
      store.data.idempotency.set(idemKey, { fingerprint: runtime.requestFingerprint(body), response });
    }
    runtime.json(res, 200, response);
  });

  router.add('GET', /^\/api\/v1\/orders\/([\w-]+)$/, async ({ res, ctx, params }) => {
    if (!runtime.requireTenant(res, ctx) || !runtime.requireRole(res, ctx, 'CASHIER')) return;
    const order = store.data.orders.get(params[0]);
    if (!order || order.tenantId !== ctx.tenantId) { runtime.json(res, 404, runtime.error('TENANT_NOT_AUTHORIZED', 'order not found')); return; }
    if (!runtime.requireStoreScope(res, ctx, order.storeId)) return;
    runtime.json(res, 200, orderResponse(runtime, order));
  });

  router.add('GET', /^\/api\/v1\/orders\/([\w-]+)\/events$/, async ({ res, ctx, params }) => {
    if (!runtime.requireTenant(res, ctx) || !runtime.requireRole(res, ctx, 'CASHIER')) return;
    const order = store.data.orders.get(params[0]);
    if (!order || order.tenantId !== ctx.tenantId) { runtime.json(res, 404, runtime.error('TENANT_NOT_AUTHORIZED', 'order not found')); return; }
    if (!runtime.requireStoreScope(res, ctx, order.storeId)) return;
    runtime.json(res, 200, { orderId: order.id, events: store.data.orderEvents.get(order.id) || [] });
  });

  router.add('GET', '/api/v1/payment-providers', async ({ res, ctx }) => {
    if (!runtime.requireTenant(res, ctx) || !runtime.requireRole(res, ctx, 'MANAGER')) return;
    runtime.json(res, 200, { items: paymentProvider.listCapabilities() });
  });

  router.add('GET', '/api/v1/payments', async ({ res, ctx, url }) => {
    if (!runtime.requireTenant(res, ctx) || !runtime.requireRole(res, ctx, 'MANAGER')) return;
    const storeId = url.searchParams.get('storeId');
    if (!runtime.requireStoreScope(res, ctx, storeId)) return;
    const items = [...store.data.payments.values()].filter((payment) => payment.tenantId === ctx.tenantId).filter((payment) => !storeId || store.data.orders.get(payment.orderId)?.storeId === storeId).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    runtime.json(res, 200, { items });
  });
}

module.exports = { register, orderItems, paymentsFor, paidOrders, paymentsTotal, ensureInvoice, invoiceForOrder, orderResponse, invoiceTransitionAllowed, INVOICE_TRANSITIONS };
