'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { taipeiBusinessDate, isValidBusinessDate, normalizeBusinessDate } = require('../src/core/tz');

test('taipeiBusinessDate returns YYYY-MM-DD', () => {
  const d = taipeiBusinessDate(new Date('2026-05-17T15:30:00Z'));
  // 2026-05-17 23:30 Taipei → still 2026-05-17
  assert.equal(d, '2026-05-17');
});

test('Taipei TZ rolls over correctly across UTC midnight', () => {
  // UTC 2026-05-17 17:00 → Taipei 2026-05-18 01:00
  const d = taipeiBusinessDate(new Date('2026-05-17T17:00:00Z'));
  assert.equal(d, '2026-05-18');
});

test('isValidBusinessDate accepts YYYY-MM-DD only', () => {
  assert.equal(isValidBusinessDate('2026-05-17'), true);
  assert.equal(isValidBusinessDate('2026-13-01'), false);
  assert.equal(isValidBusinessDate('2026-02-30'), false);
  assert.equal(isValidBusinessDate('2026/05/17'), false);
  assert.equal(isValidBusinessDate(''), false);
  assert.equal(isValidBusinessDate(null), false);
});

test('normalizeBusinessDate falls back to today when invalid', () => {
  const now = new Date('2026-05-17T10:00:00Z');
  assert.equal(normalizeBusinessDate('2026-05-15', now), '2026-05-15');
  assert.equal(normalizeBusinessDate('garbage', now), '2026-05-17');
});
