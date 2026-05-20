'use strict';

/**
 * Repository — the persistence seam for operational entities.
 *
 * Every operational collection on `store.data.<name>` is a Repository instead
 * of a raw Map. It exposes the exact Map surface the domains already use, so it
 * required no edits to the ~200 `store.data.*` call sites.
 *
 * Phase A: in-memory Map facade (the seam).
 * Phase B (current): the in-memory Map stays the hot read path, but every
 * mutation is recorded in a dirty/deleted set. `store.persist()` calls
 * `drainChanges()` and writes ONLY those rows to the `entities` table
 * (db.persistEntities) in one transaction — instead of re-serialising every
 * collection on every request. Crash-consistency and read-after-write are
 * unchanged; write amplification drops from O(dataset) to O(changed rows).
 * Phase C points the same flush at Postgres + RLS without touching domains.
 *
 * IMPORTANT (mirrors the store hazard in CLAUDE.md): mutations are only
 * persisted if they go through `set()`/`delete()`. Mutating an object returned
 * by `get()` in place, without `set()`-ing it back, will NOT be flushed. The
 * codebase already follows the copy-then-set discipline; keep it.
 *
 * Map surface implemented: get/set/has/delete, values/keys/entries, forEach,
 * size, clear, and iteration (for-of, spread, Array.from, new Map(repo)).
 */
class Repository {
  constructor(name, entries) {
    this.name = name;
    this._map = new Map(entries || []);
    // Pending writes since the last drainChanges(). Hydration via the
    // constructor is NOT dirty — it reflects what is already persisted.
    this._dirty = new Set();
    this._deleted = new Set();
  }

  get(key) { return this._map.get(key); }
  set(key, value) {
    this._map.set(key, value);
    this._dirty.add(key);
    this._deleted.delete(key);
    return this;
  }
  has(key) { return this._map.has(key); }
  delete(key) {
    const existed = this._map.delete(key);
    if (existed) { this._deleted.add(key); this._dirty.delete(key); }
    return existed;
  }

  values() { return this._map.values(); }
  keys() { return this._map.keys(); }
  entries() { return this._map.entries(); }
  forEach(fn, thisArg) { return this._map.forEach(fn, thisArg); }
  [Symbol.iterator]() { return this._map[Symbol.iterator](); }

  get size() { return this._map.size; }
  clear() {
    for (const key of this._map.keys()) this._deleted.add(key);
    this._dirty.clear();
    this._map.clear();
  }

  hasPendingChanges() { return this._dirty.size > 0 || this._deleted.size > 0; }

  // Snapshot the pending writes WITHOUT clearing them. The caller clears via
  // clearPending() only after the flush transaction commits — so a failed
  // persist leaves the changes queued for the next attempt (no data loss).
  // Upserts carry the current value; deletes that were never persisted are
  // harmless no-ops downstream.
  peekChanges() {
    const upserts = [];
    for (const key of this._dirty) {
      if (this._map.has(key)) upserts.push([key, this._map.get(key)]);
    }
    return { upserts, deletes: [...this._deleted] };
  }

  clearPending() {
    this._dirty.clear();
    this._deleted.clear();
  }

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
