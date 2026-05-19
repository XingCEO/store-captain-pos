const { roleRank } = require('../core/runtime');
const { hashPin, verifyPin, hashToken, generateSessionToken } = require('../core/security');
const { requireCurrentPlanCapacity } = require('../core/entitlements');

// In-memory lockout state — intentionally not persisted; resets on restart.
// Keyed by both per-IP and per-userId/tenant to defeat IP rotation.
const loginAttempts = new Map();

const LOCKOUT_MAX_FAILURES = 5;
const LOCKOUT_WINDOW_MS = 5 * 60 * 1000;   // 5 minutes
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes

function getIpLockoutKey(tenantOrEmail, ip) {
  return `ip:${String(tenantOrEmail).toLowerCase()}:${ip}`;
}

function getUserLockoutKey(tenantId, userId) {
  return `user:${String(tenantId).toLowerCase()}:${String(userId).toLowerCase()}`;
}

function checkLockout(key) {
  const entry = loginAttempts.get(key);
  if (!entry) return null;
  const now = Date.now();
  if (now - entry.lastFailedAt > LOCKOUT_WINDOW_MS) {
    loginAttempts.delete(key);
    return null;
  }
  if (entry.attempts >= LOCKOUT_MAX_FAILURES) {
    const retryAfterMs = LOCKOUT_DURATION_MS - (now - entry.lastFailedAt);
    if (retryAfterMs > 0) {
      return { retryAfterSeconds: Math.ceil(retryAfterMs / 1000) };
    }
    loginAttempts.delete(key);
  }
  return null;
}

function recordFailure(key) {
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || now - entry.lastFailedAt > LOCKOUT_WINDOW_MS) {
    loginAttempts.set(key, { attempts: 1, lastFailedAt: now });
  } else {
    loginAttempts.set(key, { attempts: entry.attempts + 1, lastFailedAt: now });
  }
}

function clearLockout(key) {
  loginAttempts.delete(key);
}

function resetLockouts() {
  loginAttempts.clear();
}

function register(router, runtime) {
  const { store } = runtime;

  // ---------------------------------------------------------------------------
  // POST /api/v1/auth/login
  // ---------------------------------------------------------------------------
  router.add('POST', '/api/v1/auth/login', async ({ req, res }) => {
    let body;
    try {
      body = await runtime.parseBody(req);
    } catch {
      runtime.json(res, 400, runtime.error('PAYLOAD_PARSE_ERROR', 'invalid JSON body'));
      return;
    }

    const tenantId = String(body.tenantId || '').trim();
    const requestedRole = String(body.role || 'CASHIER').trim().toUpperCase();
    const storeId = String(body.storeId || 'store-001').trim();
    const ip = req.socket.remoteAddress || '0.0.0.0';

    if (!tenantId || !storeId || !roleRank[requestedRole]) {
      runtime.json(res, 400, runtime.error('LOGIN_INVALID_CREDENTIALS', 'tenantId, storeId, role required'));
      return;
    }

    const ipKey = getIpLockoutKey(tenantId, ip);
    const ipLocked = checkLockout(ipKey);
    if (ipLocked) {
      runtime.json(res, 429, runtime.error('LOGIN_RATE_LIMITED', 'too many failed login attempts', { retryAfterSeconds: ipLocked.retryAfterSeconds }));
      return;
    }

    runtime.ensureTenantDefaults(tenantId);

    const user = [...store.data.users.values()].find(
      (item) => item.tenantId === tenantId &&
                item.role === requestedRole &&
                item.status !== 'DISABLED' &&
                (!body.userId || item.id === body.userId)
    );

    function failAudit(userId, reason, key) {
      const entry = loginAttempts.get(key);
      runtime.addAudit(
        { tenantId, userId: userId || 'unknown', role: user ? user.role : 'GUEST', ip, deviceId: req.headers['x-device-id'] || 'unknown', userAgent: req.headers['user-agent'] || '' },
        'AUTH_LOGIN_FAILED', 'user', userId || 'unknown',
        null,
        { ip, attempts: entry ? entry.attempts : 1, reason }
      );
    }

    if (!user) {
      recordFailure(ipKey);
      failAudit(null, 'user_not_found', ipKey);
      runtime.json(res, 403, runtime.error('LOGIN_INVALID_CREDENTIALS', 'credentials invalid'));
      return;
    }

    // Per-user lockout (defeats IP rotation)
    const userKey = getUserLockoutKey(tenantId, user.id);
    const userLocked = checkLockout(userKey);
    if (userLocked) {
      runtime.json(res, 429, runtime.error('LOGIN_RATE_LIMITED', 'account temporarily locked', { retryAfterSeconds: userLocked.retryAfterSeconds }));
      return;
    }

    // PIN verification via scrypt; supports legacy plaintext for one-shot migration.
    if (body.pin !== undefined && body.pin !== null && body.pin !== '') {
      if (!user.pin || !verifyPin(body.pin, user.pin)) {
        recordFailure(ipKey);
        recordFailure(userKey);
        failAudit(user.id, 'pin_invalid', userKey);
        runtime.json(res, 403, runtime.error('LOGIN_INVALID_CREDENTIALS', 'credentials invalid'));
        return;
      }
    } else if (user.pin) {
      recordFailure(ipKey);
      recordFailure(userKey);
      failAudit(user.id, 'pin_required', userKey);
      runtime.json(res, 403, runtime.error('LOGIN_INVALID_CREDENTIALS', 'credentials invalid'));
      return;
    }

    clearLockout(ipKey);
    clearLockout(userKey);

    const token = generateSessionToken();
    const tokenHash = hashToken(token);
    const at = runtime.nowIso();
    const selectedStore = store.data.stores.get(`${tenantId}:${storeId}`);
    const allowedStoreIds = Array.isArray(user.storeIds) ? user.storeIds : [];
    if (!selectedStore || selectedStore.status === 'DISABLED' || (allowedStoreIds.length > 0 && !allowedStoreIds.includes(storeId))) {
      recordFailure(ipKey);
      recordFailure(userKey);
      failAudit(user.id, 'store_scope_invalid', userKey);
      runtime.json(res, 403, runtime.error('TENANT_NOT_AUTHORIZED', 'store not allowed for user'));
      return;
    }
    const session = {
      tenantId,
      userId: user.id,
      userName: body.userName || user.name,
      role: user.role,
      storeId,
      storeName: body.storeName || selectedStore?.name || storeId,
      storeIds: Array.isArray(user.storeIds) && user.storeIds.length > 0 ? user.storeIds : [storeId],
      deviceId: req.headers['x-device-id'] || 'unknown',
      createdAt: at,
      lastSeenAt: at,
      expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
    };
    // Store sessions keyed by token HASH — plain token never persists.
    store.data.sessions.set(tokenHash, session);
    runtime.addAudit(
      { tenantId, userId: user.id, role: user.role, ip, deviceId: session.deviceId, userAgent: req.headers['user-agent'] || '' },
      'AUTH_LOGIN_SUCCESS', 'user', user.id,
      null,
      { ip, attempts: 0, role: user.role, storeId }
    );
    runtime.json(res, 200, runtime.sessionResponse(session, token));
  });

  // ---------------------------------------------------------------------------
  // GET /api/v1/auth/session
  // ---------------------------------------------------------------------------
  router.add('GET', '/api/v1/auth/session', async ({ res, ctx }) => {
    if (!runtime.requireTenant(res, ctx)) return;
    const session = store.data.sessions.get(ctx.sessionId);
    if (!session) {
      runtime.json(res, 403, runtime.error('LOGIN_INVALID_CREDENTIALS', 'session expired'));
      return;
    }
    runtime.json(res, 200, runtime.sessionResponse(session, ctx.rawToken));
  });

  // ---------------------------------------------------------------------------
  // POST /api/v1/auth/logout
  // ---------------------------------------------------------------------------
  router.add('POST', '/api/v1/auth/logout', async ({ res, ctx }) => {
    if (!runtime.requireTenant(res, ctx)) return;
    const session = store.data.sessions.get(ctx.sessionId);
    if (session) {
      store.data.sessions.delete(ctx.sessionId);
      runtime.addAudit(ctx, 'auth.logout', 'SESSION', ctx.sessionId, session, null);
    }
    runtime.json(res, 200, { ok: true });
  });

  // ---------------------------------------------------------------------------
  // GET /api/v1/audit-logs  — tenant-scoped; filter enforced via ctx.tenantId
  // ---------------------------------------------------------------------------
  router.add('GET', '/api/v1/audit-logs', async ({ res, ctx, url }) => {
    if (!runtime.requireTenant(res, ctx) || !runtime.requireRole(res, ctx, 'MANAGER')) return;
    const page = Number(url.searchParams.get('page') || 1);
    const pageSize = Number(url.searchParams.get('pageSize') || 20);
    const action = url.searchParams.get('action');
    const resourceType = url.searchParams.get('resourceType');
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200) {
      runtime.json(res, 400, runtime.error('PAYLOAD_PARSE_ERROR', 'page/pageSize invalid'));
      return;
    }
    // Strict tenant scope enforced inside queryAuditLogs (WHERE tenant_id = ?
    // for SQLite, RLS policy for Postgres when AUDIT_BACKEND=pg).
    const { items, total } = await runtime.queryAuditLogs({ tenantId: ctx.tenantId, action, resourceType, page, pageSize });
    runtime.json(res, 200, { items, page, pageSize, total });
  });

  // ---------------------------------------------------------------------------
  // GET /api/v1/users
  // ---------------------------------------------------------------------------
  router.add('GET', '/api/v1/users', async ({ res, ctx, url }) => {
    if (!runtime.requireTenant(res, ctx) || !runtime.requireRole(res, ctx, 'MANAGER')) return;
    const search = (url.searchParams.get('search') || '').trim().toLowerCase();
    const items = [...store.data.users.values()]
      .filter((user) => user.tenantId === ctx.tenantId)
      .filter((user) => !search || `${user.name} ${user.email} ${user.role}`.toLowerCase().includes(search))
      .map((user) => ({ id: user.id, name: user.name, email: user.email, role: user.role, storeIds: user.storeIds || ['store-001'], status: user.status || 'ACTIVE', createdAt: user.createdAt }));
    runtime.json(res, 200, { items, page: 1, pageSize: items.length, total: items.length });
  });

  // ---------------------------------------------------------------------------
  // POST /api/v1/users
  // ---------------------------------------------------------------------------
  router.add('POST', '/api/v1/users', async ({ req, res, ctx }) => {
    if (!runtime.requireTenant(res, ctx) || !runtime.requireRole(res, ctx, 'MANAGER')) return;
    const body = await runtime.parseBody(req);
    const role = String(body.role || '').toUpperCase();

    if (!body.name || !roleRank[role]) {
      runtime.json(res, 400, runtime.error('USER_INVALID', 'name and valid role required'));
      return;
    }

    // Role-grant enforcement: actor rank must be >= target role rank.
    // Additionally, only ADMIN may grant ADMIN.
    if (role === 'ADMIN' && roleRank[ctx.role] < roleRank['ADMIN']) {
      runtime.json(res, 403, runtime.error('ROLE_GRANT_FORBIDDEN', 'only ADMIN may grant ADMIN role'));
      return;
    }
    if (roleRank[role] > roleRank[ctx.role]) {
      runtime.json(res, 403, runtime.error('ROLE_GRANT_FORBIDDEN', 'cannot grant a role above your own rank'));
      return;
    }

    // Email uniqueness within tenant
    const email = String(body.email || `${body.name}@${ctx.tenantId}.local`);
    const emailExists = [...store.data.users.values()].some(
      (u) => u.tenantId === ctx.tenantId && u.email === email
    );
    if (emailExists) {
      runtime.json(res, 409, runtime.error('USER_EMAIL_DUPLICATE', 'email already in use within tenant'));
      return;
    }
    if (!requireCurrentPlanCapacity(runtime, res, ctx, { seats: 1 })) return;

    const storeIds = Array.isArray(body.storeIds) && body.storeIds.length > 0 ? body.storeIds.map(String) : [ctx.storeId];
    for (const storeId of storeIds) {
      if (!runtime.requireStoreScope(res, ctx, storeId)) return;
      const existingStore = store.data.stores.get(`${ctx.tenantId}:${storeId}`);
      if (!existingStore || existingStore.status === 'DISABLED') {
        runtime.json(res, 400, runtime.error('STORE_INVALID', 'storeIds must reference active stores in tenant'));
        return;
      }
    }

    const id = store.nextId('user');
    const at = runtime.nowIso();
    const user = {
      id,
      tenantId: ctx.tenantId,
      role,
      name: String(body.name),
      email,
      pin: body.pin ? hashPin(String(body.pin)) : null,
      storeIds,
      status: 'ACTIVE',
      createdAt: at,
      updatedAt: at,
    };
    store.data.users.set(`${ctx.tenantId}:${id}`, user);

    // Audit: USER_CREATED — no PIN/password in after snapshot
    runtime.addAudit(ctx, 'USER_CREATED', 'user', id, null, { id, email: user.email, role, storeIds: user.storeIds });

    runtime.json(res, 200, { id, name: user.name, role, storeIds: user.storeIds, status: user.status });
  });

  // ---------------------------------------------------------------------------
  // PATCH /api/v1/users/:id
  // ---------------------------------------------------------------------------
  router.add('PATCH', /^\/api\/v1\/users\/([\w-]+)$/, async ({ req, res, ctx, params }) => {
    if (!runtime.requireTenant(res, ctx) || !runtime.requireRole(res, ctx, 'MANAGER')) return;

    // CASHIER-rank actors must not patch other users at all
    if (roleRank[ctx.role] < roleRank['MANAGER']) {
      runtime.json(res, 403, runtime.error('PERMISSION_DENIED', 'insufficient role to modify users'));
      return;
    }

    const key = `${ctx.tenantId}:${params[0]}`;
    const current = store.data.users.get(key);
    if (!current) {
      runtime.json(res, 404, runtime.error('USER_NOT_FOUND', 'user not found'));
      return;
    }

    const body = await runtime.parseBody(req);
    const nextRole = body.role ? String(body.role).toUpperCase() : current.role;

    if (!roleRank[nextRole]) {
      runtime.json(res, 400, runtime.error('USER_INVALID', 'role invalid'));
      return;
    }

    // Role-grant enforcement on PATCH
    if (nextRole !== current.role) {
      if (nextRole === 'ADMIN' && roleRank[ctx.role] < roleRank['ADMIN']) {
        runtime.json(res, 403, runtime.error('ROLE_GRANT_FORBIDDEN', 'only ADMIN may grant ADMIN role'));
        return;
      }
      if (roleRank[nextRole] > roleRank[ctx.role]) {
        runtime.json(res, 403, runtime.error('ROLE_GRANT_FORBIDDEN', 'cannot grant a role above your own rank'));
        return;
      }
    }

    const next = {
      ...current,
      name: body.name || current.name,
      email: body.email || current.email,
      role: nextRole,
      pin: body.pin === undefined ? current.pin : (body.pin ? hashPin(String(body.pin)) : null),
      storeIds: Array.isArray(body.storeIds) && body.storeIds.length > 0 ? body.storeIds.map(String) : current.storeIds,
      status: body.status || current.status,
      updatedAt: runtime.nowIso(),
    };
    if (current.status === 'DISABLED' && next.status !== 'DISABLED') {
      if (!requireCurrentPlanCapacity(runtime, res, ctx, { seats: 1 })) return;
    }
    const nextStoreIds = Array.isArray(next.storeIds) ? next.storeIds : [];
    for (const storeId of nextStoreIds) {
      if (!runtime.requireStoreScope(res, ctx, storeId)) return;
      const existingStore = store.data.stores.get(`${ctx.tenantId}:${storeId}`);
      if (!existingStore || existingStore.status === 'DISABLED') {
        runtime.json(res, 400, runtime.error('STORE_INVALID', 'storeIds must reference active stores in tenant'));
        return;
      }
    }
    store.data.users.set(key, next);

    // Primary audit row: USER_UPDATED
    runtime.addAudit(ctx, 'USER_UPDATED', 'user', params[0],
      { role: current.role, status: current.status, storeIds: current.storeIds },
      { role: next.role, status: next.status, storeIds: next.storeIds }
    );

    // High-risk secondary row when role changes
    if (nextRole !== current.role) {
      runtime.addAudit(ctx, 'USER_ROLE_CHANGED', 'user', params[0],
        null,
        { oldRole: current.role, newRole: nextRole, actorId: ctx.userId }
      );
    }

    runtime.json(res, 200, { id: next.id, name: next.name, role: next.role, storeIds: next.storeIds, status: next.status });
  });

  // ---------------------------------------------------------------------------
  // GET /api/v1/stores
  // ---------------------------------------------------------------------------
  router.add('GET', '/api/v1/stores', async ({ res, ctx }) => {
    if (!runtime.requireTenant(res, ctx) || !runtime.requireRole(res, ctx, 'MANAGER')) return;
    runtime.json(res, 200, { items: [...store.data.stores.values()].filter((item) => item.tenantId === ctx.tenantId) });
  });

  router.add('POST', '/api/v1/stores', async ({ req, res, ctx }) => {
    if (!runtime.requireTenant(res, ctx) || !runtime.requireRole(res, ctx, 'ADMIN')) return;
    if (!requireCurrentPlanCapacity(runtime, res, ctx, { stores: 1 })) return;
    const body = await runtime.parseBody(req);
    const name = String(body.name || '').trim();
    if (!name) {
      runtime.json(res, 400, runtime.error('STORE_INVALID', 'name required'));
      return;
    }
    const id = store.nextId('store');
    const at = runtime.nowIso();
    const record = {
      id,
      tenantId: ctx.tenantId,
      name,
      status: 'ACTIVE',
      address: String(body.address || '待填寫地址'),
      phone: String(body.phone || '02-0000-0000'),
      createdAt: at,
      updatedAt: at,
    };
    store.data.stores.set(`${ctx.tenantId}:${id}`, record);
    store.data.storeSettings.set(`${ctx.tenantId}:${id}`, { tenantId: ctx.tenantId, storeId: id, receiptTitle: '店長 AI POS', taxMode: 'SANDBOX', trainingModeAllowed: true, invoiceSandboxOnly: true, autoCompleteOutbox: false, updatedAt: at });
    const actorKey = `${ctx.tenantId}:${ctx.userId}`;
    const actor = store.data.users.get(actorKey);
    if (actor) {
      const currentStoreIds = Array.isArray(actor.storeIds) ? actor.storeIds : [ctx.storeId];
      store.data.users.set(actorKey, { ...actor, storeIds: [...new Set([...currentStoreIds, id])], updatedAt: at });
    }
    runtime.addAudit(ctx, 'STORE_CREATED', 'store', id, null, { id, name, status: record.status });
    runtime.json(res, 200, record);
  });

  // ---------------------------------------------------------------------------
  // GET /api/v1/settings/store
  // ---------------------------------------------------------------------------
  router.add('GET', '/api/v1/settings/store', async ({ res, ctx, url }) => {
    if (!runtime.requireTenant(res, ctx) || !runtime.requireRole(res, ctx, 'MANAGER')) return;
    const storeId = url.searchParams.get('storeId') || ctx.storeId;
    if (!runtime.requireStoreScope(res, ctx, storeId)) return;
    runtime.json(res, 200, store.data.storeSettings.get(`${ctx.tenantId}:${storeId}`) || { tenantId: ctx.tenantId, storeId });
  });

  // ---------------------------------------------------------------------------
  // PATCH /api/v1/settings/store
  // ---------------------------------------------------------------------------
  router.add('PATCH', '/api/v1/settings/store', async ({ req, res, ctx }) => {
    if (!runtime.requireTenant(res, ctx) || !runtime.requireRole(res, ctx, 'MANAGER')) return;
    const body = await runtime.parseBody(req);
    const storeId = body.storeId || ctx.storeId;
    if (!runtime.requireStoreScope(res, ctx, storeId)) return;
    const key = `${ctx.tenantId}:${storeId}`;
    const current = store.data.storeSettings.get(key) || { tenantId: ctx.tenantId, storeId };
    const next = {
      ...current,
      receiptTitle: body.receiptTitle || current.receiptTitle || '店長 AI POS',
      trainingModeAllowed: body.trainingModeAllowed === undefined ? current.trainingModeAllowed !== false : Boolean(body.trainingModeAllowed),
      invoiceSandboxOnly: true,
      updatedAt: runtime.nowIso(),
    };
    store.data.storeSettings.set(key, next);

    // Audit: changed keys only
    const changedKeys = Object.keys(body).filter((k) => k !== 'storeId' && body[k] !== current[k]);
    const beforeSnapshot = Object.fromEntries(changedKeys.map((k) => [k, current[k]]));
    const afterSnapshot = Object.fromEntries(changedKeys.map((k) => [k, next[k]]));

    runtime.addAudit(ctx, 'STORE_SETTINGS_UPDATED', 'store_setting', storeId, beforeSnapshot, afterSnapshot);
    runtime.json(res, 200, next);
  });
}

module.exports = { register, resetLockouts };
