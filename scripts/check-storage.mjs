#!/usr/bin/env node
// scripts/check-storage.mjs
// Zero-dependency harness (tsx-run) for hospital-ai-miniapp/shared/utils/storage.ts.
// Installs a Map-backed wx shim, then dynamically imports the module under test.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  countPrefix,
  createWxShim,
  keysWithPrefix,
  makeRecord,
  makeRunTypecheck,
  resetStore,
} from './lib/check-helpers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const simulateResidue = process.argv.includes('--simulate-residue');

globalThis.wx = createWxShim();

const wx = globalThis.wx;

// --- Type check gate (raw exit code captured) ---
const runTypecheck = makeRunTypecheck(root);

const storageModuleUrl = pathToFileURL(
  resolve(root, 'hospital-ai-miniapp/shared/utils/storage.ts')
).href;
const storage = await import(storageModuleUrl);

const { NS, SCHEMA_VERSION } = storage;

// --- Failure demo: simulate a broken purge so residue must remain ---
if (simulateResidue) {
  const lines = [];
  const log = (...parts) => {
    const msg = parts.join(' ');
    lines.push(msg);
    console.log(msg);
  };

  resetStore();
  // Seed legacy hza_* keys plus a non-legacy control key.
  wx.setStorageSync('hza_old', 'legacy-1');
  wx.setStorageSync('hza_appointments', 'legacy-2');
  wx.setStorageSync('other_key', 'keep-me');

  log('[simulate-residue] seeded hza_* keys:', JSON.stringify(keysWithPrefix('hza_')));

  // Broken purge: intentionally a no-op (simulates a regression in purgeLegacy).
  const brokenPurge = () => 0;
  brokenPurge();

  const residue = countPrefix('hza_');
  log(`[simulate-residue] residue hza_* count after broken purge = ${residue}`);

  if (residue !== 0) {
    log(`ASSERTION FAILED: purgeLegacy (simulated broken) left ${residue} hza_* key(s) behind.`);
    log('Expected 0 residue hza_* keys; failure demo confirms the assertion can actually fail.');

    const outDir = resolve(root, 'artifacts/qa');
    mkdirSync(outDir, { recursive: true });
    const body = [
      'T6 storage failure demo (--simulate-residue)',
      `command: npx tsx scripts/check-storage.mjs --simulate-residue`,
      `timestamp: ${new Date().toISOString()}`,
      '',
      ...lines,
      '',
      `exit_code: 1`,
      '',
    ].join('\n');
    writeFileSync(resolve(outDir, '6-failure.txt'), body);
    process.exit(1);
  }

  log('UNEXPECTED: broken purge left no residue; failure demo did not fail.');
  process.exit(1);
}

// --- Happy run ---
const typecheck = runTypecheck();
const cases = [];
const record = makeRecord(cases);

// Case 1: set/get/remove roundtrip
resetStore();
storage.set('alpha', { n: 1 });
const gotAlpha = storage.get('alpha');
storage.remove('alpha');
record(
  'set/get/remove roundtrip',
  JSON.stringify(gotAlpha) === JSON.stringify({ n: 1 }) && countPrefix('mhp_') === 0,
  { got: gotAlpha, mhp_count_after_remove: countPrefix('mhp_') }
);

// Case 2: clearAll removes only mhp_*, preserves non-mhp
resetStore();
storage.set('one', 1);
storage.set('two', 2);
wx.setStorageSync('other_key', 'keep');
wx.setStorageSync('hza_old', 'legacy');
const cleared = storage.clearAll();
record(
  'clearAll removes mhp_* and preserves non-mhp keys',
  countPrefix('mhp_') === 0 && wx.getStorageSync('other_key') === 'keep' && wx.getStorageSync('hza_old') === 'legacy',
  {
    removed: cleared,
    mhp_count: countPrefix('mhp_'),
    other_key: wx.getStorageSync('other_key'),
    hza_old: wx.getStorageSync('hza_old'),
  }
);

// Case 3: purgeLegacy removes all hza_*, preserves mhp_*
resetStore();
storage.set('keep', 'mhp-value');
wx.setStorageSync('hza_a', 1);
wx.setStorageSync('hza_b', 2);
const purged = storage.purgeLegacy();
record(
  'purgeLegacy removes all hza_* and preserves mhp_*',
  countPrefix('hza_') === 0 && countPrefix('mhp_') === 1 && storage.get('keep') === 'mhp-value',
  { purged, hza_count: countPrefix('hza_'), mhp_count: countPrefix('mhp_') }
);

// Case 4: schema version default/set/get
resetStore();
const defaultVersion = storage.getSchemaVersion();
storage.setSchemaVersion(7);
const readVersion = storage.getSchemaVersion();
record(
  'schema version default/set/get',
  defaultVersion === SCHEMA_VERSION &&
    readVersion === 7 &&
    wx.getStorageSync(`${NS}schema_version`) === 7,
  { defaultVersion, expectedDefault: SCHEMA_VERSION, readVersion, raw: wx.getStorageSync(`${NS}schema_version`) }
);

// Case 5: list() returns only mhp_* keys
resetStore();
storage.set('x', 1);
storage.set('y', 2);
wx.setStorageSync('other_key', 'keep');
wx.setStorageSync('hza_legacy', 'old');
const listed = storage.list();
record(
  'list() returns only mhp_* keys',
  listed.length === 2 && listed.every((key) => key.indexOf(NS) === 0),
  { listed, other_key_present: listed.includes('other_key') }
);

// Case 6: clearAll idempotent (second run no-op)
resetStore();
storage.set('z', 1);
const firstClear = storage.clearAll();
const secondClear = storage.clearAll();
record(
  'clearAll is idempotent (second run no-op)',
  firstClear === 1 && secondClear === 0 && countPrefix('mhp_') === 0,
  { firstClear, secondClear, mhp_count: countPrefix('mhp_') }
);

const summary = {
  total: cases.length,
  passed: cases.filter((c) => c.pass).length,
  failed: cases.filter((c) => !c.pass).length,
  typecheck_exit: typecheck.exit,
};

const artifact = {
  command: 'npx tsx scripts/check-storage.mjs',
  timestamp: new Date().toISOString(),
  cases,
  typecheck,
  summary,
};

const e2eDir = resolve(root, 'artifacts/e2e');
mkdirSync(e2eDir, { recursive: true });
writeFileSync(resolve(e2eDir, 'storage.json'), `${JSON.stringify(artifact, null, 2)}\n`);

for (const c of cases) {
  console.log(`${c.pass ? 'PASS' : 'FAIL'} - ${c.name}`);
}
console.log(`typecheck exit=${typecheck.exit}`);
console.log(`cases ${summary.passed}/${summary.total} passed, failed=${summary.failed}`);

const allPassed = summary.failed === 0 && typecheck.exit === 0;
process.exit(allPassed ? 0 : 1);
