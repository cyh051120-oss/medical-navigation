// shared/services/attachments.ts
// Attachment lifecycle for records that carry a single local file path
// (`SymptomEntry.attachment` / `DocumentNote.attachment`, both `string | null`).
//
// Layering: this module sits above `./records` (record CRUD) and uses the
// WeChat file system ONLY through the synchronous `wx.getFileSystemManager()`
// API surface. It performs NO network access and does NOT call
// `wx.chooseMedia` (picking a temp file is a page-side concern; the caller
// supplies an already-picked temp file path).
//
// Directory: every stored attachment lives directly under
// `attachmentsDir()` === `${wx.env.USER_DATA_PATH}/attachments/` (flat; names
// are unique so no subdirectories are needed).
//
// Full-wipe pairing (consumed later by the settings page):
//   records.deleteAll()            // clears every `mhp_*` key
//   attachments.clearAttachments() // unlinks every file in the attachments dir
// Call BOTH; records deletion alone never touches the files, and file clearing
// alone never touches the record list.
//
// Public surface (documented shape):
//   constants:
//     MAX_FILE_BYTES   = 5 * 1024 * 1024  (5MB) single-file hard limit
//     WARN_TOTAL_BYTES = 8 * 1024 * 1024  (8MB) soft cumulative warning
//     NOTICE_SAVE_FAILED = '附件未保存'
//     NOTICE_TOO_LARGE   = '单附件超 5MB'
//     WARNING_TOTAL      = soft 提示 for a saved file that pushes the dir over 8MB
//   functions:
//     attachmentsDir(): string            -> trailing-slash directory path
//     ensureDir(): void                   -> mkdir -p (idempotent)
//     clearAttachments(): number          -> unlink every file, returns count
//     attachmentsSize(): number           -> summed byte size of the dir
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
//   replaceAttachment: the old file is unlinked FIRST, then the new file is
//     saved, then the record is updated. If the save fails the record keeps its
//     previous `attachment` path VERBATIM (that old file has already been
//     unlinked, so the stored path is intentionally left as-is — documented).
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
    // Already exists (or parent issue); a later fs op will surface real errors.
  }
}

/**
 * Unlink every file directly under the attachments directory. Missing
 * directory or missing files are tolerated. Returns the removed-file count.
 */
export function clearAttachments(): number {
  const fm = wx.getFileSystemManager();
  let files: string[];
  try {
    files = fm.readdirSync(attachmentsDir());
  } catch (e) {
    return 0;
  }
  let removed = 0;
  for (const name of files) {
    try {
      fm.unlinkSync(attachmentsDir() + name);
      removed += 1;
    } catch (e) {
      // Tolerate a file that vanished between readdir and unlink.
    }
  }
  return removed;
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
 * Replace an existing record's attachment. Old file is unlinked FIRST, then a
 * new file is saved, then the record is updated. On save failure the record is
 * left untouched and keeps its previous `attachment` path as-is (the old file
 * has already been unlinked by design).
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
  if (oldPath) {
    try {
      wx.getFileSystemManager().unlinkSync(oldPath);
    } catch (e) {
      // Missing old file is tolerated.
    }
  }

  const outcome = trySaveAttachment(tempFilePath);
  if (!outcome.saved) {
    const failed: AttachmentResult<T> = { record: existing, saved: false };
    if (outcome.notice !== undefined) failed.notice = outcome.notice;
    return failed;
  }

  const record = store.update(id, { attachment: outcome.path } as Partial<D>);
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
  attachmentsDir,
  ensureDir,
  clearAttachments,
  attachmentsSize,
  createWithAttachment,
  addWithAttachment,
  replaceAttachment,
  deleteRecordWithAttachment,
};
