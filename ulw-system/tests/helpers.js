'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

// Background workers spin DB writes that confuse single-request tests; disable
// by default. Individual worker tests override this before requiring server.
if (process.env.DISABLE_BACKGROUND_WORKERS === undefined) {
  process.env.DISABLE_BACKGROUND_WORKERS = '1';
}
if (!process.env.LOG_LEVEL) process.env.LOG_LEVEL = 'silent';

const { createApp } = require('../src/server');

function tempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ulw-test-'));
}

function startTestServer() {
  const dataDir = tempDataDir();
  const publicDir = path.join(__dirname, '..', 'public');
  const app = createApp({ dataDir, publicDir, port: 0 });
  return new Promise((resolve) => {
    app.server.listen(0, '127.0.0.1', () => {
      const { port } = app.server.address();
      resolve({ app, port, dataDir });
    });
  });
}

function stopTestServer({ app, dataDir }) {
  return new Promise((resolve) => {
    app.close();
    setTimeout(() => {
      try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
      resolve();
    }, 50);
  });
}

function request(port, method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: '127.0.0.1', port, path, method,
      headers: { 'Content-Type': 'application/json', ...headers },
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed = data;
        try { parsed = data ? JSON.parse(data) : null; } catch {}
        resolve({ status: res.statusCode, body: parsed, headers: res.headers, raw: data });
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

async function loginAs(port, tenantId, role, storeId = 'store-001') {
  const pins = { ADMIN: '9001', SUPERVISOR: '7001', MANAGER: '5001', CASHIER: '1001' };
  const res = await request(port, 'POST', '/api/v1/auth/login', { tenantId, role, storeId, pin: pins[role] });
  if (res.status !== 200) throw new Error(`login ${role} failed status=${res.status} body=${JSON.stringify(res.body)}`);
  return res.body.token;
}

async function firstSkuId(port, token) {
  const res = await request(port, 'GET', '/api/v1/products', null, { Authorization: `Bearer ${token}` });
  if (!res.body || !res.body.items || !res.body.items.length) throw new Error('no products seeded');
  return res.body.items[0].skuId;
}

function todayBusinessDate() {
  return new Date().toISOString().slice(0, 10);
}

module.exports = {
  startTestServer,
  stopTestServer,
  request,
  loginAs,
  firstSkuId,
  todayBusinessDate,
  tempDataDir,
};
