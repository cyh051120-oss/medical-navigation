// shared/utils/time.ts
// Single authoritative time formatter for the miniapp (collapses A08-14's six
// drifted copies).
//
// Canonical storage format is ISO 8601 (see `occurredAt` in services/records.ts).
// Displayed / user-facing timestamps are ALWAYS localized to China Standard Time
// (UTC+8) as `YYYY-MM-DD HH:mm`, independent of the device time zone, so brief /
// poster / list output is deterministic across devices.
//
// Pure module: no `wx.*` access, no clock reads, safe to import from node checks.

/** UTC+8 offset in milliseconds (China Standard Time, no DST). */
export const CST_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * ISO-8601 shape (date, optional time, optional fractional seconds, optional
 * zone). Free text such as `昨天晚上` never matches; a bare `2026` does not
 * either, unlike a naked `Date.parse`.
 */
const ISO_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;

/** True when `value` is a non-empty, parseable ISO-8601 string. */
export function isCanonicalIso(value: unknown): value is string {
  if (typeof value !== 'string' || value === '') return false;
  if (!ISO_RE.test(value.trim())) return false;
  return !Number.isNaN(Date.parse(value));
}

/** Zero-padded 2-digit string. */
function pad2(value: number): string {
  return value < 10 ? '0' + value : String(value);
}

/**
 * Format an ISO timestamp as `YYYY-MM-DD HH:mm` in UTC+8.
 * Returns `''` for anything that is not a parseable ISO string (never fakes a
 * time for free text such as `昨天晚上`).
 */
export function formatStamp(iso: unknown): string {
  if (!isCanonicalIso(iso)) return '';
  const ms = Date.parse(iso);
  const date = new Date(ms + CST_OFFSET_MS);
  return (
    `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())} ` +
    `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}`
  );
}

/** Wall-clock `YYYY-MM-DD` / `HH:mm` pair as shown by the pickers (UTC+8). */
export interface WallClockParts {
  date: string;
  time: string;
}

/** ISO -> picker parts in UTC+8; empty strings when the input is not ISO. */
export function isoToWallClock(iso: unknown): WallClockParts {
  const stamp = formatStamp(iso);
  if (stamp === '') return { date: '', time: '' };
  return { date: stamp.slice(0, 10), time: stamp.slice(11, 16) };
}

/**
 * Picker parts (wall clock, interpreted as UTC+8) -> ISO string.
 * Returns `null` for missing, malformed or impossible values (e.g. `2026-02-31`)
 * so callers can surface an explicit error instead of silently substituting the
 * current time.
 */
export function wallClockToIso(date: string, time: string): string | null {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(time);
  if (dateMatch === null || timeMatch === null) return null;
  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  const utcMs = Date.UTC(year, month - 1, day, hour, minute) - CST_OFFSET_MS;
  if (!Number.isFinite(utcMs)) return null;
  const check = new Date(utcMs + CST_OFFSET_MS);
  const roundTrips =
    check.getUTCFullYear() === year &&
    check.getUTCMonth() === month - 1 &&
    check.getUTCDate() === day &&
    check.getUTCHours() === hour &&
    check.getUTCMinutes() === minute;
  return roundTrips ? new Date(utcMs).toISOString() : null;
}

/** Current UTC+8 wall-clock parts (used as the add-form default). */
export function nowWallClock(): WallClockParts {
  return isoToWallClock(new Date().toISOString());
}

export default { CST_OFFSET_MS, isCanonicalIso, formatStamp, isoToWallClock, wallClockToIso, nowWallClock };
