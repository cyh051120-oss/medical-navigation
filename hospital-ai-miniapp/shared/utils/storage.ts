// shared/utils/storage.ts
// Namespaced local storage with a schema version.

export const NS = 'mhp_';
export const SCHEMA_VERSION = 1;

const LEGACY_NS = 'hza_';
const META_SCHEMA_VERSION = 'schema_version';

type StorageValue = unknown;

/**
 * Return all storage keys from the runtime, letting enumeration failures
 * propagate. Used by destructive paths (clearAll / purgeLegacy) so a failed
 * enumeration can never be reported as a successful wipe (P1-18).
 */
function allKeysStrict(): string[] {
  const info = wx.getStorageInfoSync();
  return info && Array.isArray(info.keys) ? info.keys : [];
}

/** Read-only key listing: enumeration failures degrade to an empty list. */
function allKeys(): string[] {
  try {
    return allKeysStrict();
  } catch (e) {
    return [];
  }
}

/**
 * Remove every key matching the given prefix; returns removed count.
 * Enumeration/removal failures propagate (never silently reported as cleared).
 */
function removeByPrefix(prefix: string): number {
  let removed = 0;
  for (const key of allKeysStrict()) {
    if (key.indexOf(prefix) === 0) {
      wx.removeStorageSync(key);
      removed += 1;
    }
  }
  return removed;
}

export function get<T = StorageValue>(key: string, defaultVal: T | null = null): T | null {
  try {
    const val = wx.getStorageSync(NS + key);
    return val !== '' && val !== undefined ? (val as T) : defaultVal;
  } catch (e) {
    return defaultVal;
  }
}

/**
 * Like `get`, but lets read exceptions propagate. Required for read-modify-write
 * paths: a swallowed read failure would be mistaken for an empty entity and
 * overwrite the real records on the next write (P1-17).
 */
export function getStrict<T = StorageValue>(key: string, defaultVal: T | null = null): T | null {
  const val = wx.getStorageSync(NS + key);
  return val !== '' && val !== undefined ? (val as T) : defaultVal;
}

export function set(key: string, val: StorageValue): void {
  wx.setStorageSync(NS + key, val);
}

export function remove(key: string): void {
  wx.removeStorageSync(NS + key);
}

/** List raw keys under the current namespace. */
export function list(): string[] {
  return allKeys().filter((key) => key.indexOf(NS) === 0);
}

/** Remove only mhp_* keys; non-namespaced keys are preserved. */
export function clearAll(): number {
  return removeByPrefix(NS);
}

export function getSchemaVersion(): number {
  const val = get<number>(META_SCHEMA_VERSION, SCHEMA_VERSION);
  return typeof val === 'number' ? val : SCHEMA_VERSION;
}

export function setSchemaVersion(version: number): void {
  set(META_SCHEMA_VERSION, version);
}

/** Remove all legacy hza_* keys. */
export function purgeLegacy(): number {
  return removeByPrefix(LEGACY_NS);
}
