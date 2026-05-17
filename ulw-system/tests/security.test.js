'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { hashPin, verifyPin, isHashed, hashToken, safeEqual, generateSessionToken } = require('../src/core/security');

test('hashPin produces scrypt format', () => {
  const h = hashPin('1234');
  assert.match(h, /^scrypt\$16384\$8\$1\$[0-9a-f]+\$[0-9a-f]+$/);
});

test('verifyPin matches correct PIN and rejects wrong', () => {
  const h = hashPin('correct-horse');
  assert.equal(verifyPin('correct-horse', h), true);
  assert.equal(verifyPin('battery-staple', h), false);
});

test('verifyPin accepts legacy plaintext (one-shot migration)', () => {
  // Pre-hash deployment: stored PIN is plaintext "1234"
  assert.equal(verifyPin('1234', '1234'), true);
  assert.equal(verifyPin('wrong', '1234'), false);
});

test('isHashed distinguishes scrypt from plaintext', () => {
  assert.equal(isHashed(hashPin('x')), true);
  assert.equal(isHashed('1234'), false);
  assert.equal(isHashed(null), false);
});

test('hashToken yields deterministic sha256 prefix', () => {
  const a = hashToken('abc');
  const b = hashToken('abc');
  assert.equal(a, b);
  assert.match(a, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(a, hashToken('abd'));
});

test('safeEqual is constant-time correct on equal lengths', () => {
  assert.equal(safeEqual(Buffer.from('abc'), Buffer.from('abc')), true);
  assert.equal(safeEqual(Buffer.from('abc'), Buffer.from('abd')), false);
});

test('safeEqual rejects mismatched lengths', () => {
  assert.equal(safeEqual(Buffer.from('a'), Buffer.from('aa')), false);
});

test('generateSessionToken returns 64-hex string', () => {
  const t = generateSessionToken();
  assert.match(t, /^[0-9a-f]{64}$/);
});
