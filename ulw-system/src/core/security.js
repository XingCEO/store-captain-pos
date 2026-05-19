'use strict';

const crypto = require('crypto');

// PIN hashing — scrypt with salt; format: `scrypt$N$r$p$saltHex$hashHex`.
// Verification accepts both modern hashed values and legacy plaintext values
// so existing tenants seeded before this change keep working until next login.
// When PIN_PEPPER env is set, it is appended to the PIN before scrypt so a
// DB leak alone (without the env-only pepper) can't be brute-forced on the
// tiny 4-digit keyspace. Existing hashes are still verifiable in dev where
// PIN_PEPPER is unset.

const SCRYPT_N = 16384;
const SCRYPT_r = 8;
const SCRYPT_p = 1;
const KEY_LEN = 64;

function pepper() {
  return process.env.PIN_PEPPER || '';
}

function hashPin(pin) {
  if (pin === null || pin === undefined || pin === '') return null;
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pin) + pepper(), salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_r, p: SCRYPT_p });
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
  const candidate = crypto.scryptSync(String(plain) + pepper(), salt, hash.length, { N, r, p });
  return safeEqual(candidate, hash);
}

// MFA secret at-rest protection. When MFA_KEK env is set (32-byte hex), we
// encrypt the TOTP secret with AES-256-GCM before storing; on read we detect
// the `aes-gcm-v1$` prefix and decrypt. Without the env var, secrets are
// stored plaintext base32 (legacy path) — production MUST set MFA_KEK.
function kekBuffer() {
  const hex = process.env.MFA_KEK;
  if (!hex || hex.length !== 64) return null;
  try { return Buffer.from(hex, 'hex'); } catch { return null; }
}

function encryptSecret(plaintext) {
  const kek = kekBuffer();
  if (!kek) return plaintext; // legacy / dev
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', kek, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `aes-gcm-v1$${iv.toString('hex')}$${tag.toString('hex')}$${ct.toString('hex')}`;
}

function decryptSecret(stored) {
  if (typeof stored !== 'string' || !stored.startsWith('aes-gcm-v1$')) return stored;
  const kek = kekBuffer();
  if (!kek) {
    // Encrypted blob present but no key in env — refuse to silently bypass.
    throw new Error('MFA_KEK env missing but stored secret is encrypted');
  }
  const [, ivHex, tagHex, ctHex] = stored.split('$');
  const decipher = crypto.createDecipheriv('aes-256-gcm', kek, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(ctHex, 'hex')), decipher.final()]).toString('utf8');
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

module.exports = { hashPin, verifyPin, isHashed, hashToken, safeEqual, generateSessionToken, encryptSecret, decryptSecret };
