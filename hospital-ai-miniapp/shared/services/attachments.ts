// shared/services/attachments.ts
// Attachment + export-file lifecycle for records that carry a single local file
// path (`SymptomEntry.attachment` / `DocumentNote.attachment`, both `string | null`).
//
// Layering: this module sits above `./records` (record CRUD) and uses the
// WeChat file system ONLY through the synchronous `wx.getFileSystemManager()`
// API surface. It performs NO network access and does NOT call
// `wx.chooseMedia` (picking a temp file is a page-side concern; the caller
// supplies an already-picked temp file path).
//
// Directories (flat, unique names, no subdirectories):
//   attachmentsDir() === `${wx.env.USER_DATA_PATH}/attachments/`  user attachments
//   exportsDir()     === `${wx.env.USER_DATA_PATH}/exports/`      plaintext exports
// Legacy: the pre-fix build wrote plaintext exports at the USER_DATA_PATH ROOT as
// `mhp_export_<digits>.json`. list/clear/wipe still cover those exact files.
//
// Full-wipe pairing (consumed by the settings page):
//   records.deleteAll()             // clears every `mhp_*` key
//   attachments.clearAttachments()  // unlinks every file in the attachments dir
//   attachments.clearExports()      // unlinks every plaintext export
// Call ALL THREE; records deletion alone never touches files, and file clearing
// alone never touches the record list.
//
// Public surface:
//   constants:
//     MAX_FILE_BYTES    = 5 * 1024 * 1024  (5MB) single-attachment hard limit
//     WARN_TOTAL_BYTES  = 8 * 1024 * 1024  (8MB) soft cumulative warning
//     EXPORT_FILE_NAME  = 'mhp_export.json' (fixed; overwritten each export)
//     NOTICE_SAVE_FAILED = '附件未保存'
//     NOTICE_TOO_LARGE   = '单附件超 5MB'
//     WARNING_TOTAL      = soft 提示 for a saved file that pushes the dir over 8MB
//   functions:
//     attachmentsDir(): string            -> trailing-slash directory path
//     exportsDir(): string                -> trailing-slash directory path
//     exportFilePath(): string            -> fixed export file path
//     ensureDir(): void                   -> mkdir -p (idempotent)
//     ensureExportsDir(): void            -> mkdir -p (idempotent)
//     clearAttachments(): ClearResult     -> unlink every attachment file
//     clearExports(): ClearResult         -> unlink exports/ AND legacy root files
//     clearLegacyExports(): ClearResult   -> unlink only legacy root files
//     listExportFiles(): ExportFile[]     -> current + legacy exports with sizes
//     deleteExport(path): boolean         -> unlink one export
//     attachmentsSize(): number           -> summed byte size of the attachment dir
//     createWithAttachment(store, data, tempFilePath|null): AttachmentResult<T>
//     addWithAttachment = createWithAttachment (alias)
//     replaceAttachment(store, id, tempFilePath): AttachmentResult<T>
//     deleteRecordWithAttachment(store, id): boolean
//
// Result shape (`AttachmentResult<T>`):
//   {
//     record: T,          // the record as persisted (attachment reflects reality)
//     saved: boolean,     // whether a file was written for this call
//     notice?: string,    // hard failure reason (附件未保存 / 单附件超 5MB)
//     warning?: string,   // soft cumulative-size 提示 (file was still saved)
//   }
//
// Semantics:
//   createWithAttachment: on save success sets `record.attachment` to the saved
//     path; on ANY fs error (or an oversize file) the RECORD IS STILL ADDED with
//     `attachment: null` and `notice` carries the exact phrase.
//   replaceAttachment: the NEW file is saved FIRST; only after the record is
//     committed successfully is the old file unlinked. On save failure the old
//     file AND the record are left completely untouched (no rollback needed) and
//     `notice` explains why.
//   deleteRecordWithAttachment: removes the record first, then unlinks its file;
//     a missing file is tolerated.

import type { BaseRecord } from './records';

/** Single-file hard limit: 5MB. Files above this are never saved. */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
/** Soft cumulative-directory warning threshold: 8MB. */
export const WARN_TOTAL_BYTES = 8 * 1024 * 1024;

/** Exact QA-failure-contract phrase: record saved, file not. */
export const NOTICE_SAVE_FAILED = '附件未保存';
/** Exact phrase for an oversize single file (record still saved, file not). */
export const NOTICE_TOO_LARGE = '单附件超 5MB';
/** Soft 提示: this save succeeded but the attachments dir now exceeds 8MB. */
export const WARNING_TOTAL = '附件累计占用已超过 8MB，建议清理旧附件';

/** Fixed export filename (Contract 2: overwritten each export, never timestamped). */
export const EXPORT_FILE_NAME = 'mhp_export.json';

/** Outcome of a clear/wipe operation: honest about per-file failures. */
export interface ClearResult {
  removed: number;
  failed: number;
}

/** A plaintext export file: current-format (under `exportsDir()`) or legacy. */
export interface ExportFile {
  name: string;
  path: string;
  size: number;
  /**
   * `true` for an old-format file the pre-fix build wrote at the
   * USER_DATA_PATH ROOT as `mhp_export_<digits>.json`. `false` for a
   * current-format file under `exportsDir()`.
   */
  legacy: boolean;
}

/** Minimal structural view of an attachable record. */
export interface AttachableRecord extends BaseRecord {
  attachment: string | null;
}

/** Minimal structural view of an attachable input (server fields omitted). */
export interface AttachableInput {
  attachment: string | null;
}

/**
 * Structural subset of `EntityStore<T, D>` needed here, so this module stays
 * decoupled from the full CRUD surface while remaining assignable from the
 * concrete `records.*` stores.
 */
export interface AttachmentStore<T extends AttachableRecord, D extends AttachableInput> {
  add(data: D): T;
  update(id: string, patch: Partial<D>): T;
  remove(id: string): boolean;
  get(id: string): T | null;
}

/** Result returned by create/replace. */
export interface AttachmentResult<T extends AttachableRecord> {
  record: T;
  saved: boolean;
  notice?: string;
  warning?: string;
}

/** Absolute directory (with trailing slash) holding every stored attachment. */
export function attachmentsDir(): string {
  return `${wx.env.USER_DATA_PATH}/attachments/`;
}

/** Absolute directory (with trailing slash) holding every plaintext export. */
export function exportsDir(): string {
  return `${wx.env.USER_DATA_PATH}/exports/`;
}

/** Fixed destination path for `EXPORT_FILE_NAME` (Contract 2). */
export function exportFilePath(): string {
  return exportsDir() + EXPORT_FILE_NAME;
}

/** USER_DATA_PATH root (trailing slash) where the pre-fix build wrote exports. */
function userDataDir(): string {
  return `${wx.env.USER_DATA_PATH}/`;
}

/**
 * Exact pre-fix export filename: `mhp_export_<digits>.json`. Deliberately does
 * NOT match the current `mhp_export.json`, any non-digit suffix, or other files.
 */
const LEGACY_EXPORT_NAME_RE = /^mhp_export_\d+\.json$/;

function isLegacyExportName(name: string): boolean {
  return LEGACY_EXPORT_NAME_RE.test(name);
}

/**
 * `readdirSync` wrapper: a missing dir yields `[]`; any other error propagates
 * so callers can surface an unreadable directory instead of silently showing
 * "no exports" (P2).
 */
function readDirNamesOrMissing(dir: string): string[] {
  try {
    return wx.getFileSystemManager().readdirSync(dir);
  } catch (e) {
    if (isMissingPathError(e)) return [];
    throw e;
  }
}

/** WeChat fs errors for a missing path; treated as "nothing to do". */
function isMissingPathError(e: unknown): boolean {
  let message = '';
  if (e && typeof e === 'object' && 'errMsg' in e) {
    message = String((e as { errMsg?: unknown }).errMsg ?? '');
  } else if (e instanceof Error) {
    message = e.message;
  } else {
    message = String(e);
  }
  return /no such file|not a directory|enoent|not exist/i.test(message);
}

function fileName(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

function extensionOf(path: string): string {
  const name = fileName(path);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return '';
  return name.slice(dot);
}

function uniqueName(sourcePath: string): string {
  const ts = Date.now();
  let rand = Math.random().toString(36).slice(2, 8);
  if (rand === '') rand = 'x0';
  return `att_${ts}_${rand}${extensionOf(sourcePath)}`;
}

function fileSize(path: string): number {
  const stats = wx.getFileSystemManager().statSync(path) as WechatMiniprogram.Stats;
  return typeof stats.size === 'number' ? stats.size : 0;
}

/** Idempotent `mkdir -p` for the attachments directory. */
export function ensureDir(): void {
  try {
    wx.getFileSystemManager().mkdirSync(attachmentsDir(), true);
  } catch (e) {
    void e; // mkdir -p is idempotent; a later fs op surfaces real errors.
  }
}

/** Idempotent `mkdir -p` for the exports directory. */
export function ensureExportsDir(): void {
  try {
    wx.getFileSystemManager().mkdirSync(exportsDir(), true);
  } catch (e) {
    void e; // mkdir -p is idempotent; the write call surfaces real errors.
  }
}

/**
 * Unlink every file directly under the attachments directory. A missing
 * directory / vanished file is tolerated; genuine unlink or enumeration
 * failures are counted in `failed` so the UI never claims a clean wipe (P1-18).
 */
export function clearAttachments(): ClearResult {
  return clearDir(attachmentsDir());
}

/**
 * Unlink every plaintext export: both the current `exports/` directory AND any
 * legacy root file matching `mhp_export_<digits>.json`. Same honesty contract as
 * `clearAttachments` (P0-5 / P1-18); legacy files are counted too so a wipe
 * cannot silently leave an old-build plaintext health record behind (P1).
 */
export function clearExports(): ClearResult {
  const current = clearDir(exportsDir());
  const legacy = clearLegacyExports();
  return { removed: current.removed + legacy.removed, failed: current.failed + legacy.failed };
}

/**
 * Unlink only the pre-fix root exports (`mhp_export_<digits>.json`). Every other
 * root entry is left untouched. Missing dir => `{removed:0, failed:0}`.
 */
export function clearLegacyExports(): ClearResult {
  const root = userDataDir();
  let names: string[];
  try {
    names = wx.getFileSystemManager().readdirSync(root);
  } catch (e) {
    return isMissingPathError(e) ? { removed: 0, failed: 0 } : { removed: 0, failed: 1 };
  }
  const fm = wx.getFileSystemManager();
  let removed = 0;
  let failed = 0;
  for (const name of names) {
    if (!isLegacyExportName(name)) continue;
    try {
      fm.unlinkSync(root + name);
      removed += 1;
    } catch (e) {
      if (isMissingPathError(e)) removed += 1;
      else failed += 1;
    }
  }
  return { removed, failed };
}

function clearDir(dir: string): ClearResult {
  const fm = wx.getFileSystemManager();
  let files: string[];
  try {
    files = fm.readdirSync(dir);
  } catch (e) {
    return isMissingPathError(e) ? { removed: 0, failed: 0 } : { removed: 0, failed: 1 };
  }
  let removed = 0;
  let failed = 0;
  for (const name of files) {
    try {
      fm.unlinkSync(dir + name);
      removed += 1;
    } catch (e) {
      if (isMissingPathError(e)) removed += 1;
      else failed += 1;
    }
  }
  return { removed, failed };
}

function safeFileSize(path: string): number {
  try {
    return fileSize(path);
  } catch (e) {
    return 0;
  }
}

/**
 * List every plaintext export: current-format files under `exportsDir()` plus
 * legacy root files matching `mhp_export_<digits>.json` (tagged `legacy:true`).
 * A missing dir contributes no entries; any OTHER readdir error PROPAGATES so
 * an unreadable directory is surfaced instead of shown as "no exports" (P2).
 */
export function listExportFiles(): ExportFile[] {
  const out: ExportFile[] = [];
  for (const name of readDirNamesOrMissing(exportsDir())) {
    const path = exportsDir() + name;
    out.push({ name, path, size: safeFileSize(path), legacy: false });
  }
  for (const name of readDirNamesOrMissing(userDataDir())) {
    if (!isLegacyExportName(name)) continue;
    const path = userDataDir() + name;
    out.push({ name, path, size: safeFileSize(path), legacy: true });
  }
  return out;
}

/** Unlink one export file; returns whether it is gone afterwards. */
export function deleteExport(path: string): boolean {
  try {
    wx.getFileSystemManager().unlinkSync(path);
    return true;
  } catch (e) {
    return isMissingPathError(e);
  }
}

/** Summed byte size of every file directly under the attachments directory. */
export function attachmentsSize(): number {
  const fm = wx.getFileSystemManager();
  let files: string[];
  try {
    files = fm.readdirSync(attachmentsDir());
  } catch (e) {
    return 0;
  }
  let total = 0;
  for (const name of files) {
    try {
      total += fileSize(attachmentsDir() + name);
    } catch (e) {
      // Skip unreadable entries rather than failing the whole measurement.
    }
  }
  return total;
}

interface SaveOutcome {
  saved: boolean;
  path: string | null;
  notice?: string;
}

/** Stat + size-policy + save, collapsing every fs error into a notice. */
function trySaveAttachment(tempFilePath: string): SaveOutcome {
  let size = 0;
  try {
    size = fileSize(tempFilePath);
  } catch (e) {
    return { saved: false, path: null, notice: NOTICE_SAVE_FAILED };
  }
  if (size > MAX_FILE_BYTES) {
    return { saved: false, path: null, notice: NOTICE_TOO_LARGE };
  }
  ensureDir();
  const dest = attachmentsDir() + uniqueName(tempFilePath);
  try {
    const savedPath = wx.getFileSystemManager().saveFileSync(tempFilePath, dest);
    return { saved: true, path: typeof savedPath === 'string' && savedPath !== '' ? savedPath : dest };
  } catch (e) {
    return { saved: false, path: null, notice: NOTICE_SAVE_FAILED };
  }
}

/**
 * Add a record, attempting to persist `tempFilePath` as its attachment.
 * The record is ALWAYS added: on any save failure (or oversize file) it is
 * stored with `attachment: null` and the result carries `notice`.
 */
export function createWithAttachment<T extends AttachableRecord, D extends AttachableInput>(
  store: AttachmentStore<T, D>,
  data: D,
  tempFilePath: string | null
): AttachmentResult<T> {
  let attachment: string | null = data.attachment === undefined ? null : data.attachment;
  let saved = false;
  let notice: string | undefined;

  if (typeof tempFilePath === 'string' && tempFilePath !== '') {
    const outcome = trySaveAttachment(tempFilePath);
    if (outcome.saved) {
      attachment = outcome.path;
      saved = true;
    } else {
      attachment = null;
      notice = outcome.notice;
    }
  }

  const record = store.add({ ...(data as object), attachment } as D);
  const result: AttachmentResult<T> = { record, saved };
  if (notice !== undefined) result.notice = notice;
  if (saved && attachmentsSize() > WARN_TOTAL_BYTES) result.warning = WARNING_TOTAL;
  return result;
}

/**
 * Replace an existing record's attachment. The NEW file is saved FIRST; the old
 * file is unlinked ONLY after the record commit succeeds. On save failure the
 * old file and the record are left completely intact and `notice` explains why.
 */
export function replaceAttachment<T extends AttachableRecord, D extends AttachableInput>(
  store: AttachmentStore<T, D>,
  id: string,
  tempFilePath: string
): AttachmentResult<T> {
  const existing = store.get(id);
  if (existing === null) {
    throw new Error(`[attachments] cannot replace attachment on unknown id "${id}" (no record written)`);
  }

  const oldPath = existing.attachment;

  // 1. Save the new file first. On failure nothing has changed yet.
  const outcome = trySaveAttachment(tempFilePath);
  if (!outcome.saved) {
    const failed: AttachmentResult<T> = { record: existing, saved: false };
    if (outcome.notice !== undefined) failed.notice = outcome.notice;
    return failed;
  }

  // 2. Commit the record. On failure roll back ONLY the just-saved new file.
  let record: T;
  try {
    record = store.update(id, { attachment: outcome.path } as Partial<D>);
  } catch (e) {
    if (outcome.path !== null) {
      try {
        wx.getFileSystemManager().unlinkSync(outcome.path);
      } catch (rollbackError) {
        void rollbackError;
      }
    }
    throw e;
  }

  // 3. Only now is it safe to remove the old file.
  if (oldPath && oldPath !== outcome.path) {
    try {
      wx.getFileSystemManager().unlinkSync(oldPath);
    } catch (e) {
      void e; // Best-effort cleanup; a later full wipe reclaims orphans.
    }
  }

  const result: AttachmentResult<T> = { record, saved: true };
  if (attachmentsSize() > WARN_TOTAL_BYTES) result.warning = WARNING_TOTAL;
  return result;
}

/** Alias kept for readability at the call site that adds a new record. */
export const addWithAttachment = createWithAttachment;

/**
 * Remove a record and then unlink its attachment file. The record is removed
 * first; a missing file (or a record with no attachment) is tolerated. Returns
 * whether a record was removed.
 */
export function deleteRecordWithAttachment<T extends AttachableRecord, D extends AttachableInput>(
  store: AttachmentStore<T, D>,
  id: string
): boolean {
  const existing = store.get(id);
  const removed = store.remove(id);
  if (removed && existing !== null && existing.attachment) {
    try {
      wx.getFileSystemManager().unlinkSync(existing.attachment);
    } catch (e) {
      // Tolerate an already-missing file.
    }
  }
  return removed;
}

export default {
  MAX_FILE_BYTES,
  WARN_TOTAL_BYTES,
  EXPORT_FILE_NAME,
  NOTICE_SAVE_FAILED,
  NOTICE_TOO_LARGE,
  WARNING_TOTAL,
  attachmentsDir,
  exportsDir,
  exportFilePath,
  ensureDir,
  ensureExportsDir,
  clearAttachments,
  clearExports,
  clearLegacyExports,
  listExportFiles,
  deleteExport,
  attachmentsSize,
  createWithAttachment,
  addWithAttachment,
  replaceAttachment,
  deleteRecordWithAttachment,
};
