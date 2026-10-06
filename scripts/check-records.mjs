#!/usr/bin/env node
// scripts/check-records.mjs
// Zero-dependency harness (tsx-run) for hospital-ai-miniapp/shared/services/records.ts.
// Installs a Map-backed wx shim (same pattern as scripts/check-storage.mjs), then
// dynamically imports the module under test and exercises every entity.
//
// Modes:
//   (default)                 happy run -> artifacts/e2e/records.json, exit 0 on all-pass
//   --simulate-dirty-update   failure demo -> asserts the "no dirty record after
//                             unknown-id update" check can actually fail; writes
//                             artifacts/qa/7-failure.txt and exits non-zero.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  countPrefix,
  createWxShim,
  deepEq,
  keysWithPrefix,
  makeRawList,
  makeRecord,
  makeRunTypecheck,
  resetStore,
} from './lib/check-helpers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const simulateDirtyUpdate = process.argv.includes('--simulate-dirty-update');

globalThis.wx = createWxShim();
const wx = globalThis.wx;

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

// --- Shared assertion: update on an unknown id must throw and write nothing ---
function checkUnknownIdUpdate(store, entityKey) {
  const unknown = 'sym_0_zzz';
  const beforeKeys = countPrefix(NS);
  const beforeRecords = rawList(entityKey).length;
  let threw = false;
  let message = '';
  try {
    store.update(unknown, { text: 'should-not-exist' });
  } catch (e) {
    threw = true;
    message = e && e.message ? String(e.message) : String(e);
  }
  const afterKeys = countPrefix(NS);
  const afterRecords = rawList(entityKey).length;
  const dirty = rawList(entityKey).some((r) => r.id === unknown);
  return {
    pass: threw && !dirty && afterKeys === beforeKeys && afterRecords === beforeRecords,
    details: {
      unknown_id: unknown,
      threw,
      message_includes_id: message.includes(unknown),
      message,
      keys_before: beforeKeys,
      keys_after: afterKeys,
      records_before: beforeRecords,
      records_after: afterRecords,
      dirty_record_present: dirty,
    },
  };
}

// ---------------------------------------------------------------------------
// Failure demo (--simulate-dirty-update)
// ---------------------------------------------------------------------------
const SAMPLES = {
  profile: {
    name: '示例称呼',
    ageRange: '30-39',
    gender: '男',
    allergies: '无',
    medications: '无',
    history: '无',
  },
  symptoms: {
    occurredAt: '2026-09-01T09:00:00.000Z',
    duration: '3 天',
    text: '原话症状描述',
    impact: '影响睡眠',
    tags: ['咳嗽'],
    attachment: null,
  },
  notes: {
    name: '检查单',
    excerpt: '摘录文字',
    sourceDate: '2026-08-20',
    attachment: '/local/attachments/a.png',
    remark: '备注',
  },
  questions: { text: '这个症状要问医生什么？', done: false, group: '症状' },
  briefs: { content: '摘要正文', sourceIds: ['sym_1_a'], exportedAt: null },
};

const PATCHES = {
  profile: { ageRange: '40-49' },
  symptoms: { impact: '影响工作', tags: ['咳嗽', '低热'] },
  notes: { remark: '备注 v2', attachment: null },
  questions: { done: true },
  briefs: { exportedAt: '2026-09-02T00:00:00.000Z', content: '摘要正文 v2' },
};

if (simulateDirtyUpdate) {
  const lines = [];
  const log = (...parts) => {
    const msg = parts.join(' ');
    lines.push(msg);
    console.log(msg);
  };

  resetStore();
  records.symptoms.add(SAMPLES.symptoms);
  const key = `${NS}${ENTITY_KEYS.symptoms}`;
  const seededCount = rawList(ENTITY_KEYS.symptoms).length;

  const unknown = 'sym_0_dirty';
  const naiveUpdate = (id, patch) => {
    // Broken implementation: creates a record for an unknown id instead of throwing.
    const list = rawList(ENTITY_KEYS.symptoms);
    const ts = new Date().toISOString();
    const record = {
      id,
      text: patch && patch.text ? patch.text : 'naive',
      occurredAt: ts,
      duration: '',
      impact: '',
      tags: [],
      attachment: null,
      createdAt: ts,
      updatedAt: ts,
    };
    list.push(record);
    wx.setStorageSync(key, list);
    return record;
  };
  const brokenStore = { ...records.symptoms, update: naiveUpdate };

  log(`[simulate-dirty-update] seeded symptom records = ${seededCount}`);
  log(`[simulate-dirty-update] unknown id = ${unknown}`);

  const beforeKeys = countPrefix(NS);
  let threw = false;
  try {
    brokenStore.update(unknown, { text: 'dirty-write' });
  } catch (e) {
    threw = true;
  }
  const dirty = rawList(ENTITY_KEYS.symptoms).some((r) => r.id === unknown);
  const afterKeys = countPrefix(NS);
  const assertionPass = threw && !dirty && afterKeys === beforeKeys;

  log(`[simulate-dirty-update] update threw = ${threw}`);
  log(`[simulate-dirty-update] record with unknown id created = ${dirty}`);
  log(`[simulate-dirty-update] mhp_* key count before/after = ${beforeKeys}/${afterKeys}`);
  log(
    `[simulate-dirty-update] assertion "no dirty record after unknown-id update" passed = ${assertionPass}`
  );

  if (!assertionPass) {
    log('ASSERTION FAILED: broken update created a dirty record for an unknown id.');
    log('Failure demo confirms the happy-run assertion can actually fail.');

    const outDir = resolve(root, 'artifacts/qa');
    mkdirSync(outDir, { recursive: true });
    const body = [
      'T7 records failure demo (--simulate-dirty-update)',
      'command: npx tsx scripts/check-records.mjs --simulate-dirty-update',
      `timestamp: ${new Date().toISOString()}`,
      '',
      ...lines,
      '',
      'exit_code: 1',
      '',
    ].join('\n');
    writeFileSync(resolve(outDir, '7-failure.txt'), body);
    process.exit(1);
  }

  log('UNEXPECTED: broken update did not create a dirty record; failure demo did not fail.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Happy run
// ---------------------------------------------------------------------------
const typecheck = runTypecheck();
const cases = [];
const record = makeRecord(cases);

const entityConfig = [
  { name: 'profile', store: records.profile, sample: SAMPLES.profile, patch: PATCHES.profile },
  { name: 'symptoms', store: records.symptoms, sample: SAMPLES.symptoms, patch: PATCHES.symptoms },
  { name: 'notes', store: records.notes, sample: SAMPLES.notes, patch: PATCHES.notes },
  { name: 'questions', store: records.questions, sample: SAMPLES.questions, patch: PATCHES.questions },
  { name: 'briefs', store: records.briefs, sample: SAMPLES.briefs, patch: PATCHES.briefs },
];

for (const cfg of entityConfig) {
  // add -> get -> list -> update -> remove round
  resetStore();
  const created = cfg.store.add(cfg.sample);
  const got = cfg.store.get(created.id);
  const readBackEqual = deepEq(got, created);
  const listed = cfg.store.list();
  const listContains = listed.some((r) => r.id === created.id);
  const updated = cfg.store.update(created.id, cfg.patch);
  const patchApplied = Object.keys(cfg.patch).every((k) => deepEq(updated[k], cfg.patch[k]));
  const identityKept = updated.id === created.id && updated.createdAt === created.createdAt;
  const afterUpdateGet = cfg.store.get(created.id);
  const persisted = deepEq(afterUpdateGet, updated);
  const removed = cfg.store.remove(created.id);
  const gone = cfg.store.get(created.id) === null;
  const emptyAfterRemove = cfg.store.list().length === 0;

  record(
    `${cfg.name}: CRUD roundtrip (add->get->update->list->remove)`,
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

  record(`${cfg.name}: id matches /^[a-z]+_\\d+_[a-z0-9]+$/`, ID_RE.test(created.id), {
    id: created.id,
    regex: String(ID_RE),
  });

  // Two consecutive updates: updatedAt must be non-decreasing.
  resetStore();
  const seeded = cfg.store.add(cfg.sample);
  const first = cfg.store.update(seeded.id, cfg.patch);
  const second = cfg.store.update(seeded.id, cfg.patch);
  const nonDecreasing = first.updatedAt <= second.updatedAt;
  record(`${cfg.name}: updatedAt non-decreasing across two updates`, nonDecreasing, {
    first_updatedAt: first.updatedAt,
    second_updatedAt: second.updatedAt,
    first_createdAt: first.createdAt,
    second_createdAt: second.createdAt,
  });
}

// Singleton profile: list stays 0..1 even after a second add.
resetStore();
const emptyProfile = records.profile.list().length === 0;
const p1 = records.profile.add(SAMPLES.profile);
const p2 = records.profile.add({ ...SAMPLES.profile, name: 'second' });
const profileList = records.profile.list();
record(
  'profile: singleton list stays 0..1 (second add replaces)',
  emptyProfile && profileList.length === 1 && profileList[0].id === p2.id && p1.id !== p2.id,
  { empty_before: emptyProfile, list_length: profileList.length, kept_id: profileList[0] && profileList[0].id }
);

// updatedAt guard: a stored future timestamp must be preserved, never regressed.
resetStore();
const guardSeed = records.symptoms.add(SAMPLES.symptoms);
const guardKey = `${NS}${ENTITY_KEYS.symptoms}`;
const rawGuard = wx.getStorageSync(guardKey);
rawGuard[0].updatedAt = '2999-01-01T00:00:00.000Z';
wx.setStorageSync(guardKey, rawGuard);
const guarded = records.symptoms.update(guardSeed.id, { impact: 'x' });
record(
  'symptoms: updatedAt guard never regresses below previous value',
  guarded.updatedAt === '2999-01-01T00:00:00.000Z',
  { stored_future: '2999-01-01T00:00:00.000Z', after_update: guarded.updatedAt }
);

// Symptom text is required and non-empty.
resetStore();
let emptyTextThrew = false;
let emptyTextMessage = '';
try {
  records.symptoms.add({ ...SAMPLES.symptoms, text: '   ' });
} catch (e) {
  emptyTextThrew = true;
  emptyTextMessage = e && e.message ? String(e.message) : String(e);
}
record(
  'symptoms: empty text (原话) is rejected and writes nothing',
  emptyTextThrew && rawList(ENTITY_KEYS.symptoms).length === 0,
  { threw: emptyTextThrew, message: emptyTextMessage, records_written: rawList(ENTITY_KEYS.symptoms).length }
);

// Unknown-id update: throws, writes nothing (the core failure assertion).
resetStore();
records.symptoms.add(SAMPLES.symptoms);
const unknownCheck = checkUnknownIdUpdate(records.symptoms, ENTITY_KEYS.symptoms);
record('unknown-id update throws and writes no dirty record', unknownCheck.pass, unknownCheck.details);

// deleteAll(): clears mhp_* only, preserves non-mhp keys.
resetStore();
records.symptoms.add(SAMPLES.symptoms);
records.notes.add(SAMPLES.notes);
records.preferences.update({ aiEnabled: true });
wx.setStorageSync('other_key', 'keep-me');
wx.setStorageSync('hza_x', 'legacy');
const mhpBefore = countPrefix(NS);
const cleared = records.deleteAll();
const mhpAfter = countPrefix(NS);
record(
  'deleteAll clears mhp_* and preserves non-mhp (other_key, hza_x)',
  mhpBefore > 0 &&
    mhpAfter === 0 &&
    cleared === mhpBefore &&
    wx.getStorageSync('other_key') === 'keep-me' &&
    wx.getStorageSync('hza_x') === 'legacy',
  {
    mhp_before: mhpBefore,
    mhp_after: mhpAfter,
    cleared,
    other_key: wx.getStorageSync('other_key'),
    hza_x: wx.getStorageSync('hza_x'),
    non_mhp_keys: keysWithPrefix('hza_').concat(keysWithPrefix('other_')),
  }
);

// AppPreferences: defaults when unset.
resetStore();
const defaults = records.preferences.get();
record(
  'preferences: defaults when unset (aiEnabled=false, fontSize=14, highContrast=false)',
  defaults.aiEnabled === false &&
    defaults.consentVersion === null &&
    defaults.fontSize === 14 &&
    defaults.highContrast === false,
  { defaults }
);

// AppPreferences: update merges, clamps fontSize, persists.
resetStore();
const prefsUpdated = records.preferences.update({ aiEnabled: true, consentVersion: 2, fontSize: 40 });
const prefsRead = records.preferences.get();
record(
  'preferences: update persists, merges defaults, clamps fontSize to 14..32',
  prefsUpdated.aiEnabled === true &&
    prefsUpdated.consentVersion === 2 &&
    prefsUpdated.fontSize === 32 &&
    prefsUpdated.highContrast === false &&
    deepEq(prefsRead, prefsUpdated) &&
    typeof prefsRead.updatedAt === 'string' &&
    prefsRead.updatedAt.length > 0,
  { written: prefsUpdated, read: prefsRead }
);

// AppPreferences: remove resets to defaults.
resetStore();
records.preferences.update({ aiEnabled: true });
records.preferences.remove();
const prefsAfterRemove = records.preferences.get();
record(
  'preferences: remove resets to defaults',
  prefsAfterRemove.aiEnabled === false && prefsAfterRemove.fontSize === 14,
  { after_remove: prefsAfterRemove }
);

// QuestionList: dedupe-aware bulk import.
resetStore();
const batch1 = records.questions.importMany([
  { text: 'A' },
  { text: '  a  ' },
  { text: 'B' },
  { text: 'D', source: 'ai' },
]);
const batch2 = records.questions.importMany([{ text: 'a' }, { text: 'C' }]);
const allQuestions = records.questions.list();
record(
  'questions: dedupe-aware bulk import (batch + existing)',
  batch1.added.length === 3 &&
    batch1.skipped === 1 &&
    batch2.added.length === 1 &&
    batch2.skipped === 1 &&
    allQuestions.length === 4 &&
    allQuestions.some((q) => q.text === 'D' && q.source === 'ai'),
  {
    batch1_added: batch1.added.length,
    batch1_skipped: batch1.skipped,
    batch2_added: batch2.added.length,
    batch2_skipped: batch2.skipped,
    total: allQuestions.length,
  }
);

const summary = {
  total: cases.length,
  passed: cases.filter((c) => c.pass).length,
  failed: cases.filter((c) => !c.pass).length,
  typecheck_exit: typecheck.exit,
};

const artifact = {
  command: 'npx tsx scripts/check-records.mjs',
  timestamp: new Date().toISOString(),
  cases,
  typecheck,
  summary,
};

const e2eDir = resolve(root, 'artifacts/e2e');
mkdirSync(e2eDir, { recursive: true });
writeFileSync(resolve(e2eDir, 'records.json'), `${JSON.stringify(artifact, null, 2)}\n`);

for (const c of cases) {
  console.log(`${c.pass ? 'PASS' : 'FAIL'} - ${c.name}`);
}
console.log(`typecheck exit=${typecheck.exit}`);
console.log(`cases ${summary.passed}/${summary.total} passed, failed=${summary.failed}`);

const allPassed = summary.failed === 0 && typecheck.exit === 0;
process.exit(allPassed ? 0 : 1);
