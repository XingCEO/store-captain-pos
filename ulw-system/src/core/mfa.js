'use strict';

// RFC 6238 TOTP + base32 helpers. No external dependency — keeps the audit
// surface small. SHA-1 / 6-digit / 30s period to match Google Authenticator,
// Authy, 1Password, Bitwarden, etc.
//
// generateSecret(bytes=20) returns 32 base32 chars (160-bit secret, RFC 4648).
// totp(secret, [t]) returns the current 6-digit code.
// verifyTotp(code, secret, [window=1]) accepts ±window 30s steps for clock skew.
// provisioningUri(label, secret, issuer) returns otpauth://… for QR encoding.

const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(input) {
  const s = String(input).replace(/=+$/, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out = [];
  for (const c of s) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) continue; // skip pad / illegal
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function generateSecret(bytes = 20) {
  return base32Encode(crypto.randomBytes(bytes));
}

function totp(secretBase32, t = Math.floor(Date.now() / 1000), step = 30, digits = 6) {
  const counter = Math.floor(t / step);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const key = base32Decode(secretBase32);
  const h = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = h[h.length - 1] & 0x0f;
  const code = ((h[offset] & 0x7f) << 24)
             | ((h[offset + 1] & 0xff) << 16)
             | ((h[offset + 2] & 0xff) << 8)
             |  (h[offset + 3] & 0xff);
  return String(code % (10 ** digits)).padStart(digits, '0');
}

// window=1 means ±30s tolerance for clock skew.
function verifyTotp(code, secretBase32, window = 1) {
  if (!code || !secretBase32) return false;
  const expected = String(code).trim();
  const now = Math.floor(Date.now() / 1000);
  for (let i = -window; i <= window; i += 1) {
    if (totp(secretBase32, now + i * 30) === expected) return true;
  }
  return false;
}

function provisioningUri(label, secret, issuer = 'StoreCaptainPOS') {
  const enc = encodeURIComponent;
  return `otpauth://totp/${enc(issuer)}:${enc(label)}?secret=${secret}&issuer=${enc(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

module.exports = { base32Encode, base32Decode, generateSecret, totp, verifyTotp, provisioningUri };
