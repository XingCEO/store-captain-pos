'use strict';

const crypto = require('crypto');

// PIN hashing — scrypt with salt; format: `scrypt$N$r$p$saltHex$hashHex`.
// Verification accepts both modern hashed values and legacy plaintext values
// so existing tenants seeded before this change keep working until next login.

const SCRYPT_N = 16384;
const SCRYPT_r = 8;
const SCRYPT_p = 1;
const KEY_LEN = 64;

function hashPin(pin) {
  if (pin === null || pin === undefined || pin === '') return null;
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pin), salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_r, p: SCRYPT_p });
  return `scrypt$${SCRYPT_N}$${SCRYPT_r}$${SCRYPT_p}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPin(plain, stored) {
  if (!stored) return false;
  if (typeof stored !== 'string') return false;
  if (!stored.startsWith('scrypt$')) {
    // Legacy plaintext — constant-time compare
    return safeEqual(Buffer.from(String(plain)), Buffer.from(String(stored)));
  }
  const parts = stored.split('$');
  if (parts.length !== 6) return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4], 'hex');
  const hash = Buffer.from(parts[5], 'hex');
  const candidate = crypto.scryptSync(String(plain), salt, hash.length, { N, r, p });
  return safeEqual(candidate, hash);
}

function isHashed(value) {
  return typeof value === 'string' && value.startsWith('scrypt$');
}

function hashToken(token) {
  return `sha256:${crypto.createHash('sha256').update(String(token)).digest('hex')}`;
}

function safeEqual(a, b) {
  if (!Buffer.isBuffer(a)) a = Buffer.from(a);
  if (!Buffer.isBuffer(b)) b = Buffer.from(b);
  if (a.length !== b.length) {
    // crypto.timingSafeEqual requires equal length; fall back to byte-compare on min length
    // to keep timing roughly proportional to the longer input.
    const pad = Buffer.alloc(Math.max(a.length, b.length));
    const A = Buffer.concat([a, pad]).subarray(0, pad.length);
    const B = Buffer.concat([b, pad]).subarray(0, pad.length);
    return crypto.timingSafeEqual(A, B) && a.length === b.length;
  }
  return crypto.timingSafeEqual(a, b);
}

function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

module.exports = { hashPin, verifyPin, isHashed, hashToken, safeEqual, generateSessionToken };
