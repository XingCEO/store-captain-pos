'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Repository } = require('../src/core/repository');

// The Repository is the persistence seam. Phase A guarantees it is a drop-in
// for the raw Map the ~200 `store.data.*` call sites used, so these lock the
// Map-compatible surface those sites (and persist()/load()) depend on.

test('Repository round-trips entries passed to the constructor', () => {
  const repo = new Repository('orders', [['a', { id: 'a' }], ['b', { id: 'b' }]]);
  assert.equal(repo.size, 2);
  assert.deepEqual(repo.get('a'), { id: 'a' });
  assert.equal(repo.has('b'), true);
  assert.equal(repo.has('z'), false);
});

test('Repository get/set/delete behave like Map', () => {
  const repo = new Repository('orders');
  assert.equal(repo.get('x'), undefined);
  const ret = repo.set('x', { v: 1 });
  assert.equal(ret, repo, 'set returns the repository for chaining, like Map');
  assert.deepEqual(repo.get('x'), { v: 1 });
  assert.equal(repo.delete('x'), true);
  assert.equal(repo.delete('x'), false);
  assert.equal(repo.size, 0);
});

test('Repository iteration matches Map (entries/values/keys/for-of/spread)', () => {
  const repo = new Repository('orders', [['a', 1], ['b', 2]]);
  assert.deepEqual([...repo.entries()], [['a', 1], ['b', 2]]);
  assert.deepEqual([...repo.values()], [1, 2]);
  assert.deepEqual([...repo.keys()], ['a', 'b']);
  assert.deepEqual([...repo], [['a', 1], ['b', 2]], 'spread via [Symbol.iterator]');
  assert.deepEqual(new Map(repo), new Map([['a', 1], ['b', 2]]), 'new Map(repo) works');
  const seen = [];
  repo.forEach((v, k) => seen.push([k, v]));
  assert.deepEqual(seen, [['a', 1], ['b', 2]]);
});

test('persist()-style snapshot extraction works on Repository', () => {
  // persist() does `[...this.data[name].entries()]`; load() rebuilds from it.
  const repo = new Repository('orders', [['a', { id: 'a' }]]);
  const snapshot = [...repo.entries()];
  const rebuilt = new Repository('orders', snapshot);
  assert.deepEqual([...rebuilt.entries()], snapshot);
});

test('Repository.filter returns matching values (Phase B query seam)', () => {
  const repo = new Repository('orders', [
    ['a', { tenantId: 't1' }],
    ['b', { tenantId: 't2' }],
    ['c', { tenantId: 't1' }],
  ]);
  assert.deepEqual(repo.filter((o) => o.tenantId === 't1'), [{ tenantId: 't1' }, { tenantId: 't1' }]);
});
