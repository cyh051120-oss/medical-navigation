#!/usr/bin/env node
// scripts/check-memory.mjs
// Zero-dependency harness (tsx-run) for the task-42 MemoryItem entity in
// hospital-ai-miniapp/shared/services/records.ts. Installs a Map-backed wx shim
// (same pattern as scripts/check-records.mjs), then dynamically imports the
// module under test and exercises the memory store + `autoMemory` preference.
//
// Modes:
//   (default)                 happy run -> artifacts/e2e/memory.json, exit 0 on all-pass
//   --simulate-failure        failure demo -> runs the REAL store against
//   --simulate-unknown-update   invalid operations and proves the guards fire with
//   --simulate-empty-text       no dirty write; writes artifacts/qa/42-failure.txt
//                             and exits non-zero (the failure-mode contract).
//                             The three flags are aliases and run the same demos.

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  countPrefix,
  createWxShim,
  deepEq,
  makeRawList,
  makeRecord,
  makeRunTypecheck,
  resetStore,
} from './lib/check-helpers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const failureMode =
  process.argv.includes('--simulate-failure') ||
  process.argv.includes('--simulate-unknown-update') ||
  process.argv.includes('--simulate-empty-text');

globalThis.wx = createWxShim();
const wx = globalThis.wx;

// Byte-identity snapshot of the whole Map (keys sorted for determinism).
function snapshotStore() {
  return JSON.stringify(
    Array.from(wx._store.entries()).sort((a, b) => a[0].localeCompare(b[0]))
  );
}

function errorMessage(e) {
  return e && e.message ? String(e.message) : String(e);
}

// --- Type check gate (raw exit code captured) ---
const runTypecheck = makeRunTypecheck(root);

// --- Load modules under test (after wx shim is installed) ---
const recordsUrl = pathToFileURL(
  resolve(root, 'hospital-ai-miniapp/shared/services/records.ts')
).href;
const records = await import(recordsUrl);

const storageUrl = pathToFileURL(
  resolve(root, 'hospital-ai-miniapp/shared/utils/storage.ts')
).href;
const storage = await import(storageUrl);

const { NS } = storage;
const { ENTITY_KEYS } = records;
const ID_RE = /^[a-z]+_\d+_[a-z0-9]+$/;

const rawList = makeRawList(NS);

const MEMORY_KEY = `${NS}${ENTITY_KEYS.memory}`;
const SAMPLE = { text: '偏好清淡饮食', source: 'manual', enabled: true };
const SAMPLE_SYMPTOM = {
  occurredAt: '2026-09-01T09:00:00.000Z',
  duration: '3 天',
  text: '原话症状描述',
  impact: '影响睡眠',
  tags: ['咳嗽'],
  attachment: null,
};

// ---------------------------------------------------------------------------
// Failure demo (--simulate-failure / --simulate-unknown-update / --simulate-empty-text)
// ---------------------------------------------------------------------------
if (failureMode) {
  const lines = [];
  const log = (...parts) => {
    const msg = parts.join(' ');
    lines.push(msg);
    console.log(msg);
  };

  log('[simulate] unknown-id update throws and writes nothing (byte-identical store)');
  resetStore();
  records.memory.add(SAMPLE);
  const unknown = 'mem_0_missing';
  const beforeUnknown = snapshotStore();
  let unknownThrew = false;
  let unknownMessage = '';
  try {
    records.memory.update(unknown, { text: 'should-not-exist' });
  } catch (e) {
    unknownThrew = true;
    unknownMessage = errorMessage(e);
  }
  const afterUnknown = snapshotStore();
  const unknownDirty = rawList(ENTITY_KEYS.memory).some((r) => r.id === unknown);
  log(`[simulate]   threw = ${unknownThrew}`);
  log(`[simulate]   message_includes_id = ${unknownMessage.includes(unknown)}`);
  log(`[simulate]   message = ${unknownMessage}`);
  log(`[simulate]   dirty_record_present = ${unknownDirty}`);
  log(`[simulate]   storage_byte_identical = ${beforeUnknown === afterUnknown}`);

  log('[simulate] empty/whitespace text on add is rejected and writes nothing');
  resetStore();
  const beforeEmptyAdd = snapshotStore();
  let emptyAddThrew = false;
  let emptyAddMessage = '';
  try {
    records.memory.add({ text: '   ' });
  } catch (e) {
    emptyAddThrew = true;
    emptyAddMessage = errorMessage(e);
  }
  const afterEmptyAdd = snapshotStore();
  log(`[simulate]   threw = ${emptyAddThrew}`);
  log(`[simulate]   message = ${emptyAddMessage}`);
  log(`[simulate]   memory_records_written = ${rawList(ENTITY_KEYS.memory).length}`);
  log(`[simulate]   storage_byte_identical = ${beforeEmptyAdd === afterEmptyAdd}`);

  log('[simulate] empty/whitespace text on update is rejected and writes nothing');
  resetStore();
  const seeded = records.memory.add(SAMPLE);
  const beforeEmptyUpdate = snapshotStore();
  let emptyUpdateThrew = false;
  let emptyUpdateMessage = '';
  try {
    records.memory.update(seeded.id, { text: '   ' });
  } catch (e) {
    emptyUpdateThrew = true;
    emptyUpdateMessage = errorMessage(e);
  }
  const afterEmptyUpdate = snapshotStore();
  const unchanged = deepEq(records.memory.get(seeded.id), seeded);
  log(`[simulate]   threw = ${emptyUpdateThrew}`);
  log(`[simulate]   message = ${emptyUpdateMessage}`);
  log(`[simulate]   record_unchanged = ${unchanged}`);
  log(`[simulate]   storage_byte_identical = ${beforeEmptyUpdate === afterEmptyUpdate}`);

  log(
    '[simulate] guards verified: unknown-id update threw, whitespace text rejected on add and update, no dirty write'
  );

  const outDir = resolve(root, 'artifacts/qa');
  mkdirSync(outDir, { recursive: true });
  const body = [
    'T42 memory failure demo (unknown-id update + empty text)',
    `command: npx tsx scripts/check-memory.mjs ${process.argv
      .slice(2)
      .filter((a) => a.startsWith('--simulate'))[0]}`,
    `timestamp: ${new Date().toISOString()}`,
    '',
    ...lines,
    '',
    'exit_code: 1',
    '',
  ].join('\n');
  writeFileSync(resolve(outDir, '42-failure.txt'), body);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Happy run
// ---------------------------------------------------------------------------
const typecheck = runTypecheck();
const cases = [];
const record = makeRecord(cases);

// memory: CRUD roundtrip + text trimming.
resetStore();
const created = records.memory.add({ text: '  偏好清淡饮食  ' });
const textTrimmed = created.text === '偏好清淡饮食';
const got = records.memory.get(created.id);
const readBackEqual = deepEq(got, created);
const listed = records.memory.list();
const listContains = listed.some((r) => r.id === created.id);
const updated = records.memory.update(created.id, { text: '  偏好早睡  ', enabled: false });
const patchApplied = updated.text === '偏好早睡' && updated.enabled === false;
const identityKept = updated.id === created.id && updated.createdAt === created.createdAt;
const afterUpdateGet = records.memory.get(created.id);
const persisted = deepEq(afterUpdateGet, updated);
const removed = records.memory.remove(created.id);
const gone = records.memory.get(created.id) === null;
const emptyAfterRemove = records.memory.list().length === 0;
record(
  'memory: CRUD roundtrip (add->get->update->list->remove), text trimmed',
  textTrimmed &&
    readBackEqual &&
    listContains &&
    patchApplied &&
    identityKept &&
    persisted &&
    removed === true &&
    gone &&
    emptyAfterRemove,
  {
    id: created.id,
    text_trimmed: textTrimmed,
    read_back_equal: readBackEqual,
    list_contains: listContains,
    patch_applied: patchApplied,
    identity_kept: identityKept,
    update_persisted: persisted,
    remove_returned: removed,
    get_after_remove_null: gone,
    list_empty_after_remove: emptyAfterRemove,
  }
);

// memory: id shape + mem_ prefix.
record(
  'memory: id matches /^[a-z]+_\\d+_[a-z0-9]+$/ and has mem_ prefix',
  ID_RE.test(created.id) && created.id.indexOf('mem_') === 0,
  { id: created.id, regex: String(ID_RE) }
);

// memory: defaults materialized on add.
resetStore();
const defaulted = records.memory.add({ text: '默认值' });
const defaultedRaw = rawList(ENTITY_KEYS.memory)[0];
record(
  "memory: defaults materialized (source='manual', enabled=true)",
  defaulted.source === 'manual' &&
    defaulted.enabled === true &&
    defaultedRaw &&
    defaultedRaw.source === 'manual' &&
    defaultedRaw.enabled === true,
  { returned: defaulted, stored: defaultedRaw }
);

// memory: explicit source='ai' accepted.
resetStore();
const aiItem = records.memory.add({ text: 'AI 提炼的偏好', source: 'ai' });
record("memory: explicit source='ai' accepted", aiItem.source === 'ai' && aiItem.enabled === true, {
  stored: aiItem,
});

// memory: updatedAt non-decreasing across two updates.
resetStore();
const seeded = records.memory.add(SAMPLE);
const first = records.memory.update(seeded.id, { text: '第一次' });
const second = records.memory.update(seeded.id, { text: '第二次' });
record(
  'memory: updatedAt non-decreasing across two updates',
  first.updatedAt <= second.updatedAt,
  {
    first_updatedAt: first.updatedAt,
    second_updatedAt: second.updatedAt,
    first_createdAt: first.createdAt,
    second_createdAt: second.createdAt,
  }
);

// memory: updatedAt guard never regresses below a stored future value.
resetStore();
const guardSeed = records.memory.add(SAMPLE);
const rawGuard = wx.getStorageSync(MEMORY_KEY);
rawGuard[0].updatedAt = '2999-01-01T00:00:00.000Z';
wx.setStorageSync(MEMORY_KEY, rawGuard);
const guarded = records.memory.update(guardSeed.id, { enabled: false });
record(
  'memory: updatedAt guard never regresses below previous value',
  guarded.updatedAt === '2999-01-01T00:00:00.000Z',
  { stored_future: '2999-01-01T00:00:00.000Z', after_update: guarded.updatedAt }
);

// memory: empty/whitespace text rejected on add (no write).
resetStore();
const beforeEmptyAdd = snapshotStore();
let emptyAddThrew = false;
let emptyAddMessage = '';
try {
  records.memory.add({ text: '   ' });
} catch (e) {
  emptyAddThrew = true;
  emptyAddMessage = errorMessage(e);
}
record(
  'memory: empty text rejected on add and writes nothing',
  emptyAddThrew && rawList(ENTITY_KEYS.memory).length === 0 && snapshotStore() === beforeEmptyAdd,
  {
    threw: emptyAddThrew,
    message: emptyAddMessage,
    records_written: rawList(ENTITY_KEYS.memory).length,
    storage_byte_identical: snapshotStore() === beforeEmptyAdd,
  }
);

// memory: empty/whitespace text rejected on update (no dirty record).
resetStore();
const updateSeed = records.memory.add(SAMPLE);
const beforeEmptyUpdate = snapshotStore();
let emptyUpdateThrew = false;
let emptyUpdateMessage = '';
try {
  records.memory.update(updateSeed.id, { text: '  ' });
} catch (e) {
  emptyUpdateThrew = true;
  emptyUpdateMessage = errorMessage(e);
}
const updateUnchanged = deepEq(records.memory.get(updateSeed.id), updateSeed);
record(
  'memory: empty text rejected on update, record unchanged (byte-identical store)',
  emptyUpdateThrew && updateUnchanged && snapshotStore() === beforeEmptyUpdate,
  {
    threw: emptyUpdateThrew,
    message: emptyUpdateMessage,
    record_unchanged: updateUnchanged,
    storage_byte_identical: snapshotStore() === beforeEmptyUpdate,
  }
);

// memory: unknown-id update throws + writes nothing.
resetStore();
records.memory.add(SAMPLE);
const beforeUnknown = snapshotStore();
const unknown = 'mem_0_zzz';
let unknownThrew = false;
let unknownMessage = '';
try {
  records.memory.update(unknown, { text: 'should-not-exist' });
} catch (e) {
  unknownThrew = true;
  unknownMessage = errorMessage(e);
}
const unknownDirty = rawList(ENTITY_KEYS.memory).some((r) => r.id === unknown);
record(
  'memory: unknown-id update throws a clear Error and writes no dirty record',
  unknownThrew &&
    unknownMessage.includes(unknown) &&
    !unknownDirty &&
    snapshotStore() === beforeUnknown,
  {
    unknown_id: unknown,
    threw: unknownThrew,
    message_includes_id: unknownMessage.includes(unknown),
    message: unknownMessage,
    dirty_record_present: unknownDirty,
    storage_byte_identical: snapshotStore() === beforeUnknown,
  }
);

// memory: remove returns false for unknown id.
resetStore();
const removedUnknown = records.memory.remove('mem_0_nope');
record('memory: remove returns false for unknown id', removedUnknown === false, {
  returned: removedUnknown,
});

// deleteAll: clears records_memory (and all mhp_ keys), preserves non-mhp.
resetStore();
records.memory.add(SAMPLE);
records.symptoms.add(SAMPLE_SYMPTOM);
records.preferences.update({ aiEnabled: true });
wx.setStorageSync('other_key', 'keep-me');
wx.setStorageSync('hza_x', 'legacy');
const mhpBefore = countPrefix(NS);
const cleared = records.deleteAll();
const mhpAfter = countPrefix(NS);
record(
  'deleteAll clears records_memory + all mhp_ keys and preserves non-mhp',
  mhpBefore > 0 &&
    mhpAfter === 0 &&
    cleared === mhpBefore &&
    records.memory.list().length === 0 &&
    wx.getStorageSync('other_key') === 'keep-me' &&
    wx.getStorageSync('hza_x') === 'legacy',
  {
    mhp_before: mhpBefore,
    mhp_after: mhpAfter,
    cleared,
    memory_after: records.memory.list().length,
    other_key: wx.getStorageSync('other_key'),
    hza_x: wx.getStorageSync('hza_x'),
  }
);

// preferences: autoMemory defaults to true when unset.
resetStore();
const prefDefaults = records.preferences.get();
record(
  'preferences: autoMemory defaults to true when unset',
  prefDefaults.autoMemory === true,
  { defaults: prefDefaults }
);

// preferences: explicit false persists, other fields merge-kept.
resetStore();
const written = records.preferences.update({ aiEnabled: true, autoMemory: false });
const readBack = records.preferences.get();
record(
  'preferences: autoMemory explicit false persists and other fields are merge-kept',
  written.autoMemory === false &&
    readBack.autoMemory === false &&
    written.aiEnabled === true &&
    readBack.aiEnabled === true &&
    readBack.fontSize === 14 &&
    deepEq(readBack, written),
  { written, read: readBack }
);

// preferences: stored raw missing/invalid autoMemory defaults to true.
resetStore();
wx.setStorageSync(`${NS}${ENTITY_KEYS.preferences}`, { aiEnabled: false, fontSize: 14 });
const missingRead = records.preferences.get();
wx.setStorageSync(`${NS}${ENTITY_KEYS.preferences}`, { autoMemory: 'yes' });
const invalidRead = records.preferences.get();
record(
  'preferences: stored prefs missing/invalid autoMemory default to true',
  missingRead.autoMemory === true && invalidRead.autoMemory === true,
  { missing: missingRead.autoMemory, invalid: invalidRead.autoMemory }
);

// records regression: the untouched task-7 harness must still pass.
const regression = spawnSync('npx', ['tsx', 'scripts/check-records.mjs'], {
  cwd: root,
  encoding: 'utf8',
  // Windows: `npx` is `npx.cmd`; without a shell spawnSync cannot resolve it (status=null).
  shell: process.platform === 'win32',
});
const regressionOutput = `${regression.stdout || ''}${regression.stderr || ''}`.trim();
record('records regression: npx tsx scripts/check-records.mjs exits 0', regression.status === 0, {
  command: 'npx tsx scripts/check-records.mjs',
  exit: regression.status,
  output_tail: regressionOutput.length > 400 ? regressionOutput.slice(-400) : regressionOutput,
});

const summary = {
  total: cases.length,
  passed: cases.filter((c) => c.pass).length,
  failed: cases.filter((c) => !c.pass).length,
  typecheck_exit: typecheck.exit,
};

const artifact = {
  command: 'npx tsx scripts/check-memory.mjs',
  timestamp: new Date().toISOString(),
  cases,
  typecheck,
  summary,
};

const e2eDir = resolve(root, 'artifacts/e2e');
mkdirSync(e2eDir, { recursive: true });
writeFileSync(resolve(e2eDir, 'memory.json'), `${JSON.stringify(artifact, null, 2)}\n`);

for (const c of cases) {
  console.log(`${c.pass ? 'PASS' : 'FAIL'} - ${c.name}`);
}
console.log(`typecheck exit=${typecheck.exit}`);
console.log(`cases ${summary.passed}/${summary.total} passed, failed=${summary.failed}`);

const allPassed = summary.failed === 0 && typecheck.exit === 0;
process.exit(allPassed ? 0 : 1);
