'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ErrorCodes = require('../src/core/errorCodes');

function scanSource(dir, codes = new Set()) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) { scanSource(p, codes); continue; }
    if (!entry.name.endsWith('.js')) continue;
    const text = fs.readFileSync(p, 'utf8');
    // runtime.error('CODE', ...)
    const r1 = /runtime\.error\(\s*['"]([A-Z][A-Z0-9_]+)['"]/g;
    // errorCode: 'CODE' (mostly in synthetic responses, tests, etc.)
    const r2 = /errorCode:\s*['"]([A-Z][A-Z0-9_]+)['"]/g;
    for (const re of [r1, r2]) {
      let m;
      while ((m = re.exec(text)) !== null) codes.add(m[1]);
    }
  }
  return codes;
}

test('every error code emitted by src/ is registered in errorCodes.js', () => {
  const root = path.join(__dirname, '..', 'src');
  const found = scanSource(root);
  const registered = new Set(Object.values(ErrorCodes));
  const missing = [...found].filter((c) => !registered.has(c));
  assert.deepEqual(missing, [], `Codes used in src/ but missing from errorCodes.js: ${missing.join(', ')}`);
});

test('ErrorCodes object is frozen and uniform key/value', () => {
  assert.equal(Object.isFrozen(ErrorCodes), true);
  for (const [k, v] of Object.entries(ErrorCodes)) {
    assert.equal(k, v, `enum key ${k} must equal value`);
  }
});
