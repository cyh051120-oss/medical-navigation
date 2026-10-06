#!/usr/bin/env node
// scripts/check-attachments.mjs
// Zero-dependency harness (tsx-run) for shared/services/attachments.ts and
// shared/services/oplog.ts.
//
// Unlike the storage-only shims, this harness points `wx.env.USER_DATA_PATH` at
// a REAL temp directory under os.tmpdir() and wraps node's synchronous fs API
// for the exact FileSystemManager surface the modules call:
//   mkdirSync / saveFileSync / unlinkSync / readdirSync / statSync / accessSync
// Every "file exists / is gone" claim is checked against the real filesystem,
// not just against exit codes.
//
// Modes:
//   (default)                 happy run -> artifacts/e2e/attachments.json
//   --simulate-save-failure   shim saveFileSync throws ENOSPC; asserts the record
//                             is still persisted with attachment:null and notice
//                             "附件未保存" -> artifacts/qa/8-failure.txt
//                             exit 0 when the required handling is demonstrated.

import {
  accessSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { makeRunTypecheck, resetStore } from './lib/check-helpers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const simulateSaveFailure = process.argv.includes('--simulate-save-failure');

// --- Real temp workspace (removed at the end) ---
const tmpRoot = mkdtempSync(join(tmpdir(), 'mhp-att-'));
const attachDir = join(tmpRoot, 'attachments');
const fixturesDir = join(tmpRoot, 'fixtures');
mkdirSync(fixturesDir, { recursive: true });

// --- Map-backed storage shim + real-fs FileSystemManager shim ---
let failSave = false;
let lastFsError = null;

function createWxShim() {
  const store = new Map();
  return {
    _store: store,
    env: { USER_DATA_PATH: tmpRoot },
    setStorageSync(key, value) {
      store.set(key, value);
    },
    getStorageSync(key) {
      return store.has(key) ? store.get(key) : '';
    },
    removeStorageSync(key) {
      store.delete(key);
    },
    getStorageInfoSync() {
      return { keys: Array.from(store.keys()) };
    },
    getFileSystemManager() {
      return {
        mkdirSync(dirPath, recursive) {
          mkdirSync(dirPath, { recursive: recursive === true });
        },
        saveFileSync(tempFilePath, filePath) {
          if (failSave) {
            const err = new Error('no space left on device, saveFileSync');
            err.code = 'ENOSPC';
            lastFsError = `${err.code}: ${err.message}`;
            throw err;
          }
          const dest = filePath === undefined || filePath === '' ? join(tmpRoot, `saved_${Date.now()}`) : filePath;
          copyFileSync(tempFilePath, dest);
          return dest;
        },
        unlinkSync(filePath) {
          unlinkSync(filePath);
        },
        readdirSync(dirPath) {
          return readdirSync(dirPath);
        },
        statSync(path) {
          return statSync(path);
        },
        accessSync(path) {
          accessSync(path);
        },
      };
    },
  };
}

globalThis.wx = createWxShim();
const wx = globalThis.wx;

// Real-fs cleanup for a group (isolation between cases).
function resetDir() {
  rmSync(attachDir, { recursive: true, force: true });
}

function makeFixture(name, bytes) {
  const p = join(fixturesDir, name);
  writeFileSync(p, Buffer.alloc(bytes, 0x61));
  return p;
}

function dirFileCount() {
  try {
    return readdirSync(attachDir).length;
  } catch (e) {
    return 0;
  }
}

function symptom(text) {
  return {
    occurredAt: '2026-09-01T09:00:00.000Z',
    duration: '3 天',
    text,
    impact: '影响睡眠',
    tags: [],
    attachment: null,
  };
}

function cleanupWorkspace() {
  rmSync(tmpRoot, { recursive: true, force: true });
  return !existsSync(tmpRoot);
}

// --- Type check gate (raw exit code captured) ---
const runTypecheck = makeRunTypecheck(root);

// --- Load modules under test (after wx shim is installed) ---
const attachments = await import(
  pathToFileURL(resolve(root, 'hospital-ai-miniapp/shared/services/attachments.ts')).href
);
const oplog = await import(
  pathToFileURL(resolve(root, 'hospital-ai-miniapp/shared/services/oplog.ts')).href
);
const records = await import(
  pathToFileURL(resolve(root, 'hospital-ai-miniapp/shared/services/records.ts')).href
);

// ---------------------------------------------------------------------------
// Failure demo (--simulate-save-failure)
// ---------------------------------------------------------------------------
if (simulateSaveFailure) {
  const lines = [];
  const log = (...parts) => {
    const msg = parts.join(' ');
    lines.push(msg);
    console.log(msg);
  };

  failSave = true;
  resetStore();
  resetDir();
  const fixture = makeFixture('fail.bin', 1024);

  const result = attachments.createWithAttachment(records.symptoms, symptom('FAIL-CASE'), fixture);
  const liveRecord = records.symptoms.list()[0] || null;
  const rawList = wx.getStorageSync('mhp_records_symptoms');
  const rawRecord = Array.isArray(rawList) && rawList.length > 0 ? rawList[0] : null;

  const recordPersisted =
    liveRecord !== null && liveRecord.attachment === null && rawRecord !== null && rawRecord.attachment === null;
  const noticeOk = result.notice === '附件未保存';
  const noFileWritten = dirFileCount() === 0;
  const savedFalse = result.saved === false;
  const handled = recordPersisted && noticeOk && noFileWritten && savedFalse;

  log('[simulate-save-failure] shim saveFileSync throws ENOSPC on purpose');
  log(`[simulate-save-failure] raw fs error from shim = ${lastFsError}`);
  log(`[simulate-save-failure] result.saved = ${result.saved}`);
  log(`[simulate-save-failure] result.notice = ${result.notice}`);
  log(`[simulate-save-failure] result.notice === "附件未保存" = ${noticeOk}`);
  log(`[simulate-save-failure] live record present = ${liveRecord !== null}`);
  log(`[simulate-save-failure] live record attachment = ${liveRecord ? JSON.stringify(liveRecord.attachment) : 'n/a'}`);
  log(`[simulate-save-failure] raw stored attachment = ${rawRecord ? JSON.stringify(rawRecord.attachment) : 'n/a'}`);
  log(`[simulate-save-failure] attachments dir file count = ${dirFileCount()}`);
  log(
    `[simulate-save-failure] assertion "record persisted with attachment:null + notice 附件未保存 + no file" passed = ${handled}`
  );

  if (!handled) {
    log('ASSERTION FAILED: save failure was not handled as required (record/notice/file mismatch).');
  }

  const removedOk = cleanupWorkspace();
  log(`[simulate-save-failure] cleanup: temp workspace removed = ${removedOk}`);

  const outDir = resolve(root, 'artifacts/qa');
  mkdirSync(outDir, { recursive: true });
  const body = [
    'T8 attachments failure demo (--simulate-save-failure)',
    `command: npx tsx scripts/check-attachments.mjs --simulate-save-failure`,
    `timestamp: ${new Date().toISOString()}`,
    `temp_dir: ${tmpRoot}`,
    '',
    ...lines,
    '',
    `exit_code: ${handled ? 0 : 1}`,
    '',
  ].join('\n');
  writeFileSync(resolve(outDir, '8-failure.txt'), body);

  console.log(`exit=${handled ? 0 : 1}`);
  process.exit(handled ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Happy run
// ---------------------------------------------------------------------------
const typecheck = runTypecheck();
const cases = [];
function addCase(name, pass, details) {
  cases.push({ name, pass, details });
}

const MAX = attachments.MAX_FILE_BYTES;
const WARN = attachments.WARN_TOTAL_BYTES;

// Case 1: create with a fixture attachment (real file, size sane, path recorded).
resetStore();
resetDir();
const small = makeFixture('small.bin', 1024);
const created = attachments.createWithAttachment(records.symptoms, symptom('create'), small);
const createdPath = created.record.attachment;
const createdExists = typeof createdPath === 'string' && existsSync(createdPath);
const createdSize = createdExists ? statSync(createdPath).size : null;
const liveAfterCreate = records.symptoms.get(created.record.id);
const rawAfterCreate = wx.getStorageSync('mhp_records_symptoms');
const createPersisted =
  liveAfterCreate !== null &&
  liveAfterCreate.attachment === createdPath &&
  Array.isArray(rawAfterCreate) &&
  rawAfterCreate[0].attachment === createdPath;
addCase(
  'create: fixture saved under attachments dir, path recorded in record',
  created.saved === true &&
    createdExists &&
    createdSize === 1024 &&
    createPersisted &&
    created.notice === undefined &&
    basename(createdPath) &&
    createdPath.indexOf(attachments.attachmentsDir()) === 0,
  {
    dir: attachments.attachmentsDir(),
    saved_path: createdPath,
    file_exists: createdExists,
    file_size: createdSize,
    expected_size: 1024,
    record_persisted: createPersisted,
    notice: created.notice === undefined ? null : created.notice,
    warning: created.warning === undefined ? null : created.warning,
    dir_listing: dirFileCount() > 0 ? readdirSync(attachDir) : [],
  }
);

// Case 2: replace -> old file GONE, new file exists, record updated.
resetStore();
resetDir();
const oldFixture = makeFixture('old.bin', 1024);
const newFixture = makeFixture('new.bin', 2048);
const seeded = attachments.createWithAttachment(records.symptoms, symptom('replace'), oldFixture);
const oldPath = seeded.record.attachment;
const replaced = attachments.replaceAttachment(records.symptoms, seeded.record.id, newFixture);
const newPath = replaced.record.attachment;
const oldGone = typeof oldPath === 'string' && !existsSync(oldPath);
const newExists = typeof newPath === 'string' && existsSync(newPath);
const newSize = newExists ? statSync(newPath).size : null;
const listingAfterReplace = dirFileCount() > 0 ? readdirSync(attachDir) : [];
const onlyNewFile = listingAfterReplace.length === 1 && listingAfterReplace[0] === basename(newPath);
const liveAfterReplace = records.symptoms.get(seeded.record.id);
const replaceRecordUpdated = liveAfterReplace !== null && liveAfterReplace.attachment === newPath;
addCase(
  'replace: old file unlinked first (gone), new file exists, record updated',
  replaced.saved === true &&
    oldGone &&
    newExists &&
    newSize === 2048 &&
    onlyNewFile &&
    replaceRecordUpdated &&
    newPath !== oldPath,
  {
    old_path: oldPath,
    old_file_gone: oldGone,
    new_path: newPath,
    new_file_exists: newExists,
    new_file_size: newSize,
    dir_listing: listingAfterReplace,
    only_new_file: onlyNewFile,
    record_updated: replaceRecordUpdated,
  }
);

// Case 3: delete record -> record gone and its file unlinked.
resetStore();
resetDir();
const delFixture = makeFixture('del.bin', 1024);
const toDelete = attachments.createWithAttachment(records.symptoms, symptom('delete'), delFixture);
const delPath = toDelete.record.attachment;
const removeReturned = attachments.deleteRecordWithAttachment(records.symptoms, toDelete.record.id);
const recordGone = records.symptoms.get(toDelete.record.id) === null;
const delFileGone = typeof delPath === 'string' && !existsSync(delPath);
const dirEmptyAfterDelete = dirFileCount() === 0;
addCase(
  'delete: record removed then attachment file unlinked',
  removeReturned === true && recordGone && delFileGone && dirEmptyAfterDelete,
  {
    removed_returned: removeReturned,
    record_gone: recordGone,
    deleted_path: delPath,
    file_gone: delFileGone,
    dir_file_count: dirFileCount(),
  }
);

// Case 4: clearAttachments -> dir empty, returns count; missing dir tolerated.
resetStore();
resetDir();
const cl1 = makeFixture('cl1.bin', 512);
const cl2 = makeFixture('cl2.bin', 512);
attachments.createWithAttachment(records.symptoms, symptom('clear-1'), cl1);
attachments.createWithAttachment(records.symptoms, symptom('clear-2'), cl2);
const beforeClear = dirFileCount();
const clearedCount = attachments.clearAttachments();
const dirEmptyAfterClear = dirFileCount() === 0;
resetDir();
const clearedMissingDir = attachments.clearAttachments();
addCase(
  'clearAttachments: unlinks every file (count) and tolerates missing dir',
  beforeClear === 2 && clearedCount === 2 && dirEmptyAfterClear && clearedMissingDir === 0,
  {
    before_clear: beforeClear,
    cleared_count: clearedCount,
    dir_empty: dirEmptyAfterClear,
    cleared_when_missing: clearedMissingDir,
  }
);

// Case 5: single file > 5MB -> not saved, record still added with notice.
resetStore();
resetDir();
const oversizeFixture = makeFixture('oversize.bin', MAX + 1024);
const oversize = attachments.createWithAttachment(records.symptoms, symptom('oversize'), oversizeFixture);
const oversizeRecord = records.symptoms.list()[0] || null;
const oversizePersisted = oversizeRecord !== null && oversizeRecord.attachment === null;
const rawOversize = wx.getStorageSync('mhp_records_symptoms');
const oversizeRawNull = Array.isArray(rawOversize) && rawOversize.length === 1 && rawOversize[0].attachment === null;
addCase(
  'oversize: > 5MB rejected (no file), record still added with attachment null + notice',
  oversize.saved === false &&
    oversize.notice === '单附件超 5MB' &&
    oversizePersisted &&
    oversizeRawNull &&
    dirFileCount() === 0,
  {
    fixture_bytes: MAX + 1024,
    max_file_bytes: MAX,
    saved: oversize.saved,
    notice: oversize.notice === undefined ? null : oversize.notice,
    record_attachment: oversizeRecord ? oversizeRecord.attachment : 'n/a',
    raw_attachment_null: oversizeRawNull,
    dir_file_count: dirFileCount(),
  }
);

// Case 6: cumulative dir > 8MB after a save -> saved + soft warning.
resetStore();
resetDir();
const each = Math.ceil(4.4 * 1024 * 1024); // < 5MB each, two > 8MB
const cum1 = makeFixture('cum1.bin', each);
const cum2 = makeFixture('cum2.bin', each);
const firstCum = attachments.createWithAttachment(records.symptoms, symptom('cum-1'), cum1);
const secondCum = attachments.createWithAttachment(records.symptoms, symptom('cum-2'), cum2);
const dirBytes = attachments.attachmentsSize();
addCase(
  'cumulative: > 8MB after save -> file saved with soft warning (no hard notice)',
  firstCum.saved === true &&
    secondCum.saved === true &&
    typeof secondCum.warning === 'string' &&
    secondCum.warning.length > 0 &&
    secondCum.notice === undefined &&
    dirBytes > WARN &&
    dirFileCount() === 2,
  {
    warn_total_bytes: WARN,
    dir_bytes: dirBytes,
    second_warning: secondCum.warning === undefined ? null : secondCum.warning,
    second_notice: secondCum.notice === undefined ? null : secondCum.notice,
    first_warning: firstCum.warning === undefined ? null : firstCum.warning,
    dir_file_count: dirFileCount(),
  }
);

// Case 7: oplog cap + all types + clear.
wx._store.clear();
const types = ['create', 'update', 'delete', 'export', 'clear'];
for (let i = 0; i < 250; i += 1) {
  oplog.append(types[i % types.length], `ref_${i}`);
}
const logList = oplog.list();
const rawOplog = wx.getStorageSync('mhp_oplog');
const capped = logList.length === 200;
const newestKept = logList.length === 200 && logList[0].ref === 'ref_50' && logList[199].ref === 'ref_249';
const presentTypes = new Set(logList.map((e) => e.type));
const allTypesPresent = types.every((t) => presentTypes.has(t));
const isoOk = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(logList[0].at);
const rawIsArray = Array.isArray(rawOplog) && rawOplog.length === 200;
oplog.clear();
const clearedLog = oplog.list().length === 0 && wx.getStorageSync('mhp_oplog') === '';
addCase(
  'oplog: 250 appends keep newest 200, all 5 types exercised, clear empties',
  capped &&
    newestKept &&
    allTypesPresent &&
    isoOk &&
    rawIsArray &&
    clearedLog &&
    oplog.OPLOG_MAX === 200,
  {
    appended: 250,
    oplog_max: oplog.OPLOG_MAX,
    kept: logList.length,
    first_ref: logList[0] ? logList[0].ref : null,
    last_ref: logList[199] ? logList[199].ref : null,
    types_present: Array.from(presentTypes),
    all_types_present: allTypesPresent,
    iso_timestamp_ok: isoOk,
    raw_key_array_len_200: rawIsArray,
    cleared_empty: clearedLog,
  }
);

const summary = {
  total: cases.length,
  passed: cases.filter((c) => c.pass).length,
  failed: cases.filter((c) => !c.pass).length,
  typecheck_exit: typecheck.exit,
};

const removedOk = cleanupWorkspace();

const artifact = {
  command: 'npx tsx scripts/check-attachments.mjs',
  timestamp: new Date().toISOString(),
  cases,
  typecheck,
  summary,
  cleanup: { temp_dir: tmpRoot, removed: removedOk },
};

const e2eDir = resolve(root, 'artifacts/e2e');
mkdirSync(e2eDir, { recursive: true });
writeFileSync(resolve(e2eDir, 'attachments.json'), `${JSON.stringify(artifact, null, 2)}\n`);

for (const c of cases) {
  console.log(`${c.pass ? 'PASS' : 'FAIL'} - ${c.name}`);
}
console.log(`typecheck exit=${typecheck.exit}`);
console.log(`cases ${summary.passed}/${summary.total} passed, failed=${summary.failed}`);
console.log(`cleanup: temp workspace removed = ${removedOk}`);

const allPassed = summary.failed === 0 && typecheck.exit === 0 && removedOk === true;
console.log(`exit=${allPassed ? 0 : 1}`);
process.exit(allPassed ? 0 : 1);
