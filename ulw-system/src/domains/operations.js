const { orderItems, paidOrders } = require('./commerce');
const { roleRank } = require('../core/runtime');

function inventoryKey(ctx, skuId) {
  return `${ctx.tenantId}:${skuId}`;
}

function getInventory(runtime, ctx, skuId) {
  const sku = runtime.store.data.skus.get(skuId);
  return runtime.store.data.inventoryLevels.get(inventoryKey(ctx, skuId)) || { tenantId: ctx.tenantId, skuId, stockOnHand: sku && Number.isFinite(sku.stock) ? sku.stock : 0 };
}

function setInventory(runtime, ctx, skuId, stockOnHand) {
  runtime.store.data.inventoryLevels.set(inventoryKey(ctx, skuId), { tenantId: ctx.tenantId, skuId, stockOnHand, updatedAt: runtime.nowIso() });
}

function appendMovement(runtime, ctx, sku, orderId, direction, qty, before, after, reason) {
  const id = runtime.store.nextId('inventoryMove');
  runtime.store.data.inventoryLedger.set(id, { id, tenantId: ctx.tenantId, skuId: sku.id, skuCode: sku.skuCode, orderId, direction, qty, before, after, reason, at: runtime.nowIso() });
  return id;
}

function recalcInventory(runtime, ctx, order, direction) {
  const movements = [];
  for (const line of orderItems(runtime, order.id)) {
    const sku = runtime.store.data.skus.get(line.skuId);
    if (!sku || sku.tenantId !== ctx.tenantId) return { success: false, errorCode: 'PRODUCT_NOT_FOUND', message: 'sku not found' };
    if (!sku.stockTracked) continue;
    const current = getInventory(runtime, ctx, sku.id);
    const next = current.stockOnHand + (direction === 'decrement' ? -line.qty : line.qty);
    if (next < 0) return { success: false, errorCode: 'OUT_OF_STOCK', message: `insufficient stock for sku ${sku.id}` };
    setInventory(runtime, ctx, sku.id, next);
    movements.push({ movementId: appendMovement(runtime, ctx, sku, order.id, direction, line.qty, current.stockOnHand, next, `order_${direction}`), skuId: sku.id, before: current.stockOnHand, after: next });
  }
  return { success: true, movements };
}

function inventoryRows(runtime, ctx) {
  return [...runtime.store.data.skus.values()].filter((sku) => sku.tenantId === ctx.tenantId && sku.stockTracked).map((sku) => {
    const level = getInventory(runtime, ctx, sku.id);
    return { skuId: sku.id, skuCode: sku.skuCode, name: sku.name, stockOnHand: level.stockOnHand, safetyStock: 10, state: level.stockOnHand <= 0 ? 'OUT' : level.stockOnHand <= 10 ? 'LOW' : 'OK', updatedAt: level.updatedAt || sku.updatedAt };
  });
}

// Valid KDS production-state transitions
const KDS_TRANSITIONS = {
  QUEUED: ['IN_PROGRESS'],
  IN_PROGRESS: ['READY'],
  READY: ['DONE'],
  DONE: [],
};

function register(router, runtime) {
  const { store } = runtime;

  // POST /api/v1/order-sources/manual
  // Role: MANAGER+; dedup by externalReferenceId per tenant+source
  router.add('POST', '/api/v1/order-sources/manual', async ({ req, res, ctx }) => {
    if (!runtime.requireTenant(res, ctx) || !runtime.requireRole(res, ctx, 'MANAGER')) return;
    const body = await runtime.parseBody(req);
    const storeId = body.tenantStoreId || body.storeId || ctx.storeId;
    const channel = body.channel;
    const externalReferenceId = body.externalReferenceId;
    if (!['QR', 'PHONE', 'POS', 'LINE', 'WEB'].includes(channel)) { runtime.json(res, 400, runtime.error('SOURCE_CHANNEL_UNKNOWN', 'channel invalid')); return; }
    if (!externalReferenceId) { runtime.json(res, 400, runtime.error('MISSING_REFERENCE_ID', 'externalReferenceId required')); return; }
    if (!runtime.requireStoreScope(res, ctx, storeId)) return;
    const sourceKey = `${ctx.tenantId}:${storeId}:${channel}:${externalReferenceId}`;
    if (store.data.orderSources.has(sourceKey)) { runtime.json(res, 409, runtime.error('ORDER_SOURCE_DUPLICATE', 'duplicate source order', { existingOrderId: store.data.orderSources.get(sourceKey).orderId })); return; }
    if (!Array.isArray(body.items) || body.items.length === 0) { runtime.json(res, 400, runtime.error('ORDER_ITEM_INVALID', 'items required')); return; }
    const orderId = store.nextId('order');
    const at = runtime.nowIso();
    const lines = [];
    let subtotal = 0;
    for (const item of body.items) {
      const sku = store.data.skus.get(item.skuId);
      const qty = Number(item.qty);
      const unitPrice = Number(item.price ?? item.unitPrice ?? sku?.price);
      if (!sku || sku.tenantId !== ctx.tenantId || !Number.isInteger(qty) || qty <= 0 || !Number.isFinite(unitPrice) || unitPrice < 0) { runtime.json(res, 400, runtime.error('ORDER_ITEM_INVALID', 'item invalid')); return; }
      const line = { id: store.nextId('orderItem'), tenantId: ctx.tenantId, orderId, productId: sku.productId, skuId: sku.id, name: sku.name, qty, unitPrice, discountAmount: 0, subtotal: qty * unitPrice, notes: item.notes || null };
      subtotal += line.subtotal;
      lines.push(line);
    }
    const order = { id: orderId, tenantId: ctx.tenantId, storeId, terminalId: ctx.deviceId, businessDate: at.slice(0, 10), customerTag: body.customerName || body.phone || null, notes: body.notes || null, clientRef: externalReferenceId, source: channel, sourceRef: externalReferenceId, state: 'NEW', paymentState: 'PENDING', orderNumber: `ORD-${orderId}`, actor: ctx.userId, createdBy: ctx.userId, itemCount: lines.length, subtotal, discountTotal: 0, taxTotal: 0, grandTotal: subtotal, createdAt: at, updatedAt: at };
    store.data.orders.set(orderId, order);
    for (const line of lines) store.data.orderItems.set(line.id, line);
    store.data.orderSources.set(sourceKey, { sourceId: store.nextId('source'), orderId, tenantId: ctx.tenantId, storeId, channel, externalReferenceId, createdAt: at });
    runtime.addAudit(ctx, 'ORDER_SOURCE_MANUAL_CREATED', 'ORDER_SOURCE', orderId, null, { id: orderId, storeId, channel, externalReferenceId, state: order.state, grandTotal: order.grandTotal });
    runtime.json(res, 200, { sourceId: store.data.orderSources.get(sourceKey).sourceId, orderId, normalizedChannel: channel, state: order.state, dupCheck: { isDuplicate: false, existingOrderId: null } });
  });

  // POST /api/v1/channels/qr/orders and /channels/line/orders
  // GUEST allowed; tenant resolved from storeSlug+tenantPublicKey (never body.tenant_id)
  // idempotencyKey required; same+same → cached 200; same+diff → 409 CHANNEL_IDEMPOTENCY_CONFLICT
  function channelOrderHandler(channel) {
    return async ({ req, res, ctx }) => {
      const body = await runtime.parseBody(req);

      // Resolve tenant from storeSlug + tenantPublicKey — ignore any body.tenant_id
      let resolvedCtx = ctx;
      if (ctx.role === 'GUEST' || !ctx.tenantId) {
        const slug = body.storeSlug;
        const pubKey = body.tenantPublicKey;
        if (!slug || !pubKey) { runtime.json(res, 403, runtime.error('CHANNEL_AUTH_FAILED', 'storeSlug and tenantPublicKey required for guest channel orders')); return; }
        const matchedStore = [...store.data.stores.values()].find((s) => s.tenantPublicKey === pubKey && (s.slug === slug || s.id === slug));
        if (!matchedStore) { runtime.json(res, 403, runtime.error('CHANNEL_AUTH_FAILED', 'store not found for given storeSlug and tenantPublicKey')); return; }
        resolvedCtx = { ...ctx, tenantId: matchedStore.tenantId, storeId: matchedStore.id, storeIds: [matchedStore.id] };
        runtime.ensureTenantDefaults(resolvedCtx.tenantId);
      } else {
        if (!runtime.requireTenant(res, ctx)) return;
      }

      if (channel === 'LINE' && !body.lineChannelToken) { runtime.json(res, 403, runtime.error('CHANNEL_AUTH_FAILED', 'lineChannelToken required')); return; }

      // idempotencyKey is required for channel orders
      const rawKey = body.idempotencyKey;
      if (!String(rawKey || '').trim()) { runtime.json(res, 400, runtime.error('CHANNEL_IDEMPOTENCY_CONFLICT', 'idempotencyKey required')); return; }

      const storeId = body.storeId || resolvedCtx.storeId;
      if (!storeId) { runtime.json(res, 400, runtime.error('CHANNEL_AUTH_FAILED', 'storeId could not be resolved')); return; }

      if (!Array.isArray(body.items) || body.items.length === 0 || body.items.some((item) => !Number.isInteger(item.qty) || item.qty <= 0)) { runtime.json(res, 400, runtime.error('PAYMENT_UNKNOWN', 'items invalid')); return; }

      const idemKey = `${resolvedCtx.tenantId}:${storeId}:channel:${rawKey}`;
      const fingerprint = runtime.requestFingerprint(body);
      const previous = store.data.idempotency.get(idemKey);
      if (previous) {
        if (previous.fingerprint === fingerprint) { runtime.json(res, 200, { ...previous.response, duplicated: true }); return; }
        runtime.json(res, 409, runtime.error('CHANNEL_IDEMPOTENCY_CONFLICT', 'idempotency key reused with different payload'));
        return;
      }

      const orderId = store.nextId('order');
      const sourceRef = `${channel.toLowerCase()}-${Date.now().toString(16)}`;
      const at = runtime.nowIso();
      const lines = [];
      let subtotal = 0;
      for (const item of body.items) {
        const sku = store.data.skus.get(item.skuId);
        const qty = Number(item.qty);
        const unitPrice = Number(item.price ?? item.unitPrice ?? sku?.price);
        if (!sku || sku.tenantId !== resolvedCtx.tenantId || !Number.isInteger(qty) || qty <= 0 || !Number.isFinite(unitPrice) || unitPrice < 0) { runtime.json(res, 400, runtime.error('ORDER_ITEM_INVALID', 'item invalid')); return; }
        const line = { id: store.nextId('orderItem'), tenantId: resolvedCtx.tenantId, orderId, productId: sku.productId, skuId: sku.id, name: sku.name, qty, unitPrice, discountAmount: 0, subtotal: qty * unitPrice, notes: item.notes || null };
        subtotal += line.subtotal;
        lines.push(line);
      }
      const order = { id: orderId, tenantId: resolvedCtx.tenantId, storeId, terminalId: resolvedCtx.deviceId, businessDate: at.slice(0, 10), source: channel, sourceRef, state: 'CREATED', paymentState: 'PENDING', orderNumber: `ORD-${orderId}`, actor: resolvedCtx.userId, createdBy: resolvedCtx.userId, channelPayload: body, itemCount: lines.length, subtotal, discountTotal: 0, taxTotal: 0, grandTotal: subtotal, createdAt: at, updatedAt: at };
      store.data.orders.set(orderId, order);
      for (const line of lines) store.data.orderItems.set(line.id, line);
      const response = { orderId, source: channel, sourceRef, state: order.state, paymentState: order.paymentState, orderNumber: order.orderNumber, grandTotal: order.grandTotal };
      store.data.idempotency.set(idemKey, { fingerprint, response });
      runtime.addAudit(resolvedCtx, 'CHANNEL_ORDER_CREATED', 'CHANNEL_ORDER', orderId, null, { id: orderId, storeId, channel, state: order.state, grandTotal: order.grandTotal });
      runtime.json(res, 200, response);
    };
  }

  router.add('POST', '/api/v1/channels/qr/orders', channelOrderHandler('QR'));
  router.add('POST', '/api/v1/channels/line/orders', channelOrderHandler('LINE'));

  // PATCH /api/v1/channels/orders/:id/status
  // Role: MANAGER+; audit CHANNEL_ORDER_STATUS_CHANGED with before/after state
  router.add('PATCH', /^\/api\/v1\/channels\/orders\/([\w-]+)\/status$/, async ({ req, res, ctx, params }) => {
    if (!runtime.requireTenant(res, ctx) || !runtime.requireRole(res, ctx, 'MANAGER')) return;
    const order = store.data.orders.get(params[0]);
    if (!order || order.tenantId !== ctx.tenantId) { runtime.json(res, 404, runtime.error('SOURCE_ITEM_CLOSED', 'order not found')); return; }
    if (!runtime.requireStoreScope(res, ctx, order.storeId)) return;
    const body = await runtime.parseBody(req);
    if (!['CONFIRMED', 'CANCELLED', 'VOID'].includes(body.state) || ['DONE', 'CANCELLED'].includes(order.state)) { runtime.json(res, 409, runtime.error('SOURCE_ITEM_CLOSED', 'state update not allowed')); return; }
    const nextState = body.state === 'VOID' ? 'CANCELLED' : body.state;
    const stock = nextState === 'CONFIRMED' ? recalcInventory(runtime, ctx, order, 'decrement') : { success: true };
    if (!stock.success) { runtime.json(res, 409, runtime.error(stock.errorCode, stock.message)); return; }
    const next = { ...order, state: nextState, actor: body.actor || ctx.userId, updatedAt: runtime.nowIso() };
    store.data.orders.set(order.id, next);
    runtime.addAudit(ctx, 'CHANNEL_ORDER_STATUS_CHANGED', 'CHANNEL_ORDER', order.id, { state: order.state, paymentState: order.paymentState }, { state: next.state, paymentState: next.paymentState });
    runtime.json(res, 200, next);
  });

  router.add('GET', '/api/v1/order-hub', async ({ res, ctx, url }) => {
    if (!runtime.requireTenant(res, ctx)) return;
    const storeId = url.searchParams.get('storeId');
    if (!runtime.requireStoreScope(res, ctx, storeId)) return;
    const items = [...store.data.orders.values()].filter((order) => order.tenantId === ctx.tenantId).filter((order) => !storeId || order.storeId === storeId).map((order) => ({ orderId: order.id, source: order.source || 'POS', sourceRef: order.sourceRef || order.clientRef || null, state: order.state, paymentState: order.paymentState, productionState: order.productionState || (['CONFIRMED', 'PAID_CASH', 'PAID_PENDING'].includes(order.state) ? 'QUEUED' : 'WAITING_PAYMENT'), callNumber: order.callNumber || null, workstation: order.workstation || 'KITCHEN', lineItemCount: order.itemCount || orderItems(runtime, order.id).length || order.channelPayload?.items?.length || 0, createdAt: order.createdAt }));
    runtime.json(res, 200, { items, nextCursor: null });
  });

  router.add('GET', '/api/v1/kds/orders', async ({ res, ctx, url }) => {
    if (!runtime.requireTenant(res, ctx) || !runtime.requireRole(res, ctx, 'CASHIER')) return;
    const storeId = url.searchParams.get('storeId') || ctx.storeId;
    if (!runtime.requireStoreScope(res, ctx, storeId)) return;
    const items = [...store.data.orders.values()].filter((order) => order.tenantId === ctx.tenantId && order.storeId === storeId).filter((order) => ['CONFIRMED', 'PAID_CASH', 'PAID_PENDING', 'IN_PROGRESS', 'READY'].includes(order.state) || ['QUEUED', 'IN_PROGRESS', 'READY'].includes(order.productionState)).map((order) => ({ orderId: order.id, orderNumber: order.orderNumber, source: order.source || 'POS', productionState: order.productionState || 'QUEUED', callNumber: order.callNumber || null, workstation: order.workstation || 'KITCHEN', items: orderItems(runtime, order.id).map((item) => ({ name: item.name, qty: item.qty, modifiers: item.modifiers || [], notes: item.notes || null })), promisedAt: order.promisedAt || null, updatedAt: order.updatedAt }));
    runtime.json(res, 200, { items });
  });

  // PATCH /api/v1/kds/orders/:id
  // Role: CASHIER+; KDS_ORDER_STATE_CHANGED audit; reject invalid transitions with KDS_TRANSITION_INVALID
  router.add('PATCH', /^\/api\/v1\/kds\/orders\/([\w-]+)$/, async ({ req, res, ctx, params }) => {
    if (!runtime.requireTenant(res, ctx) || !runtime.requireRole(res, ctx, 'CASHIER')) return;
    const order = store.data.orders.get(params[0]);
    if (!order || order.tenantId !== ctx.tenantId) { runtime.json(res, 404, runtime.error('ORDER_NOT_FOUND', 'order not found')); return; }
    if (!runtime.requireStoreScope(res, ctx, order.storeId)) return;
    const body = await runtime.parseBody(req);
    const targetState = body.productionState;
    if (!['QUEUED', 'IN_PROGRESS', 'READY', 'DONE'].includes(targetState)) { runtime.json(res, 400, runtime.error('KDS_TRANSITION_INVALID', 'productionState invalid')); return; }
    const currentProduction = order.productionState || 'QUEUED';
    const allowed = KDS_TRANSITIONS[currentProduction];
    // Allow setting to same state (idempotent bump) or a valid forward transition
    if (targetState !== currentProduction && !allowed.includes(targetState)) {
      runtime.json(res, 409, runtime.error('KDS_TRANSITION_INVALID', `transition from ${currentProduction} to ${targetState} not allowed`));
      return;
    }
    const next = { ...order, productionState: targetState, workstation: body.workstation || order.workstation || 'KITCHEN', callNumber: body.callNumber || order.callNumber || String(order.id).replace(/\D/g, '').slice(-3).padStart(3, '0'), promisedAt: body.promisedAt || order.promisedAt || null, state: targetState === 'DONE' ? 'DONE' : order.state, updatedAt: runtime.nowIso() };
    store.data.orders.set(order.id, next);
    runtime.addAudit(ctx, 'KDS_ORDER_STATE_CHANGED', 'ORDER', order.id, { productionState: currentProduction, state: order.state }, { productionState: next.productionState, callNumber: next.callNumber, state: next.state });
    runtime.json(res, 200, { orderId: order.id, productionState: next.productionState, callNumber: next.callNumber, state: next.state });
  });

  // POST /api/v1/cash-drawers/open
  // Role: SUPERVISOR+; reject if another drawer OPEN at same terminal → 409 CASHBOX_ALREADY_OPEN
  router.add('POST', '/api/v1/cash-drawers/open', async ({ req, res, ctx }) => {
    if (!runtime.requireTenant(res, ctx)) return;
    if (!runtime.requireRole(res, ctx, 'SUPERVISOR')) {
      runtime.json(res, 403, runtime.error('PERMISSION_DENIED', 'SUPERVISOR role required to open cash drawer'));
      return;
    }
    const body = await runtime.parseBody(req);
    const storeId = body.storeId || ctx.storeId;
    const terminalId = body.terminalId || ctx.deviceId;
    if (!runtime.requireStoreScope(res, ctx, storeId)) return;
    const existing = [...store.data.cashDrawers.values()].find((drawer) => drawer.tenantId === ctx.tenantId && drawer.storeId === storeId && drawer.terminalId === terminalId && drawer.state === 'OPEN');
    if (existing) { runtime.json(res, 409, runtime.error('CASHBOX_ALREADY_OPEN', 'cash drawer already open', { cashDrawerId: existing.id })); return; }
    const openingCash = Number(body.expectedOpeningCash || 0);
    if (!Number.isFinite(openingCash) || openingCash < 0) { runtime.json(res, 400, runtime.error('CASH_SHORTFALL_UNEXPLAINED', 'opening cash invalid')); return; }
    const id = store.nextId('cashDrawer');
    const drawer = { id, tenantId: ctx.tenantId, storeId, terminalId, state: 'OPEN', openingCash, openedBy: body.openedBy || ctx.userId, openedAt: runtime.nowIso(), note: body.note || null, movements: [] };
    store.data.cashDrawers.set(id, drawer);
    runtime.addAudit(ctx, 'CASH_DRAWER_OPENED', 'CASH_DRAWER', id, null, { id, storeId, terminalId, openingCash, openedBy: drawer.openedBy, openedAt: drawer.openedAt });
    runtime.json(res, 200, { cashDrawerId: id, state: drawer.state, openedAt: drawer.openedAt });
  });

  router.add('GET', '/api/v1/cash-drawers/open', async ({ res, ctx, url }) => {
    if (!runtime.requireTenant(res, ctx) || !runtime.requireRole(res, ctx, 'SUPERVISOR')) return;
    const storeId = url.searchParams.get('storeId') || ctx.storeId;
    const terminalId = url.searchParams.get('terminalId') || ctx.deviceId;
    if (!runtime.requireStoreScope(res, ctx, storeId)) return;
    const drawer = [...store.data.cashDrawers.values()].find((item) => item.tenantId === ctx.tenantId && item.storeId === storeId && item.terminalId === terminalId && item.state === 'OPEN');
    runtime.json(res, 200, { cashDrawer: drawer ? { cashDrawerId: drawer.id, state: drawer.state, openedAt: drawer.openedAt, openedBy: drawer.openedBy } : null });
  });

  // POST /api/v1/cash-drawers/close
  // Role: SUPERVISOR+; variance != 0 requires adjustments[] with reason; CASH_SHORTFALL_UNEXPLAINED otherwise
  router.add('POST', '/api/v1/cash-drawers/close', async ({ req, res, ctx }) => {
    if (!runtime.requireTenant(res, ctx)) return;
    if (!runtime.requireRole(res, ctx, 'SUPERVISOR')) {
      runtime.json(res, 403, runtime.error('PERMISSION_DENIED', 'SUPERVISOR role required to close cash drawer'));
      return;
    }
    const body = await runtime.parseBody(req);
    const drawer = store.data.cashDrawers.get(body.cashDrawerId);
    if (!drawer || drawer.tenantId !== ctx.tenantId || drawer.state === 'CLOSED') { runtime.json(res, 404, runtime.error('DRAWER_NOT_FOUND', 'cash drawer not found or already closed')); return; }
    if (!runtime.requireStoreScope(res, ctx, drawer.storeId)) return;
    const closingCash = Number(body.closingCash);
    if (!Number.isFinite(closingCash) || closingCash < 0) { runtime.json(res, 400, runtime.error('CASH_SHORTFALL_UNEXPLAINED', 'closing cash invalid')); return; }
    const cashPayments = paidOrders(runtime, ctx, drawer.storeId, drawer.openedAt, runtime.nowIso()).flatMap((order) => [...store.data.payments.values()].filter((payment) => payment.orderId === order.id && payment.method === 'CASH'));
    const expected = drawer.openingCash + cashPayments.reduce((sum, payment) => sum + payment.amount, 0);
    const adjustments = Array.isArray(body.adjustments) ? body.adjustments : [];
    const variance = closingCash + adjustments.reduce((sum, item) => sum + Number(item.amount || 0), 0) - expected;
    // Non-zero variance requires at least one adjustment entry with a reason
    if (variance !== 0 && (adjustments.length === 0 || adjustments.some((adj) => !adj.reason))) {
      runtime.json(res, 409, runtime.error('CASH_SHORTFALL_UNEXPLAINED', 'non-zero variance requires adjustments[] each with a reason', { variance, expected, closingCash }));
      return;
    }
    const beforeSnap = { id: drawer.id, state: drawer.state, openingCash: drawer.openingCash, openedAt: drawer.openedAt };
    const next = { ...drawer, state: 'CLOSED', closingCash, countedBy: body.countedBy || ctx.userId, adjustments, variance, closedAt: runtime.nowIso() };
    store.data.cashDrawers.set(drawer.id, next);
    runtime.addAudit(ctx, 'CASH_DRAWER_CLOSED', 'CASH_DRAWER', drawer.id, beforeSnap, { id: next.id, state: next.state, closingCash: next.closingCash, variance: next.variance, closedAt: next.closedAt, countedBy: next.countedBy });
    runtime.json(res, 200, { cashDrawerId: drawer.id, state: next.state, cashVariance: variance, auditId: `${drawer.id}:close`, reportUrl: `/api/v1/cash-drawers/${drawer.id}/report` });
  });

  router.add('GET', /^\/api\/v1\/cash-drawers\/([\w-]+)\/report$/, async ({ res, ctx, params }) => {
    if (!runtime.requireTenant(res, ctx) || !runtime.requireRole(res, ctx, 'MANAGER')) return;
    const drawer = store.data.cashDrawers.get(params[0]);
    if (!drawer || drawer.tenantId !== ctx.tenantId) { runtime.json(res, 404, runtime.error('DRAWER_NOT_FOUND', 'cash drawer not found')); return; }
    if (!runtime.requireStoreScope(res, ctx, drawer.storeId)) return;
    runtime.json(res, 200, { cashDrawerId: drawer.id, period: { openedAt: drawer.openedAt, closedAt: drawer.closedAt || null }, openingCash: drawer.openingCash, closingCash: drawer.closingCash || null, variance: drawer.variance || 0, movements: [], signoffs: { cashierId: drawer.openedBy, supervisorId: drawer.countedBy || null } });
  });

  router.add('GET', '/api/v1/inventory/levels', async ({ res, ctx }) => {
    if (!runtime.requireTenant(res, ctx) || !runtime.requireRole(res, ctx, 'MANAGER')) return;
    runtime.json(res, 200, { items: inventoryRows(runtime, ctx) });
  });

  // POST /api/v1/inventory/adjustments
  // Role: MANAGER+; ledger row written BEFORE stockOnHand mutation; INVENTORY_NEGATIVE_AFTER_MOVE; INVENTORY_LEDGER_WRITE_FAILED
  router.add('POST', '/api/v1/inventory/adjustments', async ({ req, res, ctx }) => {
    if (!runtime.requireTenant(res, ctx) || !runtime.requireRole(res, ctx, 'MANAGER')) return;
    const body = await runtime.parseBody(req);
    const storeId = body.storeId || ctx.storeId;
    if (storeId && !runtime.requireStoreScope(res, ctx, storeId)) return;
    const sku = store.data.skus.get(body.skuId);
    const qty = Number(body.qty);
    if (!sku || sku.tenantId !== ctx.tenantId || !Number.isInteger(qty) || qty === 0 || !['RECEIVE', 'WASTE', 'COUNT_ADJUST'].includes(body.reason)) { runtime.json(res, 400, runtime.error('INVENTORY_ADJUSTMENT_INVALID', 'skuId, integer qty, and reason required')); return; }
    const current = getInventory(runtime, ctx, sku.id);
    const next = current.stockOnHand + qty;
    if (next < 0) { runtime.json(res, 409, runtime.error('INVENTORY_NEGATIVE_AFTER_MOVE', 'adjustment would make stock negative', { skuId: sku.id, current: current.stockOnHand, requested: qty })); return; }
    // Write ledger row BEFORE mutating level (ledger is source of truth)
    let movementId;
    try {
      movementId = appendMovement(runtime, ctx, sku, body.referenceId || null, qty > 0 ? 'increment' : 'decrement', Math.abs(qty), current.stockOnHand, next, body.reason);
    } catch {
      runtime.json(res, 500, runtime.error('INVENTORY_LEDGER_WRITE_FAILED', 'failed to write inventory ledger'));
      return;
    }
    setInventory(runtime, ctx, sku.id, next);
    runtime.addAudit(ctx, 'INVENTORY_ADJUSTED', 'INVENTORY_LEDGER', movementId, { skuId: sku.id, stockOnHand: current.stockOnHand }, { skuId: sku.id, stockOnHand: next, qty, reason: body.reason });
    runtime.json(res, 200, { movementId, skuId: sku.id, before: current.stockOnHand, after: next });
  });

  // POST /api/v1/inventory/counts
  // Role: MANAGER+; one ledger row per item delta written BEFORE level mutation
  router.add('POST', '/api/v1/inventory/counts', async ({ req, res, ctx }) => {
    if (!runtime.requireTenant(res, ctx) || !runtime.requireRole(res, ctx, 'MANAGER')) return;
    const body = await runtime.parseBody(req);
    const storeId = body.storeId || ctx.storeId;
    if (storeId && !runtime.requireStoreScope(res, ctx, storeId)) return;
    const rows = Array.isArray(body.items) ? body.items : [];
    if (rows.length === 0) { runtime.json(res, 400, runtime.error('STOCK_COUNT_INVALID', 'items required')); return; }
    const id = store.nextId('stockCount');
    const adjustments = [];
    for (const row of rows) {
      const sku = store.data.skus.get(row.skuId);
      const countedQty = Number(row.countedQty);
      if (!sku || sku.tenantId !== ctx.tenantId || !Number.isInteger(countedQty) || countedQty < 0) { runtime.json(res, 400, runtime.error('STOCK_COUNT_INVALID', 'skuId and countedQty invalid')); return; }
      const current = getInventory(runtime, ctx, sku.id);
      const delta = countedQty - current.stockOnHand;
      if (delta !== 0) {
        // Write ledger BEFORE level mutation
        let movementId;
        try {
          movementId = appendMovement(runtime, ctx, sku, id, delta > 0 ? 'increment' : 'decrement', Math.abs(delta), current.stockOnHand, countedQty, 'COUNT_ADJUST');
        } catch {
          runtime.json(res, 500, runtime.error('INVENTORY_LEDGER_WRITE_FAILED', 'failed to write inventory ledger'));
          return;
        }
        setInventory(runtime, ctx, sku.id, countedQty);
        adjustments.push({ skuId: sku.id, movementId });
      }
    }
    const record = { id, tenantId: ctx.tenantId, storeId: storeId || ctx.storeId, state: 'POSTED', countedBy: ctx.userId, adjustments, createdAt: runtime.nowIso() };
    store.data.stockCounts.set(id, record);
    runtime.addAudit(ctx, 'INVENTORY_COUNT_RECORDED', 'STOCK_COUNT', id, null, { id, storeId: record.storeId, adjustmentCount: adjustments.length, countedBy: record.countedBy });
    runtime.json(res, 200, record);
  });

  // POST /api/v1/inventory/rebuild
  // Role: SUPERVISOR+; rebuilds inventoryLevels projection from inventoryLedger source of truth
  // dryRun:true returns diff only; dryRun:false rewrites projection entries for tenant+store
  router.add('POST', '/api/v1/inventory/rebuild', async ({ req, res, ctx }) => {
    if (!runtime.requireTenant(res, ctx)) return;
    if ((roleRank[ctx.role] || 0) < roleRank['SUPERVISOR']) {
      runtime.json(res, 403, runtime.error('PERMISSION_DENIED', 'SUPERVISOR role required'));
      return;
    }
    const body = await runtime.parseBody(req);
    const storeId = body.storeId;
    if (!runtime.requireStoreScope(res, ctx, storeId)) {
      runtime.json(res, 403, runtime.error('TENANT_SCOPE_VIOLATION', 'storeId not in tenant scope'));
      return;
    }
    const dryRun = body.dryRun === true;

    // Pull all ledger rows for this tenant (ledger has no storeId field — tenant-scoped)
    const ledgerRows = [...store.data.inventoryLedger.values()].filter(
      (row) => row.tenantId === ctx.tenantId
    );

    if (ledgerRows.length === 0) {
      runtime.json(res, 200, {
        store_id: storeId,
        dry_run: dryRun,
        computed: [],
        negative_rows: [],
        warning: 'INVENTORY_REBUILD_EMPTY',
        summary: { sku_count: 0, applied: 0, negative_count: 0 },
      });
      return;
    }

    // Sum movement deltas per skuId from ledger
    const deltaMap = new Map();
    for (const row of ledgerRows) {
      const delta = row.direction === 'increment' ? row.qty : -row.qty;
      deltaMap.set(row.skuId, (deltaMap.get(row.skuId) || 0) + delta);
    }

    const computed = [];
    const negativeRows = [];

    for (const [skuId, computedSum] of deltaMap.entries()) {
      if (computedSum < 0) {
        negativeRows.push({ sku_id: skuId, computed_sum: computedSum });
      }
      const current = getInventory(runtime, ctx, skuId);
      const afterVal = computedSum < 0 ? 0 : computedSum;
      computed.push({
        sku_id: skuId,
        before: current.stockOnHand,
        after: afterVal,
        delta: afterVal - current.stockOnHand,
      });
    }

    if (!dryRun) {
      // Copy-then-set: replace projection entries for this tenant
      for (const entry of computed) {
        const key = `${ctx.tenantId}:${entry.sku_id}`;
        const existing = store.data.inventoryLevels.get(key) || {};
        store.data.inventoryLevels.set(key, {
          ...existing,
          tenantId: ctx.tenantId,
          skuId: entry.sku_id,
          stockOnHand: entry.after,
          updatedAt: runtime.nowIso(),
        });
      }
    }

    const totalDelta = computed.reduce((sum, e) => sum + e.delta, 0);
    const skuCount = computed.length;
    const appliedCount = dryRun ? 0 : skuCount;

    runtime.addAudit(ctx, 'INVENTORY_REBUILT', 'INVENTORY_LEVELS', storeId, null, {
      storeId,
      skuCount,
      totalDelta,
      dryRun,
    });

    runtime.json(res, 200, {
      store_id: storeId,
      dry_run: dryRun,
      computed,
      negative_rows: negativeRows,
      summary: {
        sku_count: skuCount,
        applied: appliedCount,
        negative_count: negativeRows.length,
      },
    });
  });

  // POST /api/v1/inventory/transfers
  // Role: SUPERVISOR+; requireStoreScope on BOTH fromStoreId and toStoreId
  router.add('POST', '/api/v1/inventory/transfers', async ({ req, res, ctx }) => {
    if (!runtime.requireTenant(res, ctx) || !runtime.requireRole(res, ctx, 'SUPERVISOR')) return;
    const body = await runtime.parseBody(req);
    const sku = store.data.skus.get(body.skuId);
    const qty = Number(body.qty);
    if (!sku || sku.tenantId !== ctx.tenantId || !Number.isInteger(qty) || qty <= 0 || !body.fromStoreId || !body.toStoreId) { runtime.json(res, 400, runtime.error('TRANSFER_INVALID', 'skuId, qty, fromStoreId, toStoreId required')); return; }
    // requireStoreScope on both stores
    if (ctx.storeIds.length > 0 && !ctx.storeIds.includes(body.fromStoreId)) {
      runtime.json(res, 403, runtime.error('TRANSFER_STORE_SCOPE_VIOLATION', 'fromStoreId not in tenant scope', { storeId: body.fromStoreId }));
      return;
    }
    if (ctx.storeIds.length > 0 && !ctx.storeIds.includes(body.toStoreId)) {
      runtime.json(res, 403, runtime.error('TRANSFER_STORE_SCOPE_VIOLATION', 'toStoreId not in tenant scope', { storeId: body.toStoreId }));
      return;
    }
    const id = store.nextId('transfer');
    const transfer = { id, tenantId: ctx.tenantId, skuId: sku.id, qty, fromStoreId: body.fromStoreId, toStoreId: body.toStoreId, state: 'RECORDED_MANUAL', createdBy: ctx.userId, createdAt: runtime.nowIso() };
    store.data.transferOrders.set(id, transfer);
    runtime.addAudit(ctx, 'INVENTORY_TRANSFER_CREATED', 'TRANSFER_ORDER', id, null, { id, skuId: sku.id, qty, fromStoreId: body.fromStoreId, toStoreId: body.toStoreId, state: transfer.state });
    runtime.json(res, 200, transfer);
  });
}

module.exports = { register, inventoryRows, recalcInventory };
