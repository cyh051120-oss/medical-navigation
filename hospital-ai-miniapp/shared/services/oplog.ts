// shared/services/oplog.ts
// Minimal local operation log (no network, no wx.* direct calls).
//
// Stored as a single `mhp_oplog` key via `../utils/storage` (raw key `oplog`,
// namespace applied by storage.ts). Entries are appended newest-last; the log
// is capped at `OPLOG_MAX` (200) — after every append only the newest 200 are
// kept and the oldest are dropped.
//
// Public surface:
//   OPLOG_MAX = 200
//   append(type, ref?)  -> appends and returns the entry
//   list()              -> copy of the entries, newest-last
//   clear()             -> removes the stored log entirely
//
// Entry shape: { type: 'create'|'update'|'delete'|'export'|'clear', at: ISO, ref? }

import * as storage from '../utils/storage';

/** Raw storage key (storage.ts applies the `mhp_` namespace -> `mhp_oplog`). */
export const OPLOG_KEY = 'oplog';

/** Maximum retained entries; append keeps only the newest `OPLOG_MAX`. */
export const OPLOG_MAX = 200;

export type OpType = 'create' | 'update' | 'delete' | 'export' | 'clear';

/** A single operation-log entry. */
export interface OpEntry {
  type: OpType;
  /** ISO timestamp of the operation. */
  at: string;
  /** Optional subject reference (e.g. a record id). */
  ref?: string;
}

function readAll(): OpEntry[] {
  const raw = storage.get<OpEntry[]>(OPLOG_KEY, []);
  return Array.isArray(raw) ? raw : [];
}

/** Append one entry, then trim to the newest `OPLOG_MAX` entries. */
export function append(type: OpType, ref?: string): OpEntry {
  const entry: OpEntry = { type, at: new Date().toISOString() };
  if (ref !== undefined) entry.ref = ref;
  const next = readAll();
  next.push(entry);
  const trimmed = next.length > OPLOG_MAX ? next.slice(next.length - OPLOG_MAX) : next;
  storage.set(OPLOG_KEY, trimmed);
  return entry;
}

/** Return a copy of the entries, newest-last. */
export function list(): OpEntry[] {
  return readAll().slice();
}

/** Remove the stored log entirely. */
export function clear(): void {
  storage.remove(OPLOG_KEY);
}

export default { OPLOG_KEY, OPLOG_MAX, append, list, clear };
