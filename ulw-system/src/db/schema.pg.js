'use strict';

// Postgres schema (drizzle-orm). Reference target for the SQLite-based
// dev/test store. RLS policies live in migrations/0001_rls.sql.

const {
  pgTable, text, jsonb, timestamp, integer, boolean, primaryKey, index,
} = require('drizzle-orm/pg-core');

const tenants = pgTable('tenants', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  status: text('status').notNull().default('ACTIVE'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

const users = pgTable('users', {
  id: text('id').notNull(),
  tenantId: text('tenant_id').notNull(),
  role: text('role').notNull(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  pin: text('pin'),
  storeIds: jsonb('store_ids').$type().notNull().default([]),
  status: text('status').notNull().default('ACTIVE'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.tenantId, table.id] }),
  emailIdx: index('users_tenant_email_idx').on(table.tenantId, table.email),
}));

const sessions = pgTable('sessions', {
  token: text('token').primaryKey(),
  tenantId: text('tenant_id').notNull(),
  userId: text('user_id').notNull(),
  role: text('role').notNull(),
  storeId: text('store_id'),
  storeIds: jsonb('store_ids').$type().notNull().default([]),
  deviceId: text('device_id'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  tenantIdx: index('sessions_tenant_idx').on(table.tenantId),
}));

const stores = pgTable('stores', {
  id: text('id').notNull(),
  tenantId: text('tenant_id').notNull(),
  name: text('name').notNull(),
  status: text('status').notNull().default('ACTIVE'),
  address: text('address'),
  phone: text('phone'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({ pk: primaryKey({ columns: [table.tenantId, table.id] }) }));

const products = pgTable('products', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull(),
  name: text('name').notNull(),
  categoryId: text('category_id'),
  status: text('status').notNull().default('DRAFT'),
  modifiers: jsonb('modifiers').notNull().default([]),
  publishToStoreIds: jsonb('publish_to_store_ids').notNull().default([]),
  version: integer('version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({ tenantIdx: index('products_tenant_idx').on(table.tenantId) }));

const skus = pgTable('skus', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull(),
  productId: text('product_id').notNull(),
  skuCode: text('sku_code').notNull(),
  name: text('name').notNull(),
  price: integer('price').notNull(),
  stockTracked: boolean('stock_tracked').notNull().default(false),
  stock: integer('stock').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({ tenantIdx: index('skus_tenant_idx').on(table.tenantId) }));

const orders = pgTable('orders', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull(),
  storeId: text('store_id').notNull(),
  terminalId: text('terminal_id').notNull(),
  orderNumber: text('order_number').notNull(),
  businessDate: text('business_date').notNull(),
  state: text('state').notNull(),
  paymentState: text('payment_state').notNull(),
  subtotal: integer('subtotal').notNull().default(0),
  discountTotal: integer('discount_total').notNull().default(0),
  taxTotal: integer('tax_total').notNull().default(0),
  grandTotal: integer('grand_total').notNull().default(0),
  createdBy: text('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  paidAt: timestamp('paid_at', { withTimezone: true }),
}, (table) => ({
  tenantStoreIdx: index('orders_tenant_store_idx').on(table.tenantId, table.storeId),
  paidAtIdx: index('orders_paid_at_idx').on(table.paidAt),
}));

const orderItems = pgTable('order_items', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull(),
  orderId: text('order_id').notNull(),
  productId: text('product_id').notNull(),
  skuId: text('sku_id').notNull(),
  name: text('name').notNull(),
  qty: integer('qty').notNull(),
  unitPrice: integer('unit_price').notNull(),
  discountAmount: integer('discount_amount').notNull().default(0),
  modifiers: jsonb('modifiers').notNull().default([]),
  subtotal: integer('subtotal').notNull(),
}, (table) => ({ orderIdx: index('order_items_order_idx').on(table.orderId) }));

const payments = pgTable('payments', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull(),
  orderId: text('order_id').notNull(),
  method: text('method').notNull(),
  paymentProvider: text('payment_provider').notNull(),
  providerTransactionId: text('provider_transaction_id'),
  authorizationCode: text('authorization_code'),
  amount: integer('amount').notNull(),
  status: text('status').notNull(),
  settlementState: text('settlement_state').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({ orderIdx: index('payments_order_idx').on(table.orderId) }));

const invoices = pgTable('invoices', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull(),
  orderId: text('order_id').notNull(),
  storeId: text('store_id').notNull(),
  invoiceNumber: text('invoice_number').notNull(),
  amount: integer('amount').notNull(),
  paymentAmount: integer('payment_amount').notNull().default(0),
  uploadState: text('upload_state').notNull(),
  lifecycleState: text('lifecycle_state').notNull(),
  migVersion: text('mig_version'),
  turnkeyVersion: text('turnkey_version'),
  attempts: integer('attempts').notNull().default(0),
  lastErrorCode: text('last_error_code'),
  environment: text('environment').notNull().default('sandbox'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

const outboxJobs = pgTable('outbox_jobs', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull(),
  storeId: text('store_id'),
  resourceType: text('resource_type').notNull(),
  resourceId: text('resource_id').notNull(),
  state: text('state').notNull(),
  attempts: integer('attempts').notNull().default(0),
  payloadFingerprint: text('payload_fingerprint'),
  lastErrorCode: text('last_error_code'),
  lastErrorMessage: text('last_error_message'),
  nextRetryAt: timestamp('next_retry_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({ stateIdx: index('outbox_state_idx').on(table.state) }));

const auditLogs = pgTable('audit_logs', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull(),
  actor: text('actor').notNull(),
  userId: text('user_id').notNull(),
  userRole: text('user_role').notNull(),
  action: text('action').notNull(),
  resourceType: text('resource_type').notNull(),
  resourceId: text('resource_id'),
  before: jsonb('before'),
  after: jsonb('after'),
  ip: text('ip'),
  deviceId: text('device_id'),
  userAgent: text('user_agent'),
  timestamp: timestamp('timestamp', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  tenantActionIdx: index('audit_tenant_action_idx').on(table.tenantId, table.action),
  timestampIdx: index('audit_timestamp_idx').on(table.timestamp),
}));

const idempotency = pgTable('idempotency', {
  key: text('key').primaryKey(),
  tenantId: text('tenant_id').notNull(),
  fingerprint: text('fingerprint').notNull(),
  response: jsonb('response').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

module.exports = {
  tenants, users, sessions, stores,
  products, skus,
  orders, orderItems, payments, invoices,
  outboxJobs, auditLogs, idempotency,
};
