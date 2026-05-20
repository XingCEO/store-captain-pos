'use strict';

// Security headers + CORS preflight handler. Applied at the HTTP layer in
// server.js BEFORE the router so even rate-limited or 404 responses carry
// the headers.

const DEFAULT_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

function applySecurityHeaders(req, res) {
  // Avoid leaking server identity
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  // Only emit HSTS over TLS / when configured — pointless on plain HTTP since
  // browsers ignore it, and counter-productive in local dev.
  if (process.env.ENABLE_HSTS === '1') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  // CSP on HTML responses (API JSON is also covered for defense-in-depth)
  res.setHeader('Content-Security-Policy', process.env.CSP_HEADER || DEFAULT_CSP);
}

function parseAllowedOrigins(env = process.env.ALLOWED_ORIGINS) {
  if (!env) return [];
  return env.split(',').map((s) => s.trim()).filter(Boolean);
}

function applyCors(req, res, allowedOrigins) {
  const origin = req.headers.origin;
  if (!origin) return;
  if (!allowedOrigins.length) return;
  const allowed = allowedOrigins.includes(origin) || allowedOrigins.includes('*');
  if (!allowed) return;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key, X-Device-Id, X-Request-Id');
  res.setHeader('Access-Control-Max-Age', '600');
}

function handleCorsPreflight(req, res, allowedOrigins) {
  if (req.method !== 'OPTIONS') return false;
  applyCors(req, res, allowedOrigins);
  res.statusCode = 204;
  res.end();
  return true;
}

module.exports = { applySecurityHeaders, applyCors, handleCorsPreflight, parseAllowedOrigins, DEFAULT_CSP };
