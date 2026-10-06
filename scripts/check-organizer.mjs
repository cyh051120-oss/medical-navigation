#!/usr/bin/env node
// scripts/check-organizer.mjs
// Zero-dependency harness (tsx-run) for hospital-ai-miniapp/shared/services/organizer.ts.
// organizer.ts is a pure, wx-free module, so no wx shim is required: we dynamically
// import the module under test and exercise it on 6 fixed samples.
//
// Modes:
//   (default)        happy run -> artifacts/checks/organizer.json, exit 0 on all-pass.
//   --demo-failure   detector self-test -> prints raw organize() output for the hostile
//                    input, asserts it is decision-word free, then runs the SAME safety
//                    assertion against a synthetic violating object and confirms it is
//                    REJECTED. Writes artifacts/qa/9-failure.txt.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { makeRunTypecheck } from './lib/check-helpers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const demoFailure = process.argv.includes('--demo-failure');

// ---------------------------------------------------------------------------
// Safety assertion (lives ONLY in scripts/ which is outside the scan scope)
// ---------------------------------------------------------------------------

/** Decision words that must never appear in organizer output. */
const DECISION_WORDS_RE = /科室|医生|医院|挂号|分诊|诊断|确诊|处方|紧急|高危|重症|危险/;

/** Concrete department names, used only by the failure demo. */
const DEPARTMENT_WORDS = [
  '心内科',
  '心外科',
  '急诊科',
  '内科',
  '外科',
  '骨科',
  '儿科',
  '妇科',
  '眼科',
  '耳鼻喉科',
  '皮肤科',
  '口腔科',
  '呼吸科',
  '消化科',
  '神经科',
  '内分泌科',
];

/**
 * The shared safety assertion: serialize `value` and look for decision words or
 * concrete department names. Returns `{ safe, hits, json }`.
 */
function findViolations(value) {
  const json = typeof value === 'string' ? value : JSON.stringify(value);
  const hits = [];
  const decision = json.match(DECISION_WORDS_RE);
  if (decision !== null) hits.push(...decision);
  for (const word of DEPARTMENT_WORDS) {
    if (json.includes(word)) hits.push(word);
  }
  return { safe: hits.length === 0, hits: Array.from(new Set(hits)), json };
}

// ---------------------------------------------------------------------------
// Load module under test
// ---------------------------------------------------------------------------

const organizerUrl = pathToFileURL(
  resolve(root, 'hospital-ai-miniapp/shared/services/organizer.ts')
).href;
const organizer = await import(organizerUrl);
const { organize } = organizer;

// ---------------------------------------------------------------------------
// Failure demo / detector self-test (--demo-failure)
// ---------------------------------------------------------------------------

if (demoFailure) {
  const lines = [];
  const log = (...parts) => {
    const msg = parts.join(' ');
    lines.push(msg);
    console.log(msg);
  };

  const HOSTILE_INPUT = '我胸口剧痛，是不是要心梗了？挂哪个科？';

  log('T9 organizer failure demo (--demo-failure)');
  log('command: npx tsx scripts/check-organizer.mjs --demo-failure');
  log(`timestamp: ${new Date().toISOString()}`);
  log('');
  log(`[input] ${HOSTILE_INPUT}`);

  const result = organize(HOSTILE_INPUT);
  log('[raw organize() output]');
  log(JSON.stringify(result, null, 2));

  const real = findViolations(result);
  log('');
  log(`[safety] real output safe = ${real.safe}; hits = ${JSON.stringify(real.hits)}`);

  // Self-test: the same assertion must reject a synthetic violating output.
  const synthetic = { points: ['建议挂心内科'], questions: ['是不是高危？'] };
  const synth = findViolations(synthetic);
  log(`[self-test] synthetic object = ${JSON.stringify(synthetic)}`);
  log(
    `[self-test] synthetic rejected by assertion = ${!synth.safe}; hits = ${JSON.stringify(
      synth.hits
    )}`
  );

  const realOutputSafe = real.safe;
  const syntheticRejected = !synth.safe;
  const selfTestPassed = realOutputSafe && syntheticRejected;

  log('');
  log(`real_output_safe=${realOutputSafe}`);
  log(`synthetic_rejected=${syntheticRejected}`);
  log(`self_test_passed=${selfTestPassed}`);

  const exitCode = selfTestPassed ? 0 : 1;
  log(`exit_code: ${exitCode}`);

  const outDir = resolve(root, 'artifacts/qa');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, '9-failure.txt'), `${lines.join('\n')}\n`);

  process.exit(exitCode);
}

// ---------------------------------------------------------------------------
// Type check gate (raw exit code captured)
// ---------------------------------------------------------------------------

const runTypecheck = makeRunTypecheck(root);

const typecheck = runTypecheck();

// ---------------------------------------------------------------------------
// Sample cases
// ---------------------------------------------------------------------------

const SAMPLES = [
  {
    name: 'sample 1: typical multi-symptom',
    input: '最近总是头痛，还有点恶心，晚上睡不好。',
    expect: { minPoints: 2 },
  },
  {
    name: 'sample 2: short / empty input',
    input: '',
    expect: { empty: true },
  },
  {
    name: 'sample 3: explicit times',
    input: '昨天下午开始肚子疼，3 天前也痛过一次。',
    expect: { timesInclude: ['昨天', '下午', '3 天前'] },
  },
  {
    name: 'sample 4: numeric values',
    input: '血压 140，体温 38.5 度，已经 5 年了。',
    expect: { valuesInclude: ['140', '38.5 度', '5 年'] },
  },
  {
    name: 'sample 5: medicines',
    input: '最近在吃退烧药和阿莫西林胶囊，还有降压药。',
    expect: { medsInclude: ['退烧药', '阿莫西林胶囊', '降压药'] },
  },
  {
    name: 'sample 6: long compound text',
    input:
      '上个月开始反复咳嗽，白天还好，晚上更明显，咳痰比较多，体温最高 38 度，吃了感冒药，也做过血常规检查，但没有查出原因，最近还觉得胸闷。',
    expect: { allExtractedNonEmpty: true },
  },
];

const REQUIRED_TOP_KEYS = ['extracted', 'original', 'points', 'questions', 'unknowns'];
const REQUIRED_EXTRACTED_KEYS = ['maybeMeds', 'times', 'values'];

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** Full structural check: exact top-level keys + element types. */
function checkStructure(result, input) {
  const details = { problems: [] };
  if (result === null || typeof result !== 'object') {
    details.problems.push('result is not an object');
    return { ok: false, details };
  }
  const topKeys = Object.keys(result).sort();
  const topKeysExact =
    topKeys.length === REQUIRED_TOP_KEYS.length &&
    topKeys.every((key, i) => key === REQUIRED_TOP_KEYS[i]);
  if (!topKeysExact) details.problems.push(`top-level keys = ${JSON.stringify(topKeys)}`);

  const originalVerbatim = result.original === input;
  if (!originalVerbatim) details.problems.push('original !== input');

  const pointsOk = isStringArray(result.points);
  if (!pointsOk) details.problems.push('points is not a string[]');

  const extracted = result.extracted;
  const extractedIsObject = extracted !== null && typeof extracted === 'object';
  let extractedKeysExact = false;
  let extractionTypesOk = false;
  if (extractedIsObject) {
    const extKeys = Object.keys(extracted).sort();
    extractedKeysExact =
      extKeys.length === REQUIRED_EXTRACTED_KEYS.length &&
      extKeys.every((key, i) => key === REQUIRED_EXTRACTED_KEYS[i]);
    extractionTypesOk =
      isStringArray(extracted.times) &&
      isStringArray(extracted.values) &&
      isStringArray(extracted.maybeMeds);
    if (!extractedKeysExact) details.problems.push(`extracted keys = ${JSON.stringify(extKeys)}`);
    if (!extractionTypesOk) details.problems.push('extracted arrays are not string[]');
  } else {
    details.problems.push('extracted is not an object');
  }

  const unknownsOk = isStringArray(result.unknowns);
  if (!unknownsOk) details.problems.push('unknowns is not a string[]');

  const questionsOk = isStringArray(result.questions);
  if (!questionsOk) details.problems.push('questions is not a string[]');

  const ok =
    topKeysExact &&
    originalVerbatim &&
    pointsOk &&
    extractedIsObject &&
    extractedKeysExact &&
    extractionTypesOk &&
    unknownsOk &&
    questionsOk;

  return {
    ok,
    details: {
      problems: details.problems,
      top_keys: topKeys,
      original_verbatim: originalVerbatim,
      points_is_string_array: pointsOk,
      extracted_keys: extractedIsObject ? Object.keys(extracted).sort() : null,
      extraction_types_ok: extractionTypesOk,
      unknowns_is_string_array: unknownsOk,
      questions_is_string_array: questionsOk,
    },
  };
}

/** Per-sample expectations beyond structure. */
function checkExpectations(result, expect) {
  const problems = [];
  if (expect.empty) {
    if (result.points.length !== 0) problems.push('points not empty');
    if (result.extracted.times.length !== 0) problems.push('times not empty');
    if (result.extracted.values.length !== 0) problems.push('values not empty');
    if (result.extracted.maybeMeds.length !== 0) problems.push('maybeMeds not empty');
  }
  if (typeof expect.minPoints === 'number' && result.points.length < expect.minPoints) {
    problems.push(`points ${result.points.length} < ${expect.minPoints}`);
  }
  for (const t of expect.timesInclude || []) {
    if (!result.extracted.times.includes(t)) problems.push(`times missing "${t}"`);
  }
  for (const v of expect.valuesInclude || []) {
    if (!result.extracted.values.includes(v)) problems.push(`values missing "${v}"`);
  }
  for (const med of expect.medsInclude || []) {
    if (!result.extracted.maybeMeds.includes(med)) problems.push(`maybeMeds missing "${med}"`);
  }
  if (expect.allExtractedNonEmpty) {
    if (result.points.length === 0) problems.push('points empty');
    if (result.extracted.times.length === 0) problems.push('times empty');
    if (result.extracted.values.length === 0) problems.push('values empty');
    if (result.extracted.maybeMeds.length === 0) problems.push('maybeMeds empty');
  }
  return { ok: problems.length === 0, problems };
}

const cases = [];
for (const sample of SAMPLES) {
  const result = organize(sample.input);
  const structure = checkStructure(result, sample.input);
  const expectations = checkExpectations(result, sample.expect);
  const safety = findViolations(result);
  const pass = structure.ok && expectations.ok && safety.safe;
  cases.push({
    name: sample.name,
    pass,
    details: {
      input: sample.input,
      structure_ok: structure.ok,
      structure: structure.details,
      expectation_ok: expectations.ok,
      expectation_problems: expectations.problems,
      decision_words_safe: safety.safe,
      decision_word_hits: safety.hits,
      result,
    },
  });
}

// ---------------------------------------------------------------------------
// Artifact + summary
// ---------------------------------------------------------------------------

const summary = {
  total: cases.length,
  passed: cases.filter((c) => c.pass).length,
  failed: cases.filter((c) => !c.pass).length,
  typecheck_exit: typecheck.exit,
};

const artifact = {
  command: 'npx tsx scripts/check-organizer.mjs',
  timestamp: new Date().toISOString(),
  cases,
  typecheck,
  summary,
};

const checksDir = resolve(root, 'artifacts/checks');
mkdirSync(checksDir, { recursive: true });
writeFileSync(resolve(checksDir, 'organizer.json'), `${JSON.stringify(artifact, null, 2)}\n`);

for (const c of cases) {
  console.log(`${c.pass ? 'PASS' : 'FAIL'} - ${c.name}`);
}
console.log(`typecheck exit=${typecheck.exit}`);
console.log(`cases ${summary.passed}/${summary.total} passed, failed=${summary.failed}`);

const allPassed = summary.failed === 0 && typecheck.exit === 0;
process.exit(allPassed ? 0 : 1);
