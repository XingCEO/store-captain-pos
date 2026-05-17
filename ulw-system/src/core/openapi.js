'use strict';

// Minimal OpenAPI 3.0 spec describing the public surface used by tests + UI.
// Hand-maintained — drift is caught by the openapi.test.js smoke that
// validates the spec parses and key paths are present.

const spec = {
  openapi: '3.0.3',
  info: {
    title: '店長 AI POS API',
    version: '0.1.0',
    description: 'Demo / sandbox REST surface for ulw-system. Not production-certified for 電子發票 or 金流.',
  },
  servers: [{ url: '/' }],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer' },
    },
    schemas: {
      Error: {
        type: 'object',
        properties: {
          errorCode: { type: 'string' },
          message: { type: 'string' },
        },
        required: ['errorCode', 'message'],
      },
      LoginRequest: {
        type: 'object',
        required: ['tenantId', 'role', 'storeId'],
        properties: {
          tenantId: { type: 'string' },
          role: { type: 'string', enum: ['ADMIN', 'SUPERVISOR', 'MANAGER', 'CASHIER'] },
          storeId: { type: 'string' },
          pin: { type: 'string' },
        },
      },
      LoginResponse: {
        type: 'object',
        properties: {
          token: { type: 'string' },
          tenantId: { type: 'string' },
          userId: { type: 'string' },
          role: { type: 'string' },
          storeId: { type: 'string' },
          expiresAt: { type: 'string', format: 'date-time' },
        },
      },
    },
  },
  paths: {
    '/health': { get: { summary: 'Health probe', responses: { 200: { description: 'OK' } } } },
    '/metrics': { get: { summary: 'Prometheus metrics', responses: { 200: { description: 'text/plain Prom format' } } } },
    '/api/v1/auth/login': {
      post: {
        summary: 'Tenant login',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/LoginRequest' } } },
        },
        responses: {
          200: { description: 'Token', content: { 'application/json': { schema: { $ref: '#/components/schemas/LoginResponse' } } } },
          400: { description: 'Bad input' },
          403: { description: 'Bad credentials' },
          429: { description: 'Rate limited' },
        },
      },
    },
    '/api/v1/orders': {
      post: {
        summary: 'Create POS order',
        security: [{ bearerAuth: [] }],
        responses: {
          201: { description: 'DRAFT order created' },
          400: { description: 'Bad item / idempotency payload' },
          403: { description: 'Tenant or store scope error' },
          409: { description: 'Idempotency conflict' },
        },
      },
    },
    '/api/v1/orders/{id}/pay/manual': {
      post: {
        summary: 'Manual cash / card payment',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Paid' }, 400: { description: 'Invalid payment' }, 409: { description: 'Order state' } },
      },
    },
    '/api/v1/orders/{id}/void': {
      post: {
        summary: 'Void unpaid order',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'VOIDED' }, 409: { description: 'Already paid or voided' } },
      },
    },
    '/api/v1/products': {
      get: {
        summary: 'List products visible to tenant + store',
        security: [{ bearerAuth: [] }],
        responses: { 200: { description: 'items' } },
      },
    },
    '/api/v1/audit-logs': {
      get: {
        summary: 'Tenant-scoped audit log query',
        security: [{ bearerAuth: [] }],
        responses: { 200: { description: 'items' }, 403: { description: 'Role too low' } },
      },
    },
    '/api/v1/invoices/health': {
      get: {
        summary: 'Sandbox invoice health',
        security: [{ bearerAuth: [] }],
        responses: { 200: { description: 'sandbox response with x-environment header' } },
      },
    },
    '/openapi.json': { get: { summary: 'This document', responses: { 200: { description: 'OpenAPI 3.0' } } } },
  },
};

module.exports = { spec };
