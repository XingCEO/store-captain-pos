'use strict';

/**
 * Repository — the persistence seam for operational entities.
 *
 * Phase A (this commit): an in-memory Map facade. Every operational collection
 * on `store.data.<name>` is a Repository instead of a raw Map. It exposes the
 * exact Map surface the domains already use, so adopting it changes no
 * behaviour and required no edits to the ~200 `store.data.*` call sites.
 *
 * Why it exists: it is the single chokepoint through which all operational
 * reads and writes flow. Phase B swaps the in-memory Map backing for per-entity
 * indexed SQLite tables — and Phase C for Postgres + RLS — without touching any
 * domain. `SqliteBackedMap` (core/runtime.js) already proves a Map-compatible
 * facade over indexed tables works; this generalises that seam to every entity.
 *
 * Map surface implemented: get/set/has/delete, values/keys/entries, forEach,
 * size, clear, and iteration (for-of, spread, Array.from, new Map(repo)).
 */
class Repository {
  constructor(name, entries) {
    this.name = name;
    this._map = new Map(entries || []);
  }

  get(key) { return this._map.get(key); }
  set(key, value) { this._map.set(key, value); return this; }
  has(key) { return this._map.has(key); }
  delete(key) { return this._map.delete(key); }

  values() { return this._map.values(); }
  keys() { return this._map.keys(); }
  entries() { return this._map.entries(); }
  forEach(fn, thisArg) { return this._map.forEach(fn, thisArg); }
  [Symbol.iterator]() { return this._map[Symbol.iterator](); }

  get size() { return this._map.size; }
  clear() { return this._map.clear(); }

  /**
   * Query helper. Domains today scatter `[...store.data.X.values()].filter(pred)`
   * across handlers; routing those through one method makes the eventual
   * push-down to a SQL WHERE clause (Phase B/C) a single-site change rather than
   * a hunt across every domain. Not yet adopted by call sites in Phase A.
   */
  filter(pred) {
    const out = [];
    for (const value of this._map.values()) if (pred(value)) out.push(value);
    return out;
  }
}

module.exports = { Repository };
