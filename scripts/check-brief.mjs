#!/usr/bin/env node
// scripts/check-brief.mjs
// Zero-dependency harness (tsx-run) for hospital-ai-miniapp/shared/services/brief.ts.
//
// brief.ts keeps `build()` free of host interfaces; only `toClipboard()` calls the
// host clipboard. We therefore install a wx shim BEFORE the dynamic import and use a
// Proxy so that ANY property access on wx is recorded: this proves `build()` never
// touches wx, while `toClipboard()` touches exactly `setClipboardData` once.
//
// Modes:
//   (default)        happy run -> artifacts/checks/brief.json, exit 0 on all-pass.
//   --demo-failure   empty-selection self-test -> prints the raw build({}) output,
//                    asserts the explicit empty state (no fabricated lines/sourceIds),
//                    then runs the SAME assertion against a synthetic fabricated result
//                    and confirms it is REJECTED. Writes artifacts/qa/10-failure.txt.

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

/** Decision words that must never appear in brief output. */
const DECISION_WORDS_RE = /科室|医生|医院|挂号|分诊|诊断|确诊|处方|紧急|高危|重症|危险/;

/** The six section labels, in the fixed rendering order. */
const SECTION_TITLES = ['称呼/年龄段', '症状时间线', '用药', '过敏/既往', '资料摘录', '待问问题'];

/** Serialize `value` and look for decision words. Returns `{ safe, hits, json }`. */
function findViolations(value) {
  const json = typeof value === 'string' ? value : JSON.stringify(value);
  const hits = [];
  const decision = json.match(DECISION_WORDS_RE);
  if (decision !== null) hits.push(...decision);
  return { safe: hits.length === 0, hits: Array.from(new Set(hits)), json };
}

// ---------------------------------------------------------------------------
// wx shim installed BEFORE importing the module under test
// ---------------------------------------------------------------------------

const wxAccess = [];
const clipboardCalls = [];

function createWxShim() {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        const name = typeof prop === 'string' ? prop : String(prop);
        wxAccess.push(name);
        if (name === 'setClipboardData') {
          return (options) => {
            clipboardCalls.push(options);
            if (options && typeof options.success === 'function') options.success({});
          };
        }
        return undefined;
      },
    }
  );
}

globalThis.wx = createWxShim();

const briefUrl = pathToFileURL(
  resolve(root, 'hospital-ai-miniapp/shared/services/brief.ts')
).href;
const brief = await import(briefUrl);
const { build, toClipboard } = brief;

const textsUrl = pathToFileURL(resolve(root, 'hospital-ai-miniapp/config/texts.ts')).href;
const { EMPTY } = await import(textsUrl);

// ---------------------------------------------------------------------------
// Explicit empty-state / fabrication assertion (shared with the failure demo)
// ---------------------------------------------------------------------------

/**
 * The shared empty-state assertion: an empty selection must yield exactly
 * `EMPTY.brief`, zero sections, zero sourceIds, and no section labels.
 * Returns `{ ok, problems }`.
 */
function checkEmptyState(result) {
  if (result === null || typeof result !== 'object') {
    return { ok: false, problems: ['result is not an object'] };
  }
  const problems = [];
  if (result.text !== EMPTY.brief) problems.push('text !== EMPTY.brief');
  if (!Array.isArray(result.sections) || result.sections.length !== 0) {
    problems.push('sections is not empty');
  }
  if (!Array.isArray(result.sourceIds) || result.sourceIds.length !== 0) {
    problems.push('sourceIds is not empty');
  }
  if (typeof result.text === 'string') {
    for (const title of SECTION_TITLES) {
      if (result.text.includes(`【${title}】`)) problems.push(`fabricated section label: ${title}`);
    }
  }
  return { ok: problems.length === 0, problems };
}

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

  log('T10 brief failure demo (--demo-failure)');
  log('command: npx tsx scripts/check-brief.mjs --demo-failure');
  log(`timestamp: ${new Date().toISOString()}`);
  log('');
  log('[input] build({})  (empty selection)');

  const emptyResult = build({});
  log('[raw build({}) output]');
  log(JSON.stringify(emptyResult, null, 2));

  const real = checkEmptyState(emptyResult);
  log('');
  log(`[empty-state] real empty output ok = ${real.ok}; problems = ${JSON.stringify(real.problems)}`);
  log(`[empty-state] text === EMPTY.brief = ${emptyResult.text === EMPTY.brief}`);
  log(`[empty-state] sections length = ${emptyResult.sections.length}`);
  log(`[empty-state] sourceIds length = ${emptyResult.sourceIds.length}`);

  // Self-test: the same assertion must reject a synthetic fabricated result.
  const synthetic = {
    text: '【症状时间线】\n昨天开始头很晕',
    sections: [{ title: '症状时间线', lines: ['昨天开始头很晕'], sourceIds: ['sym_fake'] }],
    sourceIds: ['sym_fake'],
  };
  const synth = checkEmptyState(synthetic);
  log('');
  log(`[self-test] synthetic fabricated object = ${JSON.stringify(synthetic)}`);
  log(
    `[self-test] synthetic rejected by assertion = ${!synth.ok}; problems = ${JSON.stringify(
      synth.problems
    )}`
  );

  const realOk = real.ok;
  const syntheticRejected = !synth.ok;
  const selfTestPassed = realOk && syntheticRejected;

  log('');
  log(`real_empty_ok=${realOk}`);
  log(`synthetic_rejected=${syntheticRejected}`);
  log(`self_test_passed=${selfTestPassed}`);

  const exitCode = selfTestPassed ? 0 : 1;
  log(`exit_code: ${exitCode}`);

  const outDir = resolve(root, 'artifacts/qa');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, '10-failure.txt'), `${lines.join('\n')}\n`);

  process.exit(exitCode);
}

// ---------------------------------------------------------------------------
// Type check gate (raw exit code captured)
// ---------------------------------------------------------------------------

const runTypecheck = makeRunTypecheck(root);

const typecheck = runTypecheck();

// ---------------------------------------------------------------------------
// Sample fixtures
// ---------------------------------------------------------------------------

const TS = '2026-09-01T00:00:00.000Z';

function makeProfile(id, name, ageRange, allergies, medications, history) {
  return { id, name, ageRange, allergies, medications, history, createdAt: TS, updatedAt: TS };
}

function makeSymptom(id, occurredAt, duration, text, impact, tags) {
  return {
    id,
    occurredAt,
    duration,
    text,
    impact,
    tags,
    attachment: null,
    createdAt: TS,
    updatedAt: TS,
  };
}

function makeNote(id, name, excerpt, sourceDate, remark) {
  return {
    id,
    name,
    excerpt,
    sourceDate,
    remark,
    attachment: null,
    createdAt: TS,
    updatedAt: TS,
  };
}

function makeQuestion(id, text, done, group) {
  return { id, text, done, group, source: 'manual', createdAt: TS, updatedAt: TS };
}

const S1_PROFILE = makeProfile('prof_1758000000001_a1b2c3', '李阿姨', '60-69岁', '青霉素', '氨氯地平', '高血压');
const S1_SYM_LATE = makeSymptom(
  'sym_1758000000002_b2c3d4',
  '2026-09-20T08:00:00.000Z',
  '3 天',
  '昨天开始头很晕，站不稳',
  '走路受影响',
  ['头晕']
);
const S1_SYM_EARLY = makeSymptom(
  'sym_1758000000003_c3d4e5',
  '2026-09-18T08:00:00.000Z',
  '1 周',
  '早上起来有点心慌',
  '不明显',
  ['心慌']
);
const S1_NOTE = makeNote('note_1758000000004_d4e5f6', '血常规', '白细胞偏高', '2026-09-21', '社区化验');
const S1_Q1 = makeQuestion('ques_1758000000005_e5f6a7', '这个头晕要不要紧？', false, '症状');
const S1_Q2 = makeQuestion('ques_1758000000006_f6a7b8', '现在的药还要继续吃吗？', true, '用药');

const SAMPLES = [
  {
    name: 'sample 1: full selection (all six sections, exact order)',
    selection: {
      profile: S1_PROFILE,
      symptoms: [S1_SYM_LATE, S1_SYM_EARLY],
      notes: [S1_NOTE],
      questionLists: [S1_Q1, S1_Q2],
    },
    expect: {
      titles: ['称呼/年龄段', '症状时间线', '用药', '过敏/既往', '资料摘录', '待问问题'],
      sourceIds: [
        S1_PROFILE.id,
        S1_SYM_EARLY.id,
        S1_SYM_LATE.id,
        S1_NOTE.id,
        S1_Q1.id,
        S1_Q2.id,
      ],
      verbatim: [S1_SYM_LATE.text, S1_SYM_EARLY.text],
      mustInclude: ['【称呼/年龄段】', '称呼：李阿姨', '【用药】', '长期用药：氨氯地平', '[x] 现在的药还要继续吃吗？'],
    },
  },
  {
    name: 'sample 2: symptoms only (single section)',
    selection: {
      symptoms: [
        makeSymptom('sym_1758000000010_aa10bb', '2026-09-15T07:00:00.000Z', '2 天', '吃东西后有点反酸', '饭后明显', ['反酸']),
        makeSymptom('sym_1758000000011_bb11cc', '2026-09-16T07:00:00.000Z', '半天', '晚上睡觉时腿有点抽', '半夜醒来', ['腿抽']),
      ],
    },
    expect: {
      titles: ['症状时间线'],
      sourceIds: ['sym_1758000000010_aa10bb', 'sym_1758000000011_bb11cc'],
      verbatim: ['吃东西后有点反酸', '晚上睡觉时腿有点抽'],
      mustInclude: ['【症状时间线】'],
    },
  },
  {
    name: 'sample 3: empty selection -> explicit empty state',
    selection: {},
    expect: {
      empty: true,
      titles: [],
      sourceIds: [],
      verbatim: [],
      mustInclude: [],
    },
  },
  {
    name: 'sample 4: multi-symptom ordering (asc, stable ties) + labels',
    selection: {
      symptoms: [
        makeSymptom('sym_1758000000020_cc20dd', '2026-09-22T10:00:00.000Z', '2 天', '晚上咳嗽', '睡眠受影响', ['咳嗽']),
        makeSymptom('sym_1758000000021_dd21ee', '2026-09-19T09:00:00.000Z', '1 天', '早上头晕', '站不稳', ['头晕']),
        makeSymptom('sym_1758000000022_ee22ff', '2026-09-19T09:00:00.000Z', '半天', '下午胃胀', '吃不下', ['胃胀']),
      ],
    },
    expect: {
      titles: ['症状时间线'],
      sourceIds: ['sym_1758000000021_dd21ee', 'sym_1758000000022_ee22ff', 'sym_1758000000020_cc20dd'],
      verbatim: ['晚上咳嗽', '早上头晕', '下午胃胀'],
      mustInclude: ['【症状时间线】', '标签'],
    },
  },
  {
    name: 'sample 5: notes + questions only (gapped section order)',
    selection: {
      notes: [makeNote('note_1758000000030_ff30aa', '化验单', '指标在正常范围', '2026-09-10', '')],
      questionLists: [
        makeQuestion('ques_1758000000031_aa31bb', '最近需要复查吗？', false, '复查'),
        makeQuestion('ques_1758000000032_bb32cc', '饮食要注意什么？', true, '生活'),
      ],
    },
    expect: {
      titles: ['资料摘录', '待问问题'],
      sourceIds: ['note_1758000000030_ff30aa', 'ques_1758000000031_aa31bb', 'ques_1758000000032_bb32cc'],
      verbatim: [],
      mustInclude: ['【资料摘录】', '【待问问题】', '[ ] 最近需要复查吗？', '[x] 饮食要注意什么？'],
    },
  },
];

// ---------------------------------------------------------------------------
// Per-case assertions
// ---------------------------------------------------------------------------

async function runCase(sample) {
  const problems = [];

  const beforeBuild = wxAccess.length;
  const result = build(sample.selection);
  const wxAccessDuringBuild = wxAccess.length - beforeBuild;
  if (wxAccessDuringBuild !== 0) {
    problems.push(`build() accessed wx ${wxAccessDuringBuild} time(s): ${JSON.stringify(wxAccess.slice(beforeBuild))}`);
  }

  const isObject = result !== null && typeof result === 'object';
  const titles = isObject && Array.isArray(result.sections) ? result.sections.map((s) => s.title) : [];
  if (!isObject) problems.push('result is not an object');

  const expectedTitles = sample.expect.titles;
  if (JSON.stringify(titles) !== JSON.stringify(expectedTitles)) {
    problems.push(`section order ${JSON.stringify(titles)} != ${JSON.stringify(expectedTitles)}`);
  }
  for (const title of titles) {
    if (!SECTION_TITLES.includes(title)) problems.push(`unknown section title: ${title}`);
  }

  const sourceIds = isObject && Array.isArray(result.sourceIds) ? result.sourceIds : [];
  if (JSON.stringify(sourceIds) !== JSON.stringify(sample.expect.sourceIds)) {
    problems.push(`sourceIds ${JSON.stringify(sourceIds)} != ${JSON.stringify(sample.expect.sourceIds)}`);
  }

  const text = isObject && typeof result.text === 'string' ? result.text : '';
  for (const phrase of sample.expect.verbatim) {
    if (!text.includes(phrase)) problems.push(`text missing verbatim phrase: ${phrase}`);
  }
  for (const phrase of sample.expect.mustInclude) {
    if (!text.includes(phrase)) problems.push(`text missing expected phrase: ${phrase}`);
  }

  if (sample.expect.empty === true) {
    const empty = checkEmptyState(result);
    for (const problem of empty.problems) problems.push(`empty-state: ${problem}`);
  }

  const safety = findViolations(result);
  if (!safety.safe) problems.push(`decision words present: ${JSON.stringify(safety.hits)}`);

  // Clipboard: capture must equal the built text and contain the user's own words.
  clipboardCalls.length = 0;
  const beforeClip = wxAccess.length;
  let clipError = null;
  try {
    await toClipboard(result.text);
  } catch (error) {
    clipError = error;
  }
  const clipAccessDelta = wxAccess.length - beforeClip;
  const captured = clipboardCalls.length === 1 ? clipboardCalls[0] : null;
  const captureMatches = captured !== null && captured.data === result.text;
  if (clipError !== null) problems.push(`toClipboard rejected: ${clipError && clipError.message}`);
  if (clipboardCalls.length !== 1) problems.push(`clipboard call count = ${clipboardCalls.length}`);
  if (!captureMatches) problems.push('clipboard capture !== text');
  if (clipAccessDelta !== 1) problems.push(`clipboard wx access delta = ${clipAccessDelta}`);
  for (const phrase of sample.expect.verbatim) {
    if (!(captured !== null && typeof captured.data === 'string' && captured.data.includes(phrase))) {
      problems.push(`clipboard missing verbatim phrase: ${phrase}`);
    }
  }

  return {
    name: sample.name,
    pass: problems.length === 0,
    details: {
      selection: sample.selection,
      expected_titles: expectedTitles,
      actual_titles: titles,
      expected_source_ids: sample.expect.sourceIds,
      actual_source_ids: sourceIds,
      verbatim_phrases: sample.expect.verbatim,
      wx_access_during_build: wxAccessDuringBuild,
      decision_words_safe: safety.safe,
      decision_word_hits: safety.hits,
      clipboard_capture_matches_text: captureMatches,
      clipboard_data: captured === null ? null : captured.data,
      problems,
      result,
    },
  };
}

const cases = [];
for (const sample of SAMPLES) {
  cases.push(await runCase(sample));
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
  command: 'npx tsx scripts/check-brief.mjs',
  timestamp: new Date().toISOString(),
  cases,
  typecheck,
  summary,
};

const checksDir = resolve(root, 'artifacts/checks');
mkdirSync(checksDir, { recursive: true });
writeFileSync(resolve(checksDir, 'brief.json'), `${JSON.stringify(artifact, null, 2)}\n`);

for (const c of cases) {
  console.log(`${c.pass ? 'PASS' : 'FAIL'} - ${c.name}`);
  for (const problem of c.details.problems) console.log(`       ${problem}`);
}
console.log(`typecheck exit=${typecheck.exit}`);
console.log(`cases ${summary.passed}/${summary.total} passed, failed=${summary.failed}`);

const allPassed = summary.failed === 0 && typecheck.exit === 0;
process.exit(allPassed ? 0 : 1);
