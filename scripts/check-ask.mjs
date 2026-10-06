#!/usr/bin/env node
// scripts/check-ask.mjs
// Zero-dependency harness (tsx-run) for server/orchestrator.ts + prompts/validate/redflags (task 25).
//
// Spins up two local mocks bound to 127.0.0.1 on ephemeral ports (OS-assigned):
//   - OpenAI-compatible LLM mock  (POST /chat/completions)
//   - search mock                 (POST /search)  -> {results:[...]}
// then dynamically imports the orchestrator and asserts the dual-mode contract, the deterministic
// safety guardrails, the schema-whitelist validator, context caps and the "never throws" guarantee.
//
// No external network I/O is performed; everything stays on 127.0.0.1.
//
// Modes:
//   (default)            happy run -> artifacts/checks/server-ask.json, exit 0 on all-pass
//   --simulate-failure   raw failure transcript (real unsafe/redflag/upstream runs) ->
//                        artifacts/qa/25-failure.txt, exit 1 (failure-mode contract)

import { createServer } from 'node:http';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  conversationMessages,
  getFreePort,
  listen,
  makeDetailRecord,
  makeLastLlmBody,
  makeSpawnServer,
  readJsonBody,
  startLlmMock,
  stopServer,
  systemContent,
  waitForHealth,
} from './lib/check-helpers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const failureMode = process.argv.includes('--simulate-failure');

// ---------------------------------------------------------------------------
// Modules under test
// ---------------------------------------------------------------------------

const { ask } = await import(pathToFileURL(resolve(root, 'server/orchestrator.ts')).href);
const { SAFETY_NOTICE, RED_FLAG_TERMS, REDFLAG_PATTERN_SOURCES, NEGATION_PATTERN_SOURCES } = await import(
  pathToFileURL(resolve(root, 'server/redflags.ts')).href
);
const { firstBannedDecisionTerm } = await import(
  pathToFileURL(resolve(root, 'server/validate.ts')).href
);
const { CONSULT_DISCLAIMER, CONTROLLED_DEPARTMENTS, LIMITS } = await import(
  pathToFileURL(resolve(root, 'server/prompts.ts')).href
);

// ---------------------------------------------------------------------------
// Fixtures (synthetic; no patient data)
// ---------------------------------------------------------------------------

const SRC_NHC = { title: '国家卫健委：健康提示', url: 'https://nhc.gov.cn/tips/1', snippet: '提示摘要' };
const SRC_CDC = { title: '疾控中心：生活方式建议', url: 'https://www.chinacdc.cn/tips/2', snippet: '建议摘要' };

const ORGANIZE_OK = {
  points: ['近一周出现头痛', '睡眠欠佳'],
  extracted: { symptoms: ['头痛'], medications: [], allergies: [], history: [], exams: [] },
  unknowns: ['头痛诱因未说明'],
  questions: ['头痛从何时开始？'],
};

function consultOk(extra = {}) {
  return {
    directions: [
      { text: '注意休息与规律作息', citation: SRC_NHC.url },
      { text: '保持清淡饮食', citation: SRC_CDC.url },
    ],
    suggestedDepartments: ['消化内科', '全科'],
    suggestions: [{ text: '规律作息，避免熬夜', citation: SRC_NHC.url }],
    unknowns: ['症状持续时间'],
    questions: ['需要做哪些检查？'],
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Mocks (127.0.0.1:0)
// ---------------------------------------------------------------------------

function startSearchMock(name) {
  const state = { mode: 'ok', results: [], requests: [] };
  const server = createServer((req, res) => {
    readJsonBody(req, (raw, parsed) => {
      state.requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: parsed,
        raw_length: raw.length,
      });
      const json = (status, payload) => {
        if (res.writableEnded) return;
        res.statusCode = status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(payload));
      };
      if (state.mode === 'always-500') {
        json(500, { error: { message: 'mock 500' } });
        return;
      }
      json(200, { results: state.results });
    });
  });
  return listen(server, name, state);
}

const llm = await startLlmMock('llm-mock');
const searchMock = await startSearchMock('search-mock');

function makeConfig(overrides = {}) {
  return {
    port: 0,
    demo: false,
    llm: { baseUrl: llm.baseUrl, apiKey: 'sk-llm', model: 'mock-model', ...(overrides.llm ?? {}) },
    search: { baseUrl: searchMock.baseUrl, apiKey: 'sk-search', ...(overrides.search ?? {}) },
    authorityDomains: overrides.authorityDomains ?? [],
  };
}

function resetMocks() {
  llm.state.mode = 'ok';
  llm.state.content = '{}';
  llm.state.requests.length = 0;
  searchMock.state.mode = 'ok';
  searchMock.state.results = [];
  searchMock.state.requests.length = 0;
}

function request(overrides = {}) {
  return {
    mode: 'organize',
    messages: [{ role: 'user', content: '你好' }],
    consent: true,
    ...overrides,
  };
}

const lastLlmBody = makeLastLlmBody(llm);

function itemLines(system, tag) {
  const re = new RegExp(`^- ${tag}[^\\n]*`, 'gm');
  return system.match(re) ?? [];
}

function itemsLength(lines) {
  return lines.reduce((sum, line) => sum + line.replace(/^- /, '').length, 0);
}

function isUnsafe(result) {
  return result !== null && result.error === 'unsafe_output' && result.fallback === 'organize';
}

function hasNoConsultFields(result) {
  return (
    !('directions' in result) &&
    !('suggestedDepartments' in result) &&
    !('citations' in result) &&
    !('suggestions' in result) &&
    !('disclaimer' in result)
  );
}

// ---------------------------------------------------------------------------
// Failure mode (--simulate-failure): raw transcript from REAL runs.
// ---------------------------------------------------------------------------

if (failureMode) {
  const lines = [];
  const log = (...parts) => {
    const msg = parts.join(' ');
    lines.push(msg);
    console.log(msg);
  };

  log('T25 编排器 — 失败路径原始记录');
  log('========================================');
  log(`timestamp: ${new Date().toISOString()}`);
  log(`node: ${process.version}`);
  log(`llm mock: ${llm.baseUrl}; search mock: ${searchMock.baseUrl} (只在本机 127.0.0.1)`);
  log('');

  log('[a] consult：模型输出含「确诊」→ 校验器拦截并降级 unsafe_output（不回显模型文本）');
  resetMocks();
  searchMock.state.results = [SRC_NHC];
  llm.state.content = JSON.stringify(
    consultOk({ directions: [{ text: '你已确诊流感', citation: SRC_NHC.url }] })
  );
  {
    const res = await ask(
      request({ mode: 'consult', messages: [{ role: 'user', content: '我有点不舒服' }] }),
      { config: makeConfig() }
    );
    log(`returned: ${JSON.stringify(res)}`);
    log(`echoes「确诊」= ${JSON.stringify(res).includes('确诊')}`);
    log(`llm 请求数 = ${llm.state.requests.length}; search 请求数 = ${searchMock.state.requests.length}`);
  }
  log('');

  log('[b] 红标输入（胸痛）→ 固定安全提示句；零 LLM、零搜索调用；输入不回显');
  resetMocks();
  {
    const res = await ask(
      request({ mode: 'consult', messages: [{ role: 'user', content: '我胸痛' }] }),
      { config: makeConfig() }
    );
    log(`returned: ${JSON.stringify(res)}`);
    log(`echoes「胸痛」= ${JSON.stringify(res).includes('胸痛')}`);
    log(
      `llm 请求数 = ${llm.state.requests.length} (期望 0); search 请求数 = ${searchMock.state.requests.length} (期望 0)`
    );
  }
  log('');

  log('[c] LLM 上游持续 500 → 结构化 upstream_error，最多重试 1 次，不抛异常');
  resetMocks();
  llm.state.mode = 'always-500';
  {
    const res = await ask(request({ mode: 'organize' }), { config: makeConfig() });
    log(`returned: ${JSON.stringify(res)}`);
    log(`llm 请求数 = ${llm.state.requests.length} (期望 2 = 首次 + 1 次重试)`);
  }
  log('');

  log('[d] LLM 上游超时（timeoutMs=150）→ 结构化 upstream_error，不抛异常');
  resetMocks();
  llm.state.mode = 'slow';
  {
    const res = await ask(request({ mode: 'organize' }), { config: makeConfig(), timeoutMs: 150 });
    log(`returned: ${JSON.stringify(res)}`);
    log(`llm 请求数 = ${llm.state.requests.length} (期望 2 = 首次 + 1 次重试)`);
  }
  log('');

  log('结论：不安全输出 / 红标 / 上游失败均已归一化为结构化对象，全程未抛未捕获异常；');
  log('      红标零上游调用；校验失败不回显任何模型文本。');

  await llm.close();
  await searchMock.close();
  mkdirSync(resolve(root, 'artifacts/qa'), { recursive: true });
  writeFileSync(resolve(root, 'artifacts/qa/25-failure.txt'), `${lines.join('\n')}\n`);
  console.log(`wrote ${resolve(root, 'artifacts/qa/25-failure.txt')}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Happy mode
// ---------------------------------------------------------------------------

const cases = [];
const record = makeDetailRecord(cases);

// 1) organize happy: structure passes; 0 search calls; no consult fields.
resetMocks();
llm.state.content = JSON.stringify(ORGANIZE_OK);
{
  const res = await ask(request({ mode: 'organize' }), { config: makeConfig() });
  record(
    'organize happy: {points,extracted,unknowns,questions}, no consult fields, search calls === 0',
    !('error' in res) &&
      Array.isArray(res.points) &&
      res.points.length === 2 &&
      typeof res.extracted === 'object' &&
      res.extracted.symptoms.join(',') === '头痛' &&
      Array.isArray(res.unknowns) &&
      Array.isArray(res.questions) &&
      hasNoConsultFields(res) &&
      searchMock.state.requests.length === 0 &&
      llm.state.requests.length === 1,
    { response: res, search_calls: searchMock.state.requests.length, llm_calls: llm.state.requests.length }
  );
}

// 2) consult happy: citations whitelisted + subset; lengths; disclaimer; suggestions present.
resetMocks();
searchMock.state.results = [SRC_NHC, SRC_CDC];
llm.state.content = JSON.stringify(consultOk());
{
  const res = await ask(
    request({ mode: 'consult', messages: [{ role: 'user', content: '最近胃不舒服' }] }),
    { config: makeConfig() }
  );
  const srcUrls = [SRC_NHC.url, SRC_CDC.url];
  const okDirections =
    Array.isArray(res.directions) &&
    res.directions.length === 2 &&
    res.directions.every((d) => typeof d.text === 'string' && d.text.length <= 20 && srcUrls.includes(d.citation.url));
  const okCitations =
    Array.isArray(res.citations) &&
    res.citations.length === 2 &&
    res.citations.every(
      (c) => srcUrls.includes(c.url) && c.domain === new URL(c.url).hostname.toLowerCase()
    );
  const okSuggestions =
    Array.isArray(res.suggestions) &&
    res.suggestions.length === 1 &&
    res.suggestions[0].text.length <= 40 &&
    srcUrls.includes(res.suggestions[0].citation.url);
  record(
    'consult happy: directions<=20 with citations, citations subset+whitelisted, suggestions<=40, disclaimer present',
    !('error' in res) &&
      okDirections &&
      okCitations &&
      okSuggestions &&
      res.disclaimer === CONSULT_DISCLAIMER &&
      res.suggestedDepartments.join(',') === '消化内科,全科' &&
      searchMock.state.requests.length === 1,
    { response: res, search_calls: searchMock.state.requests.length }
  );
}

// 3) consult citation on whitelist domain but NOT in fetched results -> unsafe_output.
resetMocks();
searchMock.state.results = [SRC_NHC];
llm.state.content = JSON.stringify(
  consultOk({ directions: [{ text: '注意休息', citation: 'https://nhc.gov.cn/other/9' }] })
);
{
  const res = await ask(request({ mode: 'consult' }), { config: makeConfig() });
  record(
    'consult: citation not-in-fetched-results -> {error:unsafe_output, fallback:organize}',
    isUnsafe(res),
    { response: res }
  );
}

// 4) consult citation on NON-whitelist domain -> unsafe_output.
resetMocks();
searchMock.state.results = [SRC_NHC];
llm.state.content = JSON.stringify(
  consultOk({ directions: [{ text: '注意休息', citation: 'https://evil.example.com/x' }] })
);
{
  const res = await ask(request({ mode: 'consult' }), { config: makeConfig() });
  record(
    'consult: citation on non-whitelist domain -> {error:unsafe_output, fallback:organize}',
    isUnsafe(res),
    { response: res }
  );
}

// 5) malformed LLM JSON -> unsafe_output.
resetMocks();
llm.state.content = 'this is not json';
{
  const res = await ask(request({ mode: 'organize' }), { config: makeConfig() });
  record('organize: non-JSON model content -> unsafe_output', isUnsafe(res), { response: res });
}

// 6) banned term 确诊 in direction -> unsafe_output, no echo.
resetMocks();
searchMock.state.results = [SRC_NHC];
llm.state.content = JSON.stringify(
  consultOk({ directions: [{ text: '你已确诊流感', citation: SRC_NHC.url }] })
);
{
  const res = await ask(request({ mode: 'consult' }), { config: makeConfig() });
  record(
    'consult: model says「确诊」-> unsafe_output, response echoes none of it',
    isUnsafe(res) && !JSON.stringify(res).includes('确诊'),
    { response: res }
  );
}

// 7) banned term 推荐医生 -> unsafe_output, no echo.
resetMocks();
searchMock.state.results = [SRC_NHC];
llm.state.content = JSON.stringify(
  consultOk({ directions: [{ text: '推荐医生张医生', citation: SRC_NHC.url }] })
);
{
  const res = await ask(request({ mode: 'consult' }), { config: makeConfig() });
  record(
    'consult: model recommends a doctor -> unsafe_output, no echo of 医生',
    isUnsafe(res) && !JSON.stringify(res).includes('医生'),
    { response: res }
  );
}

// 8) 拨打/120 共现规则（P1-8）：无急救线索 → unsafe_output；含急救线索 → 放行。
//    旧行为是全局禁止「拨打/120」，使产品在任何路径都无法给出呼叫 120 的引导，故更改。
resetMocks();
searchMock.state.results = [SRC_NHC];
llm.state.content = JSON.stringify(
  consultOk({ directions: [{ text: '请拨打 120', citation: SRC_NHC.url }] })
);
{
  const res = await ask(request({ mode: 'consult' }), { config: makeConfig() });
  record(
    'consult: model says「拨打 120」without an emergency cue -> unsafe_output, no echo of 拨打/120',
    isUnsafe(res) && !JSON.stringify(res).includes('拨打') && !JSON.stringify(res).includes('120'),
    { response: res }
  );
}

// 8b) 含急救线索（立即/急诊/急救）时「拨打 120」放行 —— 产品可给正确急救引导。
resetMocks();
searchMock.state.results = [SRC_NHC];
llm.state.content = JSON.stringify(
  consultOk({ directions: [{ text: '立即拨打 120 急救', citation: SRC_NHC.url }] })
);
{
  const res = await ask(request({ mode: 'consult' }), { config: makeConfig() });
  record(
    'consult: 「立即拨打 120 急救」with emergency cue -> allowed (valid consult, cue makes it safe)',
    !('error' in res) &&
      Array.isArray(res.directions) &&
      res.directions.length === 1 &&
      res.directions[0].text === '立即拨打 120 急救',
    { response: res }
  );
}

// 8c) P1-8 tightening：弱线索「尽快」不再豁免 —— 「尽快拨打120」无强急救线索 → unsafe_output。
resetMocks();
searchMock.state.results = [SRC_NHC];
llm.state.content = JSON.stringify(
  consultOk({ directions: [{ text: '尽快拨打120', citation: SRC_NHC.url }] })
);
{
  const res = await ask(request({ mode: 'consult' }), { config: makeConfig() });
  record(
    'consult: 「尽快拨打120」-> unsafe_output (weak cue 尽快 dropped from the exemption)',
    isUnsafe(res) && !JSON.stringify(res).includes('拨打'),
    { response: res }
  );
}

// 8d) P1-8 tightening：分句内共现 —— 「不要拨打120，立即就医」的线索在另一分句，不能豁免否定呼叫。
resetMocks();
searchMock.state.results = [SRC_NHC];
llm.state.content = JSON.stringify(
  consultOk({ directions: [{ text: '不要拨打120，立即就医', citation: SRC_NHC.url }] })
);
{
  const res = await ask(request({ mode: 'consult' }), { config: makeConfig() });
  record(
    'consult: 「不要拨打120，立即就医」-> unsafe_output (cue in another clause must not excuse a negated call)',
    isUnsafe(res) && !JSON.stringify(res).includes('拨打'),
    { response: res }
  );
}

// 8e) P1-8 tightening：同句否定守卫 —— 分句内虽有强线索，但呼叫被「不要」紧邻否定，仍拦截。
resetMocks();
searchMock.state.results = [SRC_NHC];
llm.state.content = JSON.stringify(
  consultOk({ directions: [{ text: '不要立即拨打120', citation: SRC_NHC.url }] })
);
{
  const res = await ask(request({ mode: 'consult' }), { config: makeConfig() });
  record(
    'consult: 「不要立即拨打120」-> unsafe_output (negation guard overrides a same-clause cue)',
    isUnsafe(res) && !JSON.stringify(res).includes('拨打'),
    { response: res }
  );
}

// 9) direction > 20 chars -> unsafe_output.
resetMocks();
searchMock.state.results = [SRC_NHC];
llm.state.content = JSON.stringify(
    consultOk({ directions: [{ text: '这是一条明显超过二十个字符的健康方向示例文本', citation: SRC_NHC.url }] })
);
{
  const res = await ask(request({ mode: 'consult' }), { config: makeConfig() });
  record('consult: direction.text > 20 chars -> unsafe_output', isUnsafe(res), { response: res });
}

// 10) suggestion with 剂量 word -> unsafe_output.
resetMocks();
searchMock.state.results = [SRC_NHC];
llm.state.content = JSON.stringify(
  consultOk({ suggestions: [{ text: '按说明书剂量使用', citation: SRC_NHC.url }] })
);
{
  const res = await ask(request({ mode: 'consult' }), { config: makeConfig() });
  record('consult: suggestion with「剂量」-> unsafe_output', isUnsafe(res), { response: res });
}

// 11) suggestion with personalised medication instruction (服用) -> unsafe_output.
resetMocks();
searchMock.state.results = [SRC_NHC];
llm.state.content = JSON.stringify(
  consultOk({ suggestions: [{ text: '每天服用两片药物', citation: SRC_NHC.url }] })
);
{
  const res = await ask(request({ mode: 'consult' }), { config: makeConfig() });
  record('consult: suggestion with「服用」-> unsafe_output', isUnsafe(res), { response: res });
}

// 12) schema whitelist: extra model fields (narrative/foo) are dropped.
resetMocks();
llm.state.content = JSON.stringify({
  ...ORGANIZE_OK,
  narrative: '这是一段自由文本病情叙述，绝不应回传',
  foo: 'bar',
});
{
  const res = await ask(request({ mode: 'organize' }), { config: makeConfig() });
  const json = JSON.stringify(res);
  record(
    'schema whitelist: extra model fields (narrative/foo) dropped, narrative text never returned',
    !('error' in res) &&
      !('narrative' in res) &&
      !('foo' in res) &&
      !json.includes('自由文本病情叙述') &&
      !json.includes('bar'),
    { response: res }
  );
}

// 13) redflag (consult) -> fixed sentence; zero LLM; zero search; no echo; no dept/direction/citation.
resetMocks();
{
  const res = await ask(
    request({ mode: 'consult', messages: [{ role: 'user', content: '我胸痛' }] }),
    { config: makeConfig() }
  );
  const json = JSON.stringify(res);
  const deptHit = CONTROLLED_DEPARTMENTS.filter((d) => json.includes(d));
  record(
    'redflag consult: fixed notice, zero LLM + zero search, no department/direction/citation, input not echoed',
    res.redFlag === true &&
      res.safetyNotice === SAFETY_NOTICE &&
      !json.includes('胸痛') &&
      deptHit.length === 0 &&
      !('directions' in res) &&
      !('citations' in res) &&
      llm.state.requests.length === 0 &&
      searchMock.state.requests.length === 0,
    {
      response: res,
      llm_calls: llm.state.requests.length,
      search_calls: searchMock.state.requests.length,
      department_hits: deptHit,
    }
  );
}

// 14) redflag (organize) -> same fixed shape; zero upstream.
resetMocks();
{
  const res = await ask(
    request({ mode: 'organize', messages: [{ role: 'user', content: '突然晕厥' }] }),
    { config: makeConfig() }
  );
  record(
    'redflag organize: fixed notice, zero LLM + zero search, same mode-independent shape',
    res.redFlag === true &&
      res.safetyNotice === SAFETY_NOTICE &&
      res.disclaimer === CONSULT_DISCLAIMER &&
      llm.state.requests.length === 0 &&
      searchMock.state.requests.length === 0,
    { response: res, llm_calls: llm.state.requests.length, search_calls: searchMock.state.requests.length }
  );
}

// 15) all 8 plan redflag terms: PER-SAMPLE full contract.
//     Each of 胸痛/胸闷伴大汗/呼吸困难/意识障碍/大出血/中风征象/晕厥/剧烈头痛 must independently
//     yield the fixed safety sentence, the fixed disclaimer, NO controlled department, NO directions/citations,
//     and ZERO upstream calls (not just the aggregate "any term fired").
resetMocks();
{
  const samples = RED_FLAG_TERMS.slice(0, 8);
  const perSample = [];
  for (const term of samples) {
    resetMocks();
    // eslint-disable-next-line no-await-in-loop
    const res = await ask(
      request({ mode: 'consult', messages: [{ role: 'user', content: `我${term}` }] }),
      { config: makeConfig() }
    );
    const json = JSON.stringify(res);
    const deptHit = CONTROLLED_DEPARTMENTS.filter((d) => json.includes(d));
    perSample.push({
      term,
      redFlag: res.redFlag === true,
      fixed_notice: res.safetyNotice === SAFETY_NOTICE,
      fixed_disclaimer: res.disclaimer === CONSULT_DISCLAIMER,
      no_department: deptHit.length === 0,
      no_direction: !('directions' in res) && !('citations' in res),
      input_not_echoed: !json.includes(term),
      zero_upstream: llm.state.requests.length === 0 && searchMock.state.requests.length === 0,
    });
  }
  const sampleOk = (s) =>
    s.redFlag === true &&
    s.fixed_notice === true &&
    s.fixed_disclaimer === true &&
    s.no_department === true &&
    s.no_direction === true &&
    s.input_not_echoed === true &&
    s.zero_upstream === true;
  record(
    'redflag: all 8 plan terms fire with fixed notice, no department/direction, zero upstream (per-sample)',
    perSample.every(sampleOk),
    { samples, per_sample: perSample }
  );
}

// 15b) redflag 否定处理（P1-7）：否定式提及不短路（旧实现「没有胸痛」会命中并整单短路）。
resetMocks();
llm.state.content = JSON.stringify(ORGANIZE_OK);
{
  const negatives = [
    '我没有胸痛，只是有点累',
    '无呼吸困难',
    '不伴抽搐',
    '未见大出血',
    '否认晕厥',
  ];
  const perSample = [];
  for (const content of negatives) {
    resetMocks();
    llm.state.content = JSON.stringify(ORGANIZE_OK);
    // eslint-disable-next-line no-await-in-loop
    const res = await ask(
      request({ mode: 'organize', messages: [{ role: 'user', content }] }),
      { config: makeConfig() }
    );
    perSample.push({
      content,
      redFlag: res.redFlag === true,
      llm_calls: llm.state.requests.length,
    });
  }
  record(
    'redflag negation: negated mentions (没有/无/不伴/未见/否认) do NOT short-circuit; LLM is consulted',
    perSample.every((s) => s.redFlag === false && s.llm_calls === 1),
    { per_sample: perSample }
  );
}

// 15c) redflag 扩充类目（P1-7）：口语化危重信号可命中（每例零 LLM/零搜索短路）。
resetMocks();
{
  const samples = ['我突然喘不上气', '他昏迷了叫不醒', '心跳骤停', '出血不止', '一侧无力', '剧烈腹痛'];
  const perSample = [];
  for (const content of samples) {
    resetMocks();
    // eslint-disable-next-line no-await-in-loop
    const res = await ask(
      request({ mode: 'consult', messages: [{ role: 'user', content }] }),
      { config: makeConfig() }
    );
    perSample.push({
      content,
      redFlag: res.redFlag === true,
      fixed_notice: res.safetyNotice === SAFETY_NOTICE,
      zero_upstream: llm.state.requests.length === 0 && searchMock.state.requests.length === 0,
    });
  }
  record(
    'redflag expanded categories: colloquial critical signals (喘不上气/昏迷/心跳骤停/出血不止/一侧无力/剧烈腹痛) fire',
    perSample.every((s) => s.redFlag && s.fixed_notice && s.zero_upstream),
    { per_sample: perSample }
  );
}

// 15d) 词表导出与固定句（P1-7/P1-8）：两个数组非空；SAFETY_NOTICE 通过受限词门（含 120 但带急救线索）。
{
  const arraysOk =
    Array.isArray(REDFLAG_PATTERN_SOURCES) &&
    REDFLAG_PATTERN_SOURCES.length >= 20 &&
    Array.isArray(NEGATION_PATTERN_SOURCES) &&
    NEGATION_PATTERN_SOURCES.length >= 4;
  const noticePassesGate = firstBannedDecisionTerm(SAFETY_NOTICE) === null;
  record(
    'redflag exports: REDFLAG_PATTERN_SOURCES/NEGATION_PATTERN_SOURCES present; SAFETY_NOTICE passes decision-term gate (拨打/120 + cue)',
    arraysOk && noticePassesGate,
    {
      pattern_count: REDFLAG_PATTERN_SOURCES?.length,
      negation_count: NEGATION_PATTERN_SOURCES?.length,
      notice_gate: firstBannedDecisionTerm(SAFETY_NOTICE),
    }
  );
}

// 16) context: 25 messages -> <=20 turns in outgoing payload.
resetMocks();
llm.state.content = JSON.stringify(ORGANIZE_OK);
{
  const messages = [];
  for (let i = 0; i < 25; i += 1) {
    messages.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `第${i}条短消息` });
  }
  await ask(request({ mode: 'organize', messages }), { config: makeConfig() });
  const conv = conversationMessages(lastLlmBody());
  record(
    'context: 25 incoming messages -> outgoing conversation turns <= 20',
    conv.length === LIMITS.maxTurns && systemContent(lastLlmBody()).length > 0,
    { outgoing_turns: conv.length, incoming: messages.length }
  );
}

// 17) context: huge content -> conversation window <= 8K chars.
resetMocks();
llm.state.content = JSON.stringify(ORGANIZE_OK);
{
  const messages = [];
  for (let i = 0; i < 30; i += 1) {
    messages.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `M${i}:` + 'x'.repeat(1000) });
  }
  await ask(request({ mode: 'organize', messages }), { config: makeConfig() });
  const conv = conversationMessages(lastLlmBody());
  const chars = conv.reduce((sum, m) => sum + m.content.length, 0);
  record(
    'context: huge content -> outgoing conversation total <= 8K chars (dropped oldest first)',
    chars <= LIMITS.maxContextChars && conv.length <= LIMITS.maxTurns,
    { outgoing_turns: conv.length, outgoing_chars: chars, cap: LIMITS.maxContextChars }
  );
}

// 18) memories: >20 items -> truncated to <=20 in system prompt.
resetMocks();
llm.state.content = JSON.stringify(ORGANIZE_OK);
{
  const memories = [];
  for (let i = 0; i < 30; i += 1) memories.push(`M${i}:` + 'x'.repeat(20));
  await ask(request({ mode: 'organize', memories }), { config: makeConfig() });
  const lines = itemLines(systemContent(lastLlmBody()), 'M');
  record(
    'memories: >20 items -> <=20 injected in system prompt',
    lines.length <= LIMITS.maxMemoryItems && lines.length > 0,
    { injected_items: lines.length, cap: LIMITS.maxMemoryItems }
  );
}

// 19) memories: >1K chars -> truncated to <=1K in system prompt.
resetMocks();
llm.state.content = JSON.stringify(ORGANIZE_OK);
{
  const memories = [];
  for (let i = 0; i < 5; i += 1) memories.push(`M${i}:` + 'y'.repeat(500));
  await ask(request({ mode: 'organize', memories }), { config: makeConfig() });
  const chars = itemsLength(itemLines(systemContent(lastLlmBody()), 'M'));
  record(
    'memories: >1K chars -> injected memory chars <= 1K',
    chars <= LIMITS.maxMemoryChars && chars > 0,
    { injected_chars: chars, cap: LIMITS.maxMemoryChars }
  );
}

// 20) recordExcerpts: >2K chars -> truncated to <=2K in system prompt.
resetMocks();
llm.state.content = JSON.stringify(ORGANIZE_OK);
{
  const recordExcerpts = [];
  for (let i = 0; i < 5; i += 1) recordExcerpts.push(`R${i}:` + 'z'.repeat(600));
  await ask(request({ mode: 'organize', recordExcerpts }), { config: makeConfig() });
  const chars = itemsLength(itemLines(systemContent(lastLlmBody()), 'R'));
  record(
    'recordExcerpts: >2K chars -> injected excerpt chars <= 2K',
    chars <= LIMITS.maxRecordExcerptsChars && chars > 0,
    { injected_chars: chars, cap: LIMITS.maxRecordExcerptsChars }
  );
}

// 21) search query derivation is capped to <=200 chars; consult uses exactly 1 search call.
resetMocks();
searchMock.state.results = [SRC_NHC];
llm.state.content = JSON.stringify(consultOk({ directions: [], suggestions: [] }));
{
  const longText = '胃部不适，'.repeat(60); // > 200 chars
  await ask(request({ mode: 'consult', messages: [{ role: 'user', content: longText }] }), {
    config: makeConfig(),
  });
  const searchReq = searchMock.state.requests[0];
  const q = searchReq === undefined ? '' : searchReq.body.q;
  record(
    'search: query derived from latest user message, capped <=200 chars; consult makes exactly 1 search call',
    searchMock.state.requests.length === 1 && typeof q === 'string' && q.length === LIMITS.maxSearchQueryChars,
    { search_calls: searchMock.state.requests.length, query_length: q.length, cap: LIMITS.maxSearchQueryChars }
  );
}

// 22) search unavailable (500) in consult -> no crash, zero fabricated citations, still answers.
resetMocks();
searchMock.state.mode = 'always-500';
llm.state.content = JSON.stringify({ directions: [], suggestedDepartments: [], suggestions: [], unknowns: ['缺少来源'], questions: [] });
{
  let threw = false;
  let res = null;
  try {
    res = await ask(request({ mode: 'consult' }), { config: makeConfig() });
  } catch {
    threw = true;
  }
  record(
    'search unavailable in consult: no throw, no fabricated citations, still returns a valid consult shape',
    threw === false &&
      res !== null &&
      !('error' in res) &&
      Array.isArray(res.citations) &&
      res.citations.length === 0 &&
      Array.isArray(res.directions) &&
      res.directions.length === 0 &&
      res.disclaimer === CONSULT_DISCLAIMER,
    { threw, response: res, search_calls: searchMock.state.requests.length }
  );
}

// 23) LLM persistent 500 -> structured upstream_error, does NOT throw.
resetMocks();
llm.state.mode = 'always-500';
{
  let threw = false;
  let res = null;
  try {
    res = await ask(request({ mode: 'organize' }), { config: makeConfig() });
  } catch {
    threw = true;
  }
  record(
    'LLM persistent 500: structured {error:upstream_error}, does NOT throw, 1 retry (request_count===2)',
    threw === false && res !== null && res.error === 'upstream_error' && llm.state.requests.length === 2,
    { threw, response: res, llm_calls: llm.state.requests.length }
  );
}

// 24) consent !== true -> structured error, ZERO upstream calls.
resetMocks();
{
  const res = await ask(request({ mode: 'organize', consent: false }), { config: makeConfig() });
  record(
    'consent !== true -> {error:consent_required}, ZERO upstream calls',
    res.error === 'consent_required' && llm.state.requests.length === 0 && searchMock.state.requests.length === 0,
    { response: res, llm_calls: llm.state.requests.length, search_calls: searchMock.state.requests.length }
  );
}

// 25) invalid mode -> structured error, ZERO upstream calls.
resetMocks();
{
  const res = await ask(request({ mode: 'diagnose' }), { config: makeConfig() });
  record(
    'invalid mode -> {error:invalid_mode}, ZERO upstream calls',
    res.error === 'invalid_mode' && llm.state.requests.length === 0 && searchMock.state.requests.length === 0,
    { response: res, llm_calls: llm.state.requests.length, search_calls: searchMock.state.requests.length }
  );
}

// 26) malformed message shape -> invalid_request, ZERO upstream calls.
resetMocks();
{
  const res = await ask(request({ mode: 'organize', messages: [{ role: 'user' }] }), {
    config: makeConfig(),
  });
  record(
    'malformed messages -> {error:invalid_request}, ZERO upstream calls',
    res.error === 'invalid_request' && llm.state.requests.length === 0 && searchMock.state.requests.length === 0,
    { response: res, llm_calls: llm.state.requests.length }
  );
}

// 27) LLM not configured (empty baseUrl) -> provider_not_configured, ZERO network.
resetMocks();
{
  const res = await ask(request({ mode: 'organize' }), { config: makeConfig({ llm: { baseUrl: '' } }) });
  record(
    'LLM not configured -> {error:provider_not_configured}, ZERO network calls',
    res.error === 'provider_not_configured' && llm.state.requests.length === 0 && searchMock.state.requests.length === 0,
    { response: res, llm_calls: llm.state.requests.length, search_calls: searchMock.state.requests.length }
  );
}

// 28) max_tokens default + override (asserted via recorded request body).
resetMocks();
llm.state.content = JSON.stringify(ORGANIZE_OK);
{
  await ask(request({ mode: 'organize' }), { config: makeConfig() });
  const defaultTokens = lastLlmBody()?.max_tokens;
  resetMocks();
  llm.state.content = JSON.stringify(ORGANIZE_OK);
  await ask(request({ mode: 'organize' }), { config: makeConfig(), maxTokens: 555 });
  const overrideTokens = lastLlmBody()?.max_tokens;
  record(
    'max_tokens: defaults to LIMITS.defaultMaxTokens and is configurable via options',
    defaultTokens === LIMITS.defaultMaxTokens && overrideTokens === 555,
    { default_max_tokens: defaultTokens, override_max_tokens: overrideTokens }
  );
}

// 29) memories are preferences, NOT medical facts: a redflag term inside memories does not short-circuit.
resetMocks();
llm.state.content = JSON.stringify(ORGANIZE_OK);
{
  const res = await ask(
    request({ mode: 'organize', memories: ['我胸痛时习惯顺手记一笔'] }),
    { config: makeConfig() }
  );
  record(
    'memories are not medical facts: redflag term inside memories does NOT trigger short-circuit',
    !('redFlag' in res) && !('error' in res) && llm.state.requests.length === 1,
    { response: res, llm_calls: llm.state.requests.length }
  );
}

// 30) privacy: the 4 new server modules contain no disk-write or console statements.
{
  const files = ['server/orchestrator.ts', 'server/prompts.ts', 'server/validate.ts', 'server/redflags.ts'];
  const banned = ['writeFile', 'appendFile', 'createWriteStream', 'node:fs', 'console.log', 'console.error', 'console.warn'];
  const hits = [];
  for (const file of files) {
    const src = readFileSync(resolve(root, file), 'utf8');
    for (const token of banned) {
      if (src.includes(token)) hits.push(`${file}:${token}`);
    }
  }
  record(
    'privacy: 4 new server modules have no disk-write or console statements',
    hits.length === 0,
    { files, banned_hits: hits }
  );
}

// 31) guardrail scope (T25 revision): neutral "missing info" phrases in unknowns/questions
//     (e.g. 「布洛芬剂量和频次未说明」) are legitimate and must NOT degrade organize.
//     Rationale: unknowns/questions are structurally「缺失项 / 待问医生的问题」.
resetMocks();
llm.state.content = JSON.stringify({
  ...ORGANIZE_OK,
  unknowns: ['布洛芬剂量和频次未说明', '是否诊断过未说明'],
  questions: ['既往是否诊断过类似情况？'],
});
{
  const res = await ask(request({ mode: 'organize' }), { config: makeConfig() });
  record(
    'guardrail scope: neutral missing-info terms (剂量/诊断) in organize unknowns/questions do NOT degrade',
    !('error' in res) && Array.isArray(res.points) && res.unknowns.length === 2,
    { response: res }
  );
}

// 32) guardrail scope: same exemption applies to consult unknowns/questions, while
//     advisory fields (direction/suggestion) keep the strict rule (cases 6-11 unaffected).
resetMocks();
searchMock.state.results = [SRC_NHC, SRC_CDC];
llm.state.content = JSON.stringify(
  consultOk({ unknowns: ['用药剂量未说明'], questions: ['是否诊断过？'] })
);
{
  const res = await ask(request({ mode: 'consult' }), { config: makeConfig() });
  record(
    'guardrail scope: neutral missing-info terms in consult unknowns/questions do NOT degrade',
    !('error' in res) && Array.isArray(res.directions) && res.directions.length === 2,
    { response: res }
  );
}

// 33) guardrail scope (T25 second revision): a neutral restatement of the user's own information gap
//     inside organize.points (e.g. 「使用布洛芬，剂量不确定」) is NOT an assertion -> must NOT degrade.
resetMocks();
llm.state.content = JSON.stringify({
  ...ORGANIZE_OK,
  points: ['头痛持续三天', '使用布洛芬，剂量不确定', '在考虑是否去医院'],
});
{
  const res = await ask(request({ mode: 'organize' }), { config: makeConfig() });
  record(
    'guardrail scope: neutral restatement in organize.points (剂量不确定) does NOT degrade',
    !('error' in res) && Array.isArray(res.points) && res.points.length === 3,
    { response: res }
  );
}

// 34) guardrail scope: an ASSERTIVE banned term in organize.points (no neutral marker nearby)
//     must still degrade. Ensures the exemption does not blunt the guardrail.
resetMocks();
llm.state.content = JSON.stringify({
  ...ORGANIZE_OK,
  points: ['建议布洛芬剂量为每次200毫克'],
});
{
  const res = await ask(request({ mode: 'organize' }), { config: makeConfig() });
  record(
    'guardrail scope: assertive banned term in organize.points (剂量为…) still degrades',
    isUnsafe(res),
    { response: res }
  );
}

// 35) adversarial: a neutral marker FAR from the banned term (outside the ±8 window) must NOT
//     rescue an assertion. Guards the window heuristic against "sprinkle a soft word elsewhere".
resetMocks();
llm.state.content = JSON.stringify({
  ...ORGANIZE_OK,
  points: ['剂量为每次200毫克，如不清楚请咨询医生'],
});
{
  const res = await ask(request({ mode: 'organize' }), { config: makeConfig() });
  record(
    'guardrail adversarial: distant neutral marker does NOT rescue an assertive term in points',
    isUnsafe(res),
    { response: res }
  );
}

// 36) adversarial: one neutral point + one assertive point -> whole output still degrades.
resetMocks();
llm.state.content = JSON.stringify({
  ...ORGANIZE_OK,
  points: ['剂量不确定', '建议剂量为每次200毫克'],
});
{
  const res = await ask(request({ mode: 'organize' }), { config: makeConfig() });
  record(
    'guardrail adversarial: mixed neutral+assertive points still degrades',
    isUnsafe(res),
    { response: res }
  );
}

// 37) P1-16: extracted subfield type mismatch is visible (unsafe_output), never silently dropped.
resetMocks();
llm.state.content = JSON.stringify({
  ...ORGANIZE_OK,
  extracted: {
    symptoms: ['头痛'],
    medications: [{ name: '布洛芬' }],
    allergies: '青霉素',
    history: [],
    exams: [],
  },
});
{
  const res = await ask(request({ mode: 'organize' }), { config: makeConfig() });
  record(
    'p1-16 extracted subfield type mismatch -> unsafe_output (allergies/medications not silently dropped)',
    isUnsafe(res),
    { response: res }
  );
}

// 38) P1-10: prohibited-claim gate now covers extracted.* and questions (clause-based neutral rule).
resetMocks();
llm.state.content = JSON.stringify({
  ...ORGANIZE_OK,
  extracted: { symptoms: ['确诊为流感'], medications: [], allergies: [], history: [], exams: [] },
});
{
  const res = await ask(request({ mode: 'organize' }), { config: makeConfig() });
  record('p1-10 rendered gate: extracted.symptoms「确诊为流感」-> unsafe_output', isUnsafe(res), {
    response: res,
  });
}
resetMocks();
llm.state.content = JSON.stringify({ ...ORGANIZE_OK, questions: ['尚待确认，确诊为流感'] });
{
  const res = await ask(request({ mode: 'organize' }), { config: makeConfig() });
  record(
    'p1-10 clause rule: 「尚待确认，确诊为…」in questions still degrades (old ±8 window bypass fixed)',
    isUnsafe(res),
    { response: res }
  );
}
resetMocks();
llm.state.content = JSON.stringify({ ...ORGANIZE_OK, questions: ['是否确诊过类似情况？'] });
{
  const res = await ask(request({ mode: 'organize' }), { config: makeConfig() });
  record(
    'p1-10 legitimate gap restatement「是否确诊过…」in questions does NOT degrade',
    !('error' in res) && Array.isArray(res.questions),
    { response: res }
  );
}

// 39) P1-14: search degraded surfaces a machine-readable reason and empties unsourced departments.
resetMocks();
searchMock.state.mode = 'always-500';
llm.state.content = JSON.stringify({
  directions: [],
  suggestedDepartments: ['全科'],
  suggestions: [],
  unknowns: [],
  questions: [],
});
{
  const res = await ask(request({ mode: 'consult' }), { config: makeConfig() });
  record(
    'p1-14 search unavailable -> degraded=search_unavailable + suggestedDepartments=[] (no normal-result shape)',
    !('error' in res) &&
      res.degraded === 'search_unavailable' &&
      Array.isArray(res.suggestedDepartments) &&
      res.suggestedDepartments.length === 0,
    { response: res }
  );
}

// 40) P1-15: citation URL normalization (scheme-less / uppercase / trailing slash) still resolves.
resetMocks();
searchMock.state.results = [SRC_NHC];
llm.state.content = JSON.stringify(
  consultOk({ directions: [{ text: '注意休息', citation: 'NHC.GOV.CN/tips/1' }] })
);
{
  const res = await ask(request({ mode: 'consult' }), { config: makeConfig() });
  record(
    'p1-15 normalized citation (scheme-less/uppercase) resolves instead of unsafe_output',
    !('error' in res) && Array.isArray(res.directions) && res.directions.length === 1,
    { response: res }
  );
}

// 41) P0-4: a hanging mock upstream yields 504 {ok:false, error:'deadline_exceeded'} within the budget.
{
  const port = await getFreePort();
  const spawnServer = makeSpawnServer(root);
  const hang = await listen(
    createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        // 永不响应：模拟挂死的上游。
      });
    }),
    'hang-mock',
    {}
  );
  const cfgPath = join(tmpdir(), `mhp-ask-deadline-${process.pid}-${Date.now()}.json`);
  writeFileSync(
    cfgPath,
    JSON.stringify({
      port,
      demo: false,
      llm: { baseUrl: hang.baseUrl, apiKey: 'sk-hang', model: 'hang-model' },
      search: { baseUrl: '', apiKey: '' },
      authorityDomains: [],
    })
  );
  process.env.MHP_TOTAL_DEADLINE_MS = '700';
  const started = spawnServer(cfgPath);
  try {
    const health = await waitForHealth(port);
    const t0 = Date.now();
    const res = await fetch(`http://127.0.0.1:${port}/api/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'organize',
        messages: [{ role: 'user', content: '你好' }],
        consent: true,
      }),
    });
    const body = await res.json();
    const elapsed = Date.now() - t0;
    record(
      'p0-4 hanging upstream -> HTTP 504 {ok:false,error:deadline_exceeded} within the total budget',
      health.status === 200 &&
        res.status === 504 &&
        body.ok === false &&
        body.error === 'deadline_exceeded' &&
        elapsed < 10000,
      { status: res.status, body, elapsed_ms: elapsed }
    );
  } finally {
    await stopServer(started.child);
    await hang.close();
    delete process.env.MHP_TOTAL_DEADLINE_MS;
    rmSync(cfgPath, { force: true });
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const summary = {
  total: cases.length,
  passed: cases.filter((c) => c.pass).length,
  failed: cases.filter((c) => !c.pass).length,
};

const artifact = {
  command: 'npx tsx scripts/check-ask.mjs',
  timestamp: new Date().toISOString(),
  modules: [
    'server/orchestrator.ts',
    'server/prompts.ts',
    'server/validate.ts',
    'server/redflags.ts',
  ],
  mocks: [
    { name: llm.name, base_url: llm.baseUrl },
    { name: searchMock.name, base_url: searchMock.baseUrl },
  ],
  cases,
  summary,
};

const outDir = resolve(root, 'artifacts/checks');
mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, 'server-ask.json'), `${JSON.stringify(artifact, null, 2)}\n`);

await llm.close();
await searchMock.close();

for (const c of cases) {
  console.log(`${c.pass ? 'PASS' : 'FAIL'} - ${c.name}`);
}
console.log(`cases ${summary.passed}/${summary.total} passed, failed=${summary.failed}`);
console.log(`wrote ${resolve(outDir, 'server-ask.json')}`);

process.exit(summary.failed === 0 ? 0 : 1);
