#!/usr/bin/env node
// scripts/check-ai-render.mjs
// 前端纯逻辑层检查（AI 页重构抽出模块）：
//   - hospital-ai-miniapp/shared/services/aiRender.ts   （渲染/解析/守卫）
//   - hospital-ai-miniapp/shared/services/aiInput.ts    （请求体构造）
//   - hospital-ai-miniapp/pages/ai/ai-types.ts          （页面级类型与守卫）
//   - hospital-ai-miniapp/pages/ai/ai-interview.ts      （问诊草稿纯函数）
//
// 这些模块不依赖 wx / Page，可直接在 node 下测。锁定重构后的对外行为，防止再次漂移。
// 全部通过 -> 写 artifacts/checks/ai-render.json，exit 0。

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const R = await import(
  pathToFileURL(resolve(root, 'hospital-ai-miniapp/shared/services/aiRender.ts')).href
);
const I = await import(
  pathToFileURL(resolve(root, 'hospital-ai-miniapp/shared/services/aiInput.ts')).href
);
const T = await import(pathToFileURL(resolve(root, 'hospital-ai-miniapp/pages/ai/ai-types.ts')).href);
const IV = await import(
  pathToFileURL(resolve(root, 'hospital-ai-miniapp/pages/ai/ai-interview.ts')).href
);

const cases = [];
function record(name, pass, detail) {
  cases.push({ name, pass: pass === true, detail: detail ?? null });
}

// ---- aiRender: organize ----
{
  const blocks = R.organizeBlocks({
    points: ['a', 'b'],
    extracted: { symptoms: ['x'], medications: [], allergies: [], history: [], exams: [] },
    unknowns: ['u'],
    questions: ['q'],
  });
  record(
    'organizeBlocks: points block flagged note, extracted carries tag, questions flagged ask',
    blocks[0].note === true &&
      blocks[0].items.length === 2 &&
      blocks.some((b) => b.type === 'extracted' && b.items[0].tag) &&
      blocks.some((b) => b.ask === true && b.items[0].text === 'q'),
    { blocks }
  );
}

// ---- aiRender: consult ----
{
  const ok = R.consultBlocks({
    directions: [{ text: 't1', citation: { title: 'T', domain: 'd', url: 'u' } }],
    suggestedDepartments: ['全科'],
    citations: [{ title: 'C', domain: 'd', url: 'u' }],
    suggestions: [{ text: 's', citation: { title: 'T', domain: 'd', url: 'u' } }],
    unknowns: [],
    questions: [],
    disclaimer: 'D',
  });
  record(
    'consultBlocks: disclaimer passthrough + directions/citations/suggestions present',
    ok.disclaimer === 'D' &&
      ok.blocks.some((b) => b.type === 'directions') &&
      ok.blocks.some((b) => b.type === 'citations') &&
      ok.blocks.some((b) => b.type === 'suggestions'),
    { disclaimer: ok.disclaimer }
  );
  const empty = R.consultBlocks({
    directions: [],
    suggestedDepartments: [],
    citations: [],
    suggestions: [],
    unknowns: [],
    questions: [],
    disclaimer: 'D',
  });
  record(
    'consultBlocks: no citations -> notice block',
    empty.blocks.some((b) => b.type === 'notice'),
    null
  );
}

// ---- aiRender: guard helpers ----
record(
  'isRedFlag true only for redFlag===true',
  R.isRedFlag({ redFlag: true }) === true && R.isRedFlag({ points: [] }) === false,
  null
);
record(
  'serverErrorEnvelope: unsafe_output+fallback, and success -> empty code',
  JSON.stringify(R.serverErrorEnvelope({ error: 'unsafe_output', fallback: 'organize' })) ===
    JSON.stringify({ code: 'unsafe_output', fallback: 'organize' }) &&
    R.serverErrorEnvelope({ points: [] }).code === '',
  null
);

// ---- aiRender: blocksToText / summarize ----
{
  const blocks = [
    { type: 'list', title: 'x', items: [{ text: 'a', sub: '', url: '', tag: '' }, { text: 'b', sub: '', url: '', tag: '' }] },
  ];
  record('blocksToText joins item texts', R.blocksToText(blocks) === 'a；b', null);
  record('summarize keeps short text intact', R.summarize(blocks) === 'a；b', null);
}

// ---- aiRender: localOrganizeBlocks ----
{
  const blocks = R.localOrganizeBlocks({
    original: 'o',
    points: ['p'],
    extracted: { times: ['tt'], values: [], maybeMeds: ['m'] },
    unknowns: ['u'],
    questions: ['q'],
  });
  record(
    'localOrganizeBlocks: extracted tags present',
    blocks.some((b) => b.type === 'extracted' && b.items.some((i) => i.tag)),
    null
  );
}

// ---- aiRender: interview helpers ----
record(
  'interviewQuestionOf: ask -> {text,slot}; done -> null',
  JSON.stringify(R.interviewQuestionOf({ status: 'ask', question: { text: 'q', slot: 'duration' } })) ===
    JSON.stringify({ text: 'q', slot: 'duration' }) &&
    R.interviewQuestionOf({ status: 'done' }) === null,
  null
);
record(
  'splitTags: dedupes across comma/、/space',
  JSON.stringify(R.splitTags('a, b、c  a')) === JSON.stringify(['a', 'b', 'c']),
  null
);
record(
  'statusTextFor: idle/demo non-empty',
  R.statusTextFor('idle').length > 0 && R.statusTextFor('demo').length > 0,
  null
);

// ---- aiInput: buildAskInput ----
{
  const profile = {
    id: 'p',
    createdAt: '',
    updatedAt: '',
    name: 'n',
    ageRange: '30',
    gender: '',
    allergies: '',
    medications: '',
    history: '',
  };
  const organize = I.buildAskInput('hi', 'organize', {
    messages: [],
    profile,
    includeProfile: true,
    excerpts: ['e'],
    memories: [{ id: 'm', createdAt: '', updatedAt: '', text: 'mem', source: 'manual', enabled: true }],
  });
  record(
    'buildAskInput(organize): drops profile+excerpts, appends user turn',
    organize.profile === null &&
      organize.excerpts.length === 0 &&
      organize.messages.length === 1 &&
      organize.messages[0].content === 'hi',
    null
  );
  const consult = I.buildAskInput('hi', 'consult', {
    messages: [],
    profile,
    includeProfile: true,
    excerpts: ['e'],
    memories: [],
  });
  record(
    'buildAskInput(consult): keeps profile + excerpts',
    consult.profile === profile && consult.excerpts[0] === 'e',
    null
  );
}

// ---- aiInput: buildInterviewInput ----
{
  const out = I.buildInterviewInput('hi', { messages: [], profile: null, round: 2, memories: [] });
  record('buildInterviewInput: round + appended user turn', out.round === 2 && out.messages[0].content === 'hi', null);
}

// ---- ai-types: isAiMessage ----
record(
  'isAiMessage: valid shape true, junk false',
  T.isAiMessage({ id: '1', role: 'assistant', blocks: [] }) === true &&
    T.isAiMessage({ id: '1', role: 'nope', blocks: [] }) === false &&
    T.isAiMessage(null) === false,
  null
);

// ---- ai-interview: interviewDraftFor ----
record(
  'interviewDraftFor: origin trimmed, slot answers mapped, occurredAt passthrough',
  (() => {
    const d = IV.interviewDraftFor({
      answers: [{ slot: 'duration', question: 'q', answer: '3天' }],
      origin: ' 头痛 ',
      messages: [],
      occurredAt: 'T',
    });
    return d.text === '头痛' && d.duration === '3天' && d.impact === '' && d.occurredAt === 'T';
  })(),
  null
);

// ---- ai-interview: interviewDraftFor 修复（A 方案：onset/detail 不再丢弃） ----
record(
  'interviewDraftFor: onset fills occurredAt, detail merged into text',
  (() => {
    const d = IV.interviewDraftFor({
      answers: [
        { slot: 'onset', question: 'q', answer: '昨天晚上' },
        { slot: 'detail', question: 'q', answer: '躺下更疼' },
      ],
      origin: '',
      messages: [],
      occurredAt: 'T',
    });
    return d.text === '躺下更疼' && d.occurredAt === '昨天晚上';
  })(),
  null
);

// ---- ai-interview: noteDraftFor ----
record(
  'noteDraftFor: name passthrough + labeled transcript from origin/answers',
  (() => {
    const f = IV.noteDraftFor({
      answers: [{ slot: 'duration', question: '持续多久？', answer: '3天' }],
      origin: '头痛',
      messages: [],
      name: '问诊记录',
    });
    return (
      f.name === '问诊记录' &&
      f.excerpt.includes('头痛') &&
      f.excerpt.includes('持续时长：3天') &&
      f.remark === ''
    );
  })(),
  null
);

// ---- ai-interview: questionCandidatesFor ----
record(
  'questionCandidatesFor: empty -> []; with text -> 3 non-empty doctor questions',
  (() => {
    const empty = IV.questionCandidatesFor({ answers: [], origin: '', messages: [] });
    const filled = IV.questionCandidatesFor({
      answers: [{ slot: 'onset', question: 'q', answer: '3天前' }],
      origin: '头痛三天',
      messages: [],
    });
    return (
      empty.length === 0 &&
      filled.length === 3 &&
      filled.every((q) => typeof q === 'string' && q.length > 0)
    );
  })(),
  null
);

// ---- ai-interview: matchSaveIntent ----
record(
  'matchSaveIntent: routes short keyword phrases, ignores prose/empty',
  IV.matchSaveIntent('帮我记下来') === 'symptom' &&
    IV.matchSaveIntent('加入待问清单') === 'questions' &&
    IV.matchSaveIntent('摘成笔记') === 'note' &&
    IV.matchSaveIntent('') === null &&
    IV.matchSaveIntent('我最近头痛三天了晚上睡不好白天没精神想请医生看看') === null,
  null
);

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const summary = {
  total: cases.length,
  passed: cases.filter((c) => c.pass).length,
  failed: cases.filter((c) => !c.pass).length,
};

const artifact = {
  command: 'npx tsx scripts/check-ai-render.mjs',
  timestamp: new Date().toISOString(),
  modules: [
    'hospital-ai-miniapp/shared/services/aiRender.ts',
    'hospital-ai-miniapp/shared/services/aiInput.ts',
    'hospital-ai-miniapp/pages/ai/ai-types.ts',
    'hospital-ai-miniapp/pages/ai/ai-interview.ts',
  ],
  cases,
  summary,
};

const outDir = resolve(root, 'artifacts/checks');
mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, 'ai-render.json'), `${JSON.stringify(artifact, null, 2)}\n`);

for (const c of cases) {
  console.log(`${c.pass ? 'PASS' : 'FAIL'} - ${c.name}`);
}
console.log(`cases ${summary.passed}/${summary.total} passed, failed=${summary.failed}`);
console.log(`wrote ${resolve(outDir, 'ai-render.json')}`);

process.exit(summary.failed === 0 ? 0 : 1);
