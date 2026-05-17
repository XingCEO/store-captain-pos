// k6 load script: login → order create → manual pay → audit-logs read.
//
// Run:  k6 run scripts/load/order-pay.k6.js
//       BASE=http://staging.example  TENANT=load-tenant  k6 run …
//
// Thresholds:
//   * http_req_duration p99 < 500ms
//   * checks pass rate > 99%

import http from 'k6/http';
import { sleep, check } from 'k6';
import { Trend, Counter } from 'k6/metrics';

const BASE = __ENV.BASE || 'http://localhost:3100';
const TENANT = __ENV.TENANT || 'k6-load';
const STORE = __ENV.STORE || 'store-001';

const orderLatency = new Trend('order_create_ms');
const payLatency = new Trend('pay_manual_ms');
const orderCreated = new Counter('orders_created');

export const options = {
  scenarios: {
    burst: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 20 },
        { duration: '2m',  target: 100 },
        { duration: '30s', target: 0 },
      ],
      gracefulRampDown: '15s',
    },
  },
  thresholds: {
    http_req_duration: ['p(99)<500'],
    checks: ['rate>0.99'],
    'order_create_ms': ['p(99)<400'],
    'pay_manual_ms':   ['p(99)<400'],
  },
};

export function setup() {
  const login = http.post(`${BASE}/api/v1/auth/login`, JSON.stringify({
    tenantId: TENANT, role: 'ADMIN', storeId: STORE,
  }), { headers: { 'Content-Type': 'application/json' } });
  check(login, { 'login OK': (r) => r.status === 200 });
  const token = login.json('token');

  const products = http.get(`${BASE}/api/v1/products`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const skuId = products.json('items.0.skuId');
  return { token, skuId };
}

export default function (data) {
  const { token, skuId } = data;
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  const idemKey = `k6-${__VU}-${__ITER}-${Date.now()}`;
  const body = {
    storeId: STORE, terminalId: `term-${__VU}`, businessDate: new Date().toISOString().slice(0, 10),
    items: [{ skuId, name: 'load', qty: 1, unitPrice: 55 }],
    idempotencyKey: idemKey,
  };

  const t0 = Date.now();
  const create = http.post(`${BASE}/api/v1/orders`, JSON.stringify(body), { headers });
  orderLatency.add(Date.now() - t0);
  check(create, { 'order 201': (r) => r.status === 201 });
  if (create.status !== 201) { sleep(1); return; }
  orderCreated.add(1);

  const orderId = create.json('id');
  const t1 = Date.now();
  const pay = http.post(`${BASE}/api/v1/orders/${orderId}/pay/manual`, JSON.stringify({
    amount: 55, paymentMethod: 'CASH', cashReceived: 55,
  }), { headers });
  payLatency.add(Date.now() - t1);
  check(pay, { 'pay 200': (r) => r.status === 200 });

  sleep(0.5);
}
