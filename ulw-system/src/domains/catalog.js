const { roleRank } = require('../core/runtime');

function productList(runtime, ctx, includeDraft = false, storeId = null) {
  const products = [];
  for (const product of runtime.store.data.products.values()) {
    if (product.tenantId !== ctx.tenantId) continue;
    if (!includeDraft && product.status !== 'PUBLISHED') continue;
    if (storeId && product.publishToStoreIds?.length > 0 && !product.publishToStoreIds.includes(storeId)) continue;
    const skus = product.skus.map((skuId) => runtime.store.data.skus.get(skuId)).filter(Boolean);
    for (const sku of skus) {
      products.push({
        productId: product.id,
        productName: product.name,
        categoryId: product.categoryId,
        skuId: sku.id,
        skuCode: sku.skuCode,
        price: sku.price,
        stockTracked: sku.stockTracked,
        status: product.status,
        modifiers: product.modifiers || [],
        updatedAt: product.updatedAt,
      });
    }
  }
  return products;
}

function requireSupervisor(res, ctx, runtime) {
  if ((roleRank[ctx.role] || 0) < roleRank['SUPERVISOR']) {
    runtime.json(res, 403, runtime.error('PERMISSION_DENIED', 'SUPERVISOR role or above required'));
    return false;
  }
  return true;
}

function register(router, runtime) {
  const { store } = runtime;

  function listHandler({ res, ctx, url }) {
    if (!runtime.requireTenant(res, ctx)) return;
    const includeDraft = url.searchParams.get('includeDraft') === 'true';
    const storeId = url.searchParams.get('storeId') || ctx.storeId;
    if (!runtime.requireStoreScope(res, ctx, storeId)) return;
    const items = productList(runtime, ctx, includeDraft, storeId);
    runtime.json(res, 200, url.pathname.endsWith('/published') ? { menus: items } : { items });
  }

  router.add('GET', '/api/v1/products', listHandler);
  router.add('GET', '/api/v1/catalog/menus/published', listHandler);

  router.add('GET', '/api/v1/catalog/categories', async ({ res, ctx }) => {
    if (!runtime.requireTenant(res, ctx)) return;
    const rows = new Map();
    for (const product of store.data.products.values()) {
      if (product.tenantId !== ctx.tenantId) continue;
      const current = rows.get(product.categoryId) || { id: product.categoryId, name: product.categoryId, productCount: 0 };
      current.productCount += 1;
      rows.set(product.categoryId, current);
    }
    runtime.json(res, 200, { items: [...rows.values()] });
  });

  router.add('GET', '/api/v1/catalog/export', async ({ res, ctx }) => {
    if (!runtime.requireTenant(res, ctx) || !runtime.requireRole(res, ctx, 'MANAGER')) return;
    runtime.json(res, 200, { products: productList(runtime, ctx, true), priceOverrides: [...store.data.productPrices.values()].filter((item) => item.tenantId === ctx.tenantId) });
  });

  // POST /api/v1/catalog/products — MANAGER+
  router.add('POST', '/api/v1/catalog/products', async ({ req, res, ctx }) => {
    if (!runtime.requireTenant(res, ctx) || !runtime.requireRole(res, ctx, 'MANAGER')) return;
    let body;
    try {
      body = await runtime.parseBody(req);
    } catch {
      runtime.json(res, 400, runtime.error('PAYLOAD_PARSE_ERROR', 'invalid JSON body'));
      return;
    }
    const { name, categoryId, status = 'DRAFT', skus = [], modifiers = [], publishToStoreIds = [], idempotencyKey } = body;

    // Idempotency check
    if (idempotencyKey && String(idempotencyKey).trim()) {
      const idemKey = `${ctx.tenantId}:catalog:product_create:${idempotencyKey}`;
      const previous = store.data.idempotency.get(idemKey);
      if (previous) {
        if (previous.fingerprint === runtime.requestFingerprint(body)) {
          runtime.json(res, 200, { ...previous.response, duplicated: true });
        } else {
          runtime.json(res, 409, runtime.error('CATALOG_IDEMPOTENCY_CONFLICT', 'idempotency key payload mismatch'));
        }
        return;
      }
    }

    if (!name || !String(name).trim()) {
      runtime.json(res, 400, runtime.error('MODIFIER_RULE_INVALID', 'name required'));
      return;
    }
    if (!categoryId || !String(categoryId).trim()) {
      runtime.json(res, 400, runtime.error('CATEGORY_NOT_FOUND', 'categoryId required'));
      return;
    }
    if (!Array.isArray(skus) || skus.length === 0) {
      runtime.json(res, 400, runtime.error('MODIFIER_RULE_INVALID', 'skus required'));
      return;
    }
    for (const sku of skus) {
      if (!sku || !String(sku.skuCode || '').trim() || typeof sku.price !== 'number' || sku.price < 0 || sku.price > 999999) {
        runtime.json(res, 400, runtime.error('PRICE_OUT_OF_RANGE', 'sku price must be 0–999999'));
        return;
      }
    }
    if ([...store.data.products.values()].some((item) => item.tenantId === ctx.tenantId && item.name === name)) {
      runtime.json(res, 409, runtime.error('PRODUCT_NAME_DUPLICATE', 'product name already exists'));
      return;
    }
    const storeIds = publishToStoreIds.map(String);
    for (const sid of storeIds) {
      if (!runtime.requireStoreScope(res, ctx, sid)) return;
    }
    const productId = store.nextId('product');
    const at = runtime.nowIso();
    const skuIds = [];
    for (const sku of skus) {
      const skuId = store.nextId('sku');
      store.data.skus.set(skuId, { id: skuId, tenantId: ctx.tenantId, productId, skuCode: String(sku.skuCode), name: sku.name || name, price: sku.price, stockTracked: Boolean(sku.stockTracked), stock: Number.isFinite(Number(sku.initialStock)) ? Number(sku.initialStock) : 0, createdAt: at, updatedAt: at });
      skuIds.push(skuId);
    }
    const product = { id: productId, tenantId: ctx.tenantId, name: String(name), categoryId: String(categoryId), status, skus: skuIds, modifiers, publishToStoreIds: storeIds, version: 1, rest: {}, createdAt: at, updatedAt: at };
    store.data.products.set(productId, product);
    runtime.addAudit(ctx, 'PRODUCT_CREATED', 'PRODUCT', productId, null, product);
    const response = { productId, version: product.version, status: product.status, createdAt: product.createdAt };
    if (idempotencyKey && String(idempotencyKey).trim()) {
      const idemKey = `${ctx.tenantId}:catalog:product_create:${idempotencyKey}`;
      store.data.idempotency.set(idemKey, { fingerprint: runtime.requestFingerprint(body), response });
    }
    runtime.json(res, 201, response);
  });

  // PATCH /api/v1/catalog/products/:id — MANAGER+
  router.add('PATCH', /^\/api\/v1\/catalog\/products\/([\w-]+)$/, async ({ req, res, ctx, params }) => {
    if (!runtime.requireTenant(res, ctx) || !runtime.requireRole(res, ctx, 'MANAGER')) return;
    const productId = params[0];
    const current = store.data.products.get(productId);
    if (!current || current.tenantId !== ctx.tenantId) {
      runtime.json(res, 404, runtime.error('PRODUCT_NOT_FOUND', 'product not found'));
      return;
    }
    if (!runtime.requireStoreScope(res, ctx, current.publishToStoreIds?.[0])) return;
    let body;
    try {
      body = await runtime.parseBody(req);
    } catch {
      runtime.json(res, 400, runtime.error('PAYLOAD_PARSE_ERROR', 'invalid JSON body'));
      return;
    }
    const { idempotencyKey, publishToStoreIds: newStoreIds, status: newStatus } = body;

    // Idempotency check
    if (idempotencyKey && String(idempotencyKey).trim()) {
      const idemKey = `${ctx.tenantId}:catalog:product_update:${idempotencyKey}`;
      const previous = store.data.idempotency.get(idemKey);
      if (previous) {
        if (previous.fingerprint === runtime.requestFingerprint(body)) {
          runtime.json(res, 200, { ...previous.response, duplicated: true });
        } else {
          runtime.json(res, 409, runtime.error('CATALOG_IDEMPOTENCY_CONFLICT', 'idempotency key payload mismatch'));
        }
        return;
      }
    }

    // Validate any new storeIds in publishToStoreIds
    if (Array.isArray(newStoreIds)) {
      for (const sid of newStoreIds.map(String)) {
        if (!runtime.requireStoreScope(res, ctx, sid)) return;
      }
    }

    // Publish conflict: reject if publishing a version older than currently published
    const incomingVersion = typeof body.version === 'number' ? body.version : null;
    if (newStatus === 'PUBLISHED' && incomingVersion !== null && incomingVersion < current.version) {
      runtime.json(res, 409, runtime.error('PUBLISH_CONFLICT', 'incoming version is older than current published version'));
      return;
    }

    // Validate modifier rules if provided
    if (body.modifiers !== undefined) {
      if (!Array.isArray(body.modifiers)) {
        runtime.json(res, 400, runtime.error('MODIFIER_RULE_INVALID', 'modifiers must be an array'));
        return;
      }
      for (const mod of body.modifiers) {
        if (!mod || typeof mod.groupName !== 'string' || !['single', 'multi'].includes(mod.type) || !Array.isArray(mod.options)) {
          runtime.json(res, 400, runtime.error('MODIFIER_RULE_INVALID', 'each modifier must have groupName, type (single|multi), options array'));
          return;
        }
      }
    }

    const next = { ...current, ...body, id: current.id, tenantId: current.tenantId, version: current.version + 1, updatedAt: runtime.nowIso() };
    store.data.products.set(productId, next);
    runtime.addAudit(ctx, 'PRODUCT_UPDATED', 'PRODUCT', productId, current, next);
    const response = { productId, version: next.version, status: next.status, updatedAt: next.updatedAt };
    if (idempotencyKey && String(idempotencyKey).trim()) {
      const idemKey = `${ctx.tenantId}:catalog:product_update:${idempotencyKey}`;
      store.data.idempotency.set(idemKey, { fingerprint: runtime.requestFingerprint(body), response });
    }
    runtime.json(res, 200, response);
  });

  // POST /api/v1/catalog/prices/batch — SUPERVISOR+
  router.add('POST', '/api/v1/catalog/prices/batch', async ({ req, res, ctx }) => {
    if (!runtime.requireTenant(res, ctx)) return;
    if (!requireSupervisor(res, ctx, runtime)) return;
    let body;
    try {
      body = await runtime.parseBody(req);
    } catch {
      runtime.json(res, 400, runtime.error('PAYLOAD_PARSE_ERROR', 'invalid JSON body'));
      return;
    }
    const { idempotencyKey } = body;

    // Idempotency check
    if (idempotencyKey && String(idempotencyKey).trim()) {
      const idemKey = `${ctx.tenantId}:catalog:prices_batch:${idempotencyKey}`;
      const previous = store.data.idempotency.get(idemKey);
      if (previous) {
        if (previous.fingerprint === runtime.requestFingerprint(body)) {
          runtime.json(res, 200, { ...previous.response, duplicated: true });
        } else {
          runtime.json(res, 409, runtime.error('CATALOG_IDEMPOTENCY_CONFLICT', 'idempotency key payload mismatch'));
        }
        return;
      }
    }

    const updates = Array.isArray(body.productPriceUpdates) ? body.productPriceUpdates : [];
    if (updates.length === 0) {
      runtime.json(res, 400, runtime.error('PRICE_OUT_OF_RANGE', 'productPriceUpdates required'));
      return;
    }

    let appliedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;
    const errors = [];

    for (const update of updates) {
      // Tenant scope check per storeId in update
      if (update.storeId) {
        if (!runtime.requireStoreScope(res, ctx, update.storeId)) return;
      }
      const sku = store.data.skus.get(update.skuId);
      if (!sku || sku.tenantId !== ctx.tenantId) {
        errors.push({ skuId: update?.skuId, code: 'PRODUCT_NOT_FOUND', message: 'sku not found for tenant' });
        errorCount += 1;
        continue;
      }
      if (typeof update.price !== 'number' || update.price < 0 || update.price > 999999) {
        errors.push({ skuId: update?.skuId, code: 'PRICE_OUT_OF_RANGE', message: 'price must be 0–999999' });
        errorCount += 1;
        continue;
      }
      store.data.productPrices.set(`${ctx.tenantId}:${update.storeId}:${sku.id}`, { tenantId: ctx.tenantId, storeId: update.storeId, skuId: sku.id, price: update.price, currency: update.currency || 'TWD', updatedAt: runtime.nowIso(), updatedBy: ctx.userId });
      appliedCount += 1;
    }

    skippedCount = updates.length - appliedCount - errorCount;
    const batchId = `batch-${Date.now()}`;
    runtime.addAudit(ctx, 'PRICES_BATCH_APPLIED', 'PRICE_BATCH', batchId, null, { appliedCount, skippedCount, errorCount, errors });
    const response = { batchId, applied: appliedCount, skipped: skippedCount, errors };
    if (idempotencyKey && String(idempotencyKey).trim()) {
      const idemKey = `${ctx.tenantId}:catalog:prices_batch:${idempotencyKey}`;
      store.data.idempotency.set(idemKey, { fingerprint: runtime.requestFingerprint(body), response });
    }
    runtime.json(res, 200, response);
  });

  // POST /api/v1/catalog/import — SUPERVISOR+
  router.add('POST', '/api/v1/catalog/import', async ({ req, res, ctx }) => {
    if (!runtime.requireTenant(res, ctx)) return;
    if (!requireSupervisor(res, ctx, runtime)) return;
    let body;
    try {
      body = await runtime.parseBody(req);
    } catch {
      runtime.json(res, 400, runtime.error('IMPORT_PAYLOAD_INVALID', 'invalid JSON body'));
      return;
    }
    const { idempotencyKey } = body;

    // Idempotency check
    if (idempotencyKey && String(idempotencyKey).trim()) {
      const idemKey = `${ctx.tenantId}:catalog:import:${idempotencyKey}`;
      const previous = store.data.idempotency.get(idemKey);
      if (previous) {
        if (previous.fingerprint === runtime.requestFingerprint(body)) {
          runtime.json(res, 200, { ...previous.response, duplicated: true });
        } else {
          runtime.json(res, 409, runtime.error('CATALOG_IDEMPOTENCY_CONFLICT', 'idempotency key payload mismatch'));
        }
        return;
      }
    }

    const rows = Array.isArray(body.products) ? body.products : [];
    if (rows.length === 0 || rows.length > 200) {
      runtime.json(res, 400, runtime.error('IMPORT_PAYLOAD_INVALID', '1–200 products required'));
      return;
    }

    // Validate all rows before mutating
    for (const row of rows) {
      if (!row.name || !row.skuCode || typeof row.price !== 'number' || row.price < 0 || row.price > 999999) {
        runtime.json(res, 400, runtime.error('IMPORT_PAYLOAD_INVALID', 'each row requires name, skuCode, and price 0–999999'));
        return;
      }
      const storeIds = Array.isArray(row.publishToStoreIds) ? row.publishToStoreIds.map(String) : [];
      for (const sid of storeIds) {
        if (!runtime.requireStoreScope(res, ctx, sid)) return;
      }
    }

    let appliedCount = 0;
    let errorCount = 0;
    const created = [];

    for (const row of rows) {
      const productId = store.nextId('product');
      const skuId = store.nextId('sku');
      const at = runtime.nowIso();
      const storeIds = Array.isArray(row.publishToStoreIds) ? row.publishToStoreIds.map(String) : (ctx.storeId ? [ctx.storeId] : []);
      store.data.skus.set(skuId, { id: skuId, tenantId: ctx.tenantId, productId, skuCode: String(row.skuCode), name: row.name, price: row.price, stockTracked: Boolean(row.stockTracked), stock: Number(row.initialStock || 0), createdAt: at, updatedAt: at });
      store.data.products.set(productId, { id: productId, tenantId: ctx.tenantId, name: String(row.name), categoryId: String(row.categoryId || 'food'), status: row.status || 'PUBLISHED', skus: [skuId], modifiers: Array.isArray(row.modifiers) ? row.modifiers : [], publishToStoreIds: storeIds, version: 1, rest: {}, createdAt: at, updatedAt: at });
      created.push({ productId, skuId });
      appliedCount += 1;
    }

    const batchId = `batch-${Date.now()}`;
    runtime.addAudit(ctx, 'CATALOG_IMPORTED', 'PRODUCT', batchId, null, { appliedCount, skippedCount: 0, errorCount, createdCount: created.length });
    const response = { created, importId: batchId };
    if (idempotencyKey && String(idempotencyKey).trim()) {
      const idemKey = `${ctx.tenantId}:catalog:import:${idempotencyKey}`;
      store.data.idempotency.set(idemKey, { fingerprint: runtime.requestFingerprint(body), response });
    }
    runtime.json(res, 200, response);
  });
}

module.exports = { register, productList };
