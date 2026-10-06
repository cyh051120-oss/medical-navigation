#!/usr/bin/env node
// scripts/check-extract.mjs
// Zero-dependency harness (tsx-run) for server/extract-memory.ts + prompts/validate (task 43).
//
// Spins up ONE local OpenAI-compatible LLM mock bound to 127.0.0.1 on an ephemeral port, then
// dynamically imports the extract service and asserts the memory-extraction contract: guards
// (consent/messages/maxItems), the 2K / 3-item / 60-char caps, per-item medical-term rejection
// (violating items dropped while valid ones survive), dedupe, the never-throw guarantee, and privacy.
//
// No external network I/O is performed; everything stays on 127.0.0.1.
//
// Modes:
//   (default)            happy run -> artifacts/checks/server-extract.json, exit 0 on all-pass
//   --simulate-failure   raw failure transcript (real medical/invalid-JSON/500 runs) ->
//                        artifacts/qa/43-failure.txt, exit 1 (failure-mode contract)

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  conversationMessages,
  getFreePort,
  makeDetailRecord,
  makeLastLlmBody,
  makeSpawnServer,
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

const { extractMemory } = await import(
  pathToFileURL(resolve(root, 'server/extract-memory.ts')).href
);
const { LIMITS, EXTRACT_SYSTEM_PROMPT } = await import(
  pathToFileURL(resolve(root, 'server/prompts.ts')).href
);

// ---------------------------------------------------------------------------
// Mocks (127.0.0.1:0)
// ---------------------------------------------------------------------------

const llm = await startLlmMock('llm-mock');

function makeConfig(overrides = {}) {
  return {
    port: 0,
    demo: false,
    llm: { baseUrl: llm.baseUrl, apiKey: 'sk-llm', model: 'mock-model', ...(overrides.llm ?? {}) },
    search: { baseUrl: '', apiKey: '' },
    authorityDomains: [],
  };
}

function resetMock() {
  llm.state.mode = 'ok';
  llm.state.content = '{}';
  llm.state.requests.length = 0;
}

function request(overrides = {}) {
  return {
    messages: [{ role: 'user', content: '我一般晚上十点前就睡了，喜欢清淡饮食，平时爱散步' }],
    consent: true,
    ...overrides,
  };
}

const lastLlmBody = makeLastLlmBody(llm);

function conversationChars(body) {
  return conversationMessages(body).reduce((sum, m) => sum + m.content.length, 0);
}

function candidateTexts(res) {
  return Array.isArray(res?.candidates) ? res.candidates.map((c) => c.text) : null;
}

const MEDICAL_TERMS = ['确诊', '诊断', '处方', '剂量', '症状', '用药', '疾病', '医院', '医生'];

// ---------------------------------------------------------------------------
// Route-level HTTP helpers (spawn the real server; screen-free; 127.0.0.1 only)
// ---------------------------------------------------------------------------

const spawnServer = makeSpawnServer(root);

/** System curl (byte-faithful transport). Returns { status, body } — status from the last line. */
function curlRaw(url, options = {}) {
  const method = options.method ?? 'POST';
  const args = ['-s', '-w', '\n%{http_code}', '-X', method, url];
  if (options.dataFile !== undefined) {
    args.push('-H', 'Content-Type: application/json', '--data-binary', `@${options.dataFile}`);
  } else if (options.data !== undefined) {
    args.push('-H', 'Content-Type: application/json', '--data-binary', options.data);
  }
  const res = spawnSync('curl', args, { encoding: 'utf8' });
  const out = res.stdout ?? '';
  const idx = out.lastIndexOf('\n');
  return {
    status: idx >= 0 ? out.slice(idx + 1).trim() : '',
    body: idx >= 0 ? out.slice(0, idx) : out,
  };
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

  log('T43 记忆提炼 — 失败路径原始记录');
  log('========================================');
  log(`timestamp: ${new Date().toISOString()}`);
  log(`node: ${process.version}`);
  log(`llm mock: ${llm.baseUrl} (只在本机 127.0.0.1)`);
  log('');

  log('[a] 模型候选中混入医疗断言/超长 → 违规条目丢弃，合法条目保留；无未捕获异常');
  resetMock();
  llm.state.content = JSON.stringify({
    candidates: [
      { text: '已确诊流感' },
      { text: '长期用药' },
      { text: '去某医院复查' },
      { text: 'a'.repeat(61) },
      { text: '偏好晚上十点前入睡' },
    ],
  });
  {
    const res = await extractMemory(request(), { config: makeConfig() });
    log(`returned: ${JSON.stringify(res)}`);
    log(`texts: ${JSON.stringify(candidateTexts(res))}`);
    log(`含医疗项的条目数为 0: ${(candidateTexts(res) ?? []).every((t) => !MEDICAL_TERMS.some((w) => t.includes(w)))}`);
  }
  log('');

  log('[b] 模型返回非法 JSON → 降级为空候选，无未捕获异常');
  resetMock();
  llm.state.content = 'this is not json';
  {
    const res = await extractMemory(request(), { config: makeConfig() });
    log(`returned: ${JSON.stringify(res)}`);
  }
  log('');

  log('[c] LLM 上游持续 500 → 降级为空候选，无未捕获异常（默认重试 1 次）');
  resetMock();
  llm.state.mode = 'always-500';
  {
    const res = await extractMemory(request(), { config: makeConfig() });
    log(`returned: ${JSON.stringify(res)}`);
    log(`llm 请求数 = ${llm.state.requests.length} (期望 2 = 首次 + 1 次重试)`);
  }
  log('');

  log('[d] 上游超时（timeoutMs=150）→ 降级为空候选，无未捕获异常');
  resetMock();
  llm.state.mode = 'slow';
  {
    const res = await extractMemory(request(), { config: makeConfig(), timeoutMs: 150 });
    log(`returned: ${JSON.stringify(res)}`);
    log(`llm 请求数 = ${llm.state.requests.length} (期望 2 = 首次 + 1 次重试)`);
  }
  log('');

  log('结论：医疗断言 / 超长 / 非法 JSON / 上游失败均已丢弃违规条目或降级为空候选，');
  log('      全程未抛未捕获异常，且不阻塞主回答流程。');

  await llm.close();
  mkdirSync(resolve(root, 'artifacts/qa'), { recursive: true });
  writeFileSync(resolve(root, 'artifacts/qa/43-failure.txt'), `${lines.join('\n')}\n`);
  console.log(`wrote ${resolve(root, 'artifacts/qa/43-failure.txt')}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Happy mode
// ---------------------------------------------------------------------------

const cases = [];
const record = makeDetailRecord(cases);

// 1) happy: structured candidates; success carries no reason; exactly one upstream call.
resetMock();
llm.state.content = JSON.stringify({
  candidates: [{ text: '偏好晚上十点前入睡' }, { text: '饮食清淡、少油少盐' }],
});
{
  const res = await extractMemory(request(), { config: makeConfig() });
  record(
    'happy: structured {candidates:[{text}]}, no reason, exactly 1 LLM call',
    Array.isArray(res.candidates) &&
      res.candidates.length === 2 &&
      res.candidates[0].text === '偏好晚上十点前入睡' &&
      res.candidates[1].text === '饮食清淡、少油少盐' &&
      !('reason' in res) &&
      llm.state.requests.length === 1,
    { response: res, llm_calls: llm.state.requests.length }
  );
}

// 2) count cap: >3 valid candidates -> <=3 (default maxItems).
resetMock();
llm.state.content = JSON.stringify({
  candidates: [1, 2, 3, 4, 5].map((n) => ({ text: `偏好示例${n}` })),
});
{
  const res = await extractMemory(request(), { config: makeConfig() });
  record(
    'count cap: 5 valid candidates -> <= LIMITS.maxExtractItems (default 3)',
    Array.isArray(res.candidates) &&
      res.candidates.length === LIMITS.maxExtractItems &&
      res.candidates.length <= 3,
    { count: res.candidates?.length, cap: LIMITS.maxExtractItems }
  );
}

// 3) maxItems=1 -> <=1.
resetMock();
llm.state.content = JSON.stringify({
  candidates: [1, 2, 3].map((n) => ({ text: `偏好示例${n}` })),
});
{
  const res = await extractMemory(request({ maxItems: 1 }), { config: makeConfig() });
  record(
    'maxItems=1 -> exactly 1 candidate',
    Array.isArray(res.candidates) && res.candidates.length === 1,
    { count: res.candidates?.length }
  );
}

// 4) maxItems=10 -> clamped to <=3.
resetMock();
llm.state.content = JSON.stringify({
  candidates: [1, 2, 3, 4, 5].map((n) => ({ text: `偏好示例${n}` })),
});
{
  const res = await extractMemory(request({ maxItems: 10 }), { config: makeConfig() });
  record(
    'maxItems clamp: 10 -> <=3',
    Array.isArray(res.candidates) && res.candidates.length === 3,
    { count: res.candidates?.length }
  );
}

// 5) length cap: >60 dropped, ==60 kept, valid kept.
resetMock();
llm.state.content = JSON.stringify({
  candidates: [
    { text: 'a'.repeat(60) },
    { text: 'a'.repeat(61) },
    { text: '偏好早睡' },
  ],
});
{
  const res = await extractMemory(request(), { config: makeConfig() });
  const texts = candidateTexts(res) ?? [];
  record(
    'length cap: 61-char item dropped, 60-char + valid item kept (<=60 each)',
    texts.length === 2 &&
      texts.includes('a'.repeat(60)) &&
      texts.includes('偏好早睡') &&
      !texts.includes('a'.repeat(61)) &&
      texts.every((t) => t.length <= 60),
    { texts_lengths: texts.map((t) => t.length) }
  );
}

// 6) banned medical terms dropped while valid kept.
resetMock();
llm.state.content = JSON.stringify({
  candidates: [
    { text: '已确诊流感' },
    { text: '长期用药' },
    { text: '去某医院复查' },
    { text: '医生建议多休息' },
    { text: '偏好清淡饮食' },
  ],
});
{
  const res = await extractMemory(request(), { config: makeConfig() });
  const texts = candidateTexts(res) ?? [];
  record(
    'banned medical terms dropped per-item, valid items kept',
    texts.length === 1 &&
      texts[0] === '偏好清淡饮食' &&
      texts.every((t) => !MEDICAL_TERMS.some((w) => t.includes(w))),
    { texts }
  );
}

// 7) dedupe: first wins, duplicates removed.
resetMock();
llm.state.content = JSON.stringify({
  candidates: [{ text: '偏好早睡' }, { text: '偏好早睡' }, { text: '饮食清淡' }],
});
{
  const res = await extractMemory(request(), { config: makeConfig() });
  const texts = candidateTexts(res) ?? [];
  record(
    'dedupe: duplicate texts removed (first wins)',
    texts.length === 2 && texts[0] === '偏好早睡' && texts[1] === '饮食清淡',
    { texts }
  );
}

// 8) non-JSON model content -> empty + reason upstream_error, no throw.
resetMock();
llm.state.content = 'not json at all';
{
  let threw = false;
  let res = null;
  try {
    res = await extractMemory(request(), { config: makeConfig() });
  } catch {
    threw = true;
  }
  record(
    'non-JSON model content -> {candidates:[], reason:upstream_error}, does NOT throw',
    threw === false && Array.isArray(res.candidates) && res.candidates.length === 0 && res.reason === 'upstream_error',
    { threw, response: res }
  );
}

// 9) upstream 500 -> empty + upstream_error, no throw, retried once.
resetMock();
llm.state.mode = 'always-500';
{
  let threw = false;
  let res = null;
  try {
    res = await extractMemory(request(), { config: makeConfig() });
  } catch {
    threw = true;
  }
  record(
    'upstream 500 -> {candidates:[], reason:upstream_error}, does NOT throw, 1 retry',
    threw === false &&
      Array.isArray(res.candidates) &&
      res.candidates.length === 0 &&
      res.reason === 'upstream_error' &&
      llm.state.requests.length === 2,
    { threw, response: res, llm_calls: llm.state.requests.length }
  );
}

// 10) upstream timeout -> empty + upstream_error, no throw.
resetMock();
llm.state.mode = 'slow';
{
  let threw = false;
  let res = null;
  try {
    res = await extractMemory(request(), { config: makeConfig(), timeoutMs: 150 });
  } catch {
    threw = true;
  }
  record(
    'upstream timeout (150ms) -> {candidates:[], reason:upstream_error}, does NOT throw',
    threw === false && Array.isArray(res.candidates) && res.candidates.length === 0 && res.reason === 'upstream_error',
    { threw, response: res, llm_calls: llm.state.requests.length }
  );
}

// 11) consent !== true -> consent_required, ZERO upstream.
resetMock();
{
  const res = await extractMemory(request({ consent: false }), { config: makeConfig() });
  record(
    'consent !== true -> {candidates:[], reason:consent_required}, ZERO upstream calls',
    Array.isArray(res.candidates) && res.candidates.length === 0 && res.reason === 'consent_required' && llm.state.requests.length === 0,
    { response: res, llm_calls: llm.state.requests.length }
  );
}

// 12) LLM not configured -> provider_not_configured, ZERO network.
resetMock();
{
  const res = await extractMemory(request(), { config: makeConfig({ llm: { baseUrl: '' } }) });
  record(
    'LLM not configured -> {candidates:[], reason:provider_not_configured}, ZERO network calls',
    Array.isArray(res.candidates) && res.candidates.length === 0 && res.reason === 'provider_not_configured' && llm.state.requests.length === 0,
    { response: res, llm_calls: llm.state.requests.length }
  );
}

// 13) malformed messages (missing content) -> invalid_request, ZERO upstream.
resetMock();
{
  const res = await extractMemory(request({ messages: [{ role: 'user' }] }), { config: makeConfig() });
  record(
    'malformed messages -> {candidates:[], reason:invalid_request}, ZERO upstream calls',
    Array.isArray(res.candidates) && res.candidates.length === 0 && res.reason === 'invalid_request' && llm.state.requests.length === 0,
    { response: res, llm_calls: llm.state.requests.length }
  );
}

// 14) empty messages -> invalid_request, ZERO upstream.
resetMock();
{
  const res = await extractMemory(request({ messages: [] }), { config: makeConfig() });
  record(
    'empty messages -> {candidates:[], reason:invalid_request}, ZERO upstream calls',
    Array.isArray(res.candidates) && res.candidates.length === 0 && res.reason === 'invalid_request' && llm.state.requests.length === 0,
    { response: res, llm_calls: llm.state.requests.length }
  );
}

// 15) >2K messages total -> capped (asserted via recorded request body).
resetMock();
llm.state.content = JSON.stringify({ candidates: [{ text: '偏好早睡' }] });
{
  const messages = [
    { role: 'user', content: 'M0:' + 'x'.repeat(1000) },
    { role: 'assistant', content: 'M1:' + 'x'.repeat(1000) },
    { role: 'user', content: 'M2:' + 'x'.repeat(1000) },
  ];
  await extractMemory(request({ messages }), { config: makeConfig() });
  const chars = conversationChars(lastLlmBody());
  record(
    '>2K messages: outgoing conversation total <= LIMITS.maxExtractChars (dropped oldest first)',
    chars <= LIMITS.maxExtractChars && chars > 0,
    { outgoing_chars: chars, cap: LIMITS.maxExtractChars }
  );
}

// 16) single huge message -> hard-truncated to <=2K.
resetMock();
llm.state.content = JSON.stringify({ candidates: [{ text: '偏好早睡' }] });
{
  const messages = [{ role: 'user', content: 'H:' + 'y'.repeat(3000) }];
  await extractMemory(request({ messages }), { config: makeConfig() });
  const chars = conversationChars(lastLlmBody());
  record(
    'single >2K message: outgoing content hard-truncated to <= LIMITS.maxExtractChars',
    chars <= LIMITS.maxExtractChars && chars > 0,
    { outgoing_chars: chars, cap: LIMITS.maxExtractChars }
  );
}

// 17) prompt keyword routing anchor: system content contains 记忆提炼, not 问诊建议.
resetMock();
llm.state.content = JSON.stringify({ candidates: [{ text: '偏好早睡' }] });
{
  await extractMemory(request(), { config: makeConfig() });
  const sys = systemContent(lastLlmBody());
  const prompt = EXTRACT_SYSTEM_PROMPT;
  record(
    'prompt: system content contains 记忆提炼 and NOT 问诊建议 (EXTRACT_SYSTEM_PROMPT too)',
    sys.includes('记忆提炼') &&
      !sys.includes('问诊建议') &&
      prompt.includes('记忆提炼') &&
      !prompt.includes('问诊建议'),
    { system_length: sys.length }
  );
}

// 18) missing candidates field -> empty + upstream_error.
resetMock();
llm.state.content = JSON.stringify({ foo: 1 });
{
  const res = await extractMemory(request(), { config: makeConfig() });
  record(
    'missing candidates field -> {candidates:[], reason:upstream_error}',
    Array.isArray(res.candidates) && res.candidates.length === 0 && res.reason === 'upstream_error',
    { response: res }
  );
}

// 19) all candidates invalid -> valid extraction, empty candidates, NO reason.
resetMock();
llm.state.content = JSON.stringify({
  candidates: [{ text: '已确诊流感' }, { text: '' }, { notText: 1 }, 'string-item'],
});
{
  const res = await extractMemory(request(), { config: makeConfig() });
  record(
    'all candidates invalid -> {candidates:[]} with NO reason (successful-but-empty)',
    Array.isArray(res.candidates) && res.candidates.length === 0 && !('reason' in res),
    { response: res }
  );
}

// 20) non-object / missing-text candidates dropped while valid item kept.
resetMock();
llm.state.content = JSON.stringify({
  candidates: ['raw-string', null, { nope: true }, { text: '  偏好早睡  ' }],
});
{
  const res = await extractMemory(request(), { config: makeConfig() });
  const texts = candidateTexts(res) ?? [];
  record(
    'non-object / missing-text candidates dropped, valid item trimmed and kept',
    texts.length === 1 && texts[0] === '偏好早睡',
    { texts }
  );
}

// 21) privacy: the extract module has no disk-write or console statements.
{
  const file = 'server/extract-memory.ts';
  const banned = [
    'writeFile',
    'appendFile',
    'createWriteStream',
    'node:fs',
    'console.log',
    'console.error',
    'console.warn',
  ];
  const src = readFileSync(resolve(root, file), 'utf8');
  const hits = banned.filter((token) => src.includes(token));
  record(
    'privacy: server/extract-memory.ts has no disk-write or console statements',
    hits.length === 0,
    { file, banned_hits: hits }
  );
}

// ---------------------------------------------------------------------------
// Route-level HTTP regression (T43 follow-up): 413 envelope delivery + status codes.
// Spawns the real server (demo=true temp config → zero network) and drives it with
// system curl — the exact transport that exposed the destroyed-socket 413 bug.
// ---------------------------------------------------------------------------

{
  const port = await getFreePort();
  const configPath = join(tmpdir(), `mhp-extract-route-${process.pid}-${Date.now()}.json`);
  const bigPath = join(tmpdir(), `mhp-extract-big-${process.pid}-${Date.now()}.json`);
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        port,
        demo: true,
        llm: { baseUrl: '', apiKey: '', model: '' },
        search: { baseUrl: '', apiKey: '' },
        authorityDomains: [],
      },
      null,
      2
    )}\n`
  );
  writeFileSync(
    bigPath,
    JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(75000) }], consent: true })
  );

  const started = spawnServer(configPath);
  try {
    const health = await waitForHealth(port);
    const base = `http://127.0.0.1:${port}`;

    const extractBig = curlRaw(`${base}/api/extract-memory`, { dataFile: bigPath });
    record(
      'route: oversized body to /api/extract-memory -> 413 with payload_too_large envelope (curl transport)',
      health.status === 200 && extractBig.status === '413' && extractBig.body.includes('payload_too_large'),
      { http_status: extractBig.status, body_length: extractBig.body.length }
    );

    const askBig = curlRaw(`${base}/api/ask`, { dataFile: bigPath });
    record(
      'route: oversized body to /api/ask -> 413 with payload_too_large envelope (shared readBody)',
      askBig.status === '413' && askBig.body.includes('payload_too_large'),
      { http_status: askBig.status, body_length: askBig.body.length }
    );

    const malformed = curlRaw(`${base}/api/extract-memory`, { data: 'not json' });
    record(
      'route: malformed JSON -> 400',
      malformed.status === '400' && malformed.body.includes('invalid_request'),
      { http_status: malformed.status }
    );

    const wrongMethod = curlRaw(`${base}/api/extract-memory`, { method: 'GET' });
    record('route: GET /api/extract-memory -> 405', wrongMethod.status === '405', {
      http_status: wrongMethod.status,
    });

    const preflight = curlRaw(`${base}/api/extract-memory`, { method: 'OPTIONS' });
    record('route: OPTIONS /api/extract-memory -> 204', preflight.status === '204', {
      http_status: preflight.status,
    });

    const unknown = curlRaw(`${base}/nope`, { method: 'GET' });
    record('route: unknown route -> 404', unknown.status === '404', {
      http_status: unknown.status,
    });
  } finally {
    await stopServer(started.child);
    rmSync(configPath, { force: true });
    rmSync(bigPath, { force: true });
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
  command: 'npx tsx scripts/check-extract.mjs',
  timestamp: new Date().toISOString(),
  modules: ['server/extract-memory.ts', 'server/prompts.ts', 'server/validate.ts'],
  mocks: [{ name: llm.name, base_url: llm.baseUrl }],
  cases,
  summary,
};

const outDir = resolve(root, 'artifacts/checks');
mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, 'server-extract.json'), `${JSON.stringify(artifact, null, 2)}\n`);

await llm.close();

for (const c of cases) {
  console.log(`${c.pass ? 'PASS' : 'FAIL'} - ${c.name}`);
}
console.log(`cases ${summary.passed}/${summary.total} passed, failed=${summary.failed}`);
console.log(`wrote ${resolve(outDir, 'server-extract.json')}`);

process.exit(summary.failed === 0 ? 0 : 1);
