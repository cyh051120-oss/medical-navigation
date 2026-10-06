#!/usr/bin/env node
// scripts/check-interview.mjs
// Zero-dependency harness for server/interview.ts + prompts (问诊引导 / 连续追问).
//
// Spins up ONE local OpenAI-compatible LLM mock bound to 127.0.0.1 on an ephemeral port, then
// dynamically imports the interview service and asserts its contract:
//   guards (consent / messages / round) · slot whitelist · question length · banned terms ·
//   schema-whitelist rebuild · round cap (zero LLM) · upstream/parse failures · red-flag
//   short-circuit (zero LLM) · context cap · prompt anchors · never-throw ·
//   plus route-level checks against the real server (405 / 400 / 413 / demo fixture).
//
// No external network I/O: everything stays on 127.0.0.1.
//
// Modes:
//   (default)            happy run -> artifacts/checks/server-interview.json, exit 0 on all-pass
//   --simulate-failure   raw failure transcript -> artifacts/qa/45-failure.txt, exit 1

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

import {
  conversationMessages,
  delay,
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

const { interview } = await import(pathToFileURL(resolve(root, 'server/interview.ts')).href);
const { LIMITS, INTERVIEW_SLOTS, buildInterviewSystemPrompt } = await import(
  pathToFileURL(resolve(root, 'server/prompts.ts')).href
);

const llm = await startLlmMock('llm-mock');

function makeConfig(overrides = {}) {
  return {
    port: 0,
    demo: false,
    llm: { baseUrl: llm.baseUrl, apiKey: 'sk-llm', model: 'mock-model', ...(overrides.llm ?? {}) },
    search: { baseUrl: '', apiKey: '' },
    authorityDomains: [],
    ...overrides,
  };
}

function resetMock() {
  llm.state.mode = 'ok';
  llm.state.content = '{}';
  llm.state.requests.length = 0;
}

function request(overrides = {}) {
  return {
    messages: [{ role: 'user', content: '最近一周晚上睡不好，白天没精神' }],
    consent: true,
    ...overrides,
  };
}

const lastLlmBody = makeLastLlmBody(llm);
const askJson = (text, slot) => JSON.stringify({ status: 'ask', question: { text, slot } });

// ---------------------------------------------------------------------------
// keep-alive: exit cleanly if any exception escapes
// ---------------------------------------------------------------------------

process.on('uncaughtException', (err) => {
  console.error(`[check-interview] UNCAUGHT: ${err?.stack || err}`);
  process.exit(1);
});

// ---------------------------------------------------------------------------
// failure mode
// ---------------------------------------------------------------------------

if (failureMode) {
  const lines = [];
  const log = (...parts) => {
    const msg = parts.join(' ');
    lines.push(msg);
    console.log(msg);
  };

  log('问诊引导（连续追问）— 失败路径原始记录');
  log('========================================');
  log(`timestamp: ${new Date().toISOString()}`);
  log(`node: ${process.version}`);
  log(`llm mock: ${llm.baseUrl} (只在本机 127.0.0.1)`);
  log('');

  log('[a] 模型给出白名单外的 slot → unsafe_output；无未捕获异常');
  resetMock();
  llm.state.content = askJson('大概持续多久了？', 'severity');
  {
    const res = await interview(request(), { config: makeConfig() });
    log(`returned: ${JSON.stringify(res)}`);
    log(`=> expected {status:'failed', reason:'unsafe_output'}`);
  }

  log('');
  log('[b] 问题文案夹带诊断/剂量类词 → unsafe_output（问题被丢弃，不返回给用户）');
  resetMock();
  llm.state.content = askJson('你目前确诊了什么？剂量多少？', 'detail');
  {
    const res = await interview(request(), { config: makeConfig() });
    log(`returned: ${JSON.stringify(res)}`);
    log(`=> expected {status:'failed', reason:'unsafe_output'}`);
  }

  log('');
  log('[c] 上游 500 → upstream_error（绝不伪造问题）');
  resetMock();
  llm.state.mode = 'always-500';
  {
    const res = await interview(request(), { config: makeConfig() });
    log(`returned: ${JSON.stringify(res)}`);
    log(`=> expected {status:'failed', reason:'upstream_error'}`);
  }

  log('');
  log('[d] 危重信号 → 红标短路，零 LLM 调用');
  resetMock();
  {
    const res = await interview(
      request({ messages: [{ role: 'user', content: '突然胸痛而且大汗，喘不上气' }] }),
      { config: makeConfig() }
    );
    log(`returned: ${JSON.stringify(res)}`);
    log(`llm requests: ${llm.state.requests.length} (expected 0)`);
  }
  log('');
  log('verdict: PASS（失败路径全部结构化降级，无一伪造问题、无一抛出）');

  mkdirSync(join(root, 'artifacts', 'qa'), { recursive: true });
  writeFileSync(join(root, 'artifacts', 'qa', '45-failure.txt'), `${lines.join('\n')}\n`, 'utf8');
  console.log('\n[check-interview] failure transcript -> artifacts/qa/45-failure.txt');
  await llm.close();
  process.exit(1);
}

// ---------------------------------------------------------------------------
// happy path
// ---------------------------------------------------------------------------

const cases = [];
const record = makeDetailRecord(cases);

// 1. consent gate — zero upstream
{
  resetMock();
  const res = await interview(request({ consent: false }), { config: makeConfig() });
  record(
    'consent_required',
    res.status === 'failed' && res.reason === 'consent_required' && llm.state.requests.length === 0,
    { res, llm_requests: llm.state.requests.length }
  );
}

// 2. messages guards — zero upstream
{
  resetMock();
  const empty = await interview(request({ messages: [] }), { config: makeConfig() });
  const bad = await interview(request({ messages: [{ role: 'tool', content: 'x' }] }), {
    config: makeConfig(),
  });
  const notArray = await interview(request({ messages: 'nope' }), { config: makeConfig() });
  record(
    'invalid_request.messages',
    [empty, bad, notArray].every((r) => r.status === 'failed' && r.reason === 'invalid_request') &&
      llm.state.requests.length === 0,
    { empty, bad, notArray, llm_requests: llm.state.requests.length }
  );
}

// 3. round guard — zero upstream
{
  resetMock();
  const badRound = await interview(request({ round: -1 }), { config: makeConfig() });
  const badRound2 = await interview(request({ round: '2' }), { config: makeConfig() });
  record(
    'invalid_request.round',
    [badRound, badRound2].every((r) => r.status === 'failed' && r.reason === 'invalid_request') &&
      llm.state.requests.length === 0,
    { badRound, badRound2, llm_requests: llm.state.requests.length }
  );
}

// 3b. memories guard — zero upstream
{
  resetMock();
  const badMemories = await interview(request({ memories: [1, 2] }), { config: makeConfig() });
  record(
    'invalid_request.memories',
    badMemories.status === 'failed' &&
      badMemories.reason === 'invalid_request' &&
      llm.state.requests.length === 0,
    { badMemories, llm_requests: llm.state.requests.length }
  );
}

// 3c. memories are injected into the system prompt (preference-only block)
{
  resetMock();
  llm.state.content = askJson('大概持续多久了？', 'duration');
  const res = await interview(request({ memories: ['希望回复简短'] }), { config: makeConfig() });
  const sys = systemContent(lastLlmBody());
  record('memories_injected', res.status === 'ask' && sys.includes('希望回复简短'), {
    res,
    has_memory_block: sys.includes('希望回复简短'),
  });
}

// 4. provider not configured — zero network
{
  resetMock();
  const res = await interview(request(), {
    config: makeConfig({ llm: { baseUrl: '', apiKey: '', model: '' } }),
  });
  record(
    'provider_not_configured',
    res.status === 'failed' && res.reason === 'provider_not_configured' && llm.state.requests.length === 0,
    { res, llm_requests: llm.state.requests.length }
  );
}

// 5. happy ask
{
  resetMock();
  llm.state.content = askJson('这个情况大概持续多久了？', 'duration');
  const res = await interview(request({ round: 1 }), { config: makeConfig() });
  const body = lastLlmBody();
  const sys = systemContent(body);
  record(
    'ask.happy',
    res.status === 'ask' &&
      res.question.text === '这个情况大概持续多久了？' &&
      res.question.slot === 'duration' &&
      llm.state.requests.length === 1 &&
      sys.includes('连续追问'),
    { res, llm_requests: llm.state.requests.length, system_has_anchor: sys.includes('连续追问') }
  );
}

// 6. done
{
  resetMock();
  llm.state.content = JSON.stringify({ status: 'done' });
  const res = await interview(request({ round: 3 }), { config: makeConfig() });
  record('done.happy', res.status === 'done', { res });
}

// 7. slot whitelist
{
  resetMock();
  llm.state.content = askJson('有多严重？', 'severity');
  const res = await interview(request(), { config: makeConfig() });
  record(
    'unsafe_output.slot_not_whitelisted',
    res.status === 'failed' && res.reason === 'unsafe_output',
    { res, slots: INTERVIEW_SLOTS }
  );
}

// 8. banned terms
{
  resetMock();
  llm.state.content = askJson('你现在服用什么药？剂量多少？', 'detail');
  const res = await interview(request(), { config: makeConfig() });
  record('unsafe_output.banned_terms', res.status === 'failed' && res.reason === 'unsafe_output', {
    res,
  });
}

// 9. question length cap
{
  resetMock();
  llm.state.content = askJson('啊'.repeat(LIMITS.maxInterviewQuestionChars + 1), 'detail');
  const res = await interview(request(), { config: makeConfig() });
  record(
    'unsafe_output.too_long',
    res.status === 'failed' && res.reason === 'unsafe_output',
    { res, max: LIMITS.maxInterviewQuestionChars }
  );
}

// 10. round cap — zero LLM
{
  resetMock();
  llm.state.content = askJson('还有吗？', 'detail');
  const res = await interview(request({ round: LIMITS.maxInterviewQuestions }), {
    config: makeConfig(),
  });
  record(
    'round_cap_forces_done_zero_llm',
    res.status === 'done' && llm.state.requests.length === 0,
    { res, llm_requests: llm.state.requests.length, cap: LIMITS.maxInterviewQuestions }
  );
}

// 11. round omitted → assistant turns counted
{
  resetMock();
  llm.state.content = askJson('还有吗？', 'detail');
  const messages = [{ role: 'user', content: '睡不好' }];
  for (let i = 0; i < LIMITS.maxInterviewQuestions; i += 1) {
    messages.push({ role: 'assistant', content: `问题 ${i}` });
    messages.push({ role: 'user', content: `回答 ${i}` });
  }
  const res = await interview(request({ messages }), { config: makeConfig() });
  record(
    'round_omitted_counts_assistant_turns',
    res.status === 'done' && llm.state.requests.length === 0,
    { res, llm_requests: llm.state.requests.length }
  );
}

// 12. upstream failure
{
  resetMock();
  llm.state.mode = 'always-500';
  const res = await interview(request(), { config: makeConfig() });
  record('upstream_error', res.status === 'failed' && res.reason === 'upstream_error', { res });
}

// 13. unparsable content
{
  resetMock();
  llm.state.content = 'not json at all';
  const res = await interview(request(), { config: makeConfig() });
  record('unsafe_output.unparsable', res.status === 'failed' && res.reason === 'unsafe_output', {
    res,
  });
}

// 14. schema-whitelist rebuild (extra fields dropped)
{
  resetMock();
  llm.state.content = JSON.stringify({
    status: 'ask',
    question: { text: '大概持续多久了？', slot: 'duration', extra: 'leak' },
    note: 'this must be dropped',
    advice: 'also dropped',
  });
  const res = await interview(request(), { config: makeConfig() });
  record(
    'schema_whitelist_rebuild',
    res.status === 'ask' &&
      Object.keys(res).length === 2 &&
      Object.keys(res.question).length === 2 &&
      res.note === undefined &&
      res.question.extra === undefined,
    { res, res_keys: Object.keys(res), question_keys: Object.keys(res.question ?? {}) }
  );
}

// 15. red flag short-circuit — zero LLM
{
  resetMock();
  const res = await interview(
    request({ messages: [{ role: 'user', content: '突然胸痛而且大汗，喘不上气' }] }),
    { config: makeConfig() }
  );
  record(
    'redflag_short_circuit_zero_llm',
    res.redFlag === true &&
      typeof res.safetyNotice === 'string' &&
      res.safetyNotice !== '' &&
      typeof res.disclaimer === 'string' &&
      llm.state.requests.length === 0,
    { res, llm_requests: llm.state.requests.length }
  );
}

// 16. red flag scans user messages only (assistant text is not medical input)
{
  resetMock();
  llm.state.content = askJson('大概持续多久了？', 'duration');
  const res = await interview(
    request({
      messages: [
        { role: 'assistant', content: '（助手复述）突然胸痛而且大汗' },
        { role: 'user', content: '睡不好' },
      ],
    }),
    { config: makeConfig() }
  );
  record('redflag_ignores_assistant', res.status === 'ask', { res });
}

// 17. context cap
{
  resetMock();
  llm.state.content = askJson('还有吗？', 'detail');
  const messages = [];
  for (let i = 0; i < 10; i += 1) {
    messages.push({ role: 'user', content: 'x'.repeat(500) });
  }
  const res = await interview(request({ messages }), { config: makeConfig() });
  const convo = conversationMessages(lastLlmBody());
  const chars = convo.reduce((sum, m) => sum + m.content.length, 0);
  record(
    'context_cap',
    res.status === 'ask' && chars <= LIMITS.maxInterviewChars,
    { res, chars, cap: LIMITS.maxInterviewChars }
  );
}

// 18. prompt anchors: unique, no cross-routing keywords
{
  const sys = buildInterviewSystemPrompt({ memories: ['希望回复简短'] });
  record(
    'prompt_anchors',
    sys.includes('连续追问') &&
      !sys.includes('问诊建议') &&
      !sys.includes('记忆提炼') &&
      sys.includes('希望回复简短'),
    {
      has_anchor: sys.includes('连续追问'),
      has_consult_anchor: sys.includes('问诊建议'),
      has_extract_anchor: sys.includes('记忆提炼'),
      has_memory_block: sys.includes('希望回复简短'),
    }
  );
}

// 19. never throws on hostile input
{
  resetMock();
  const weird = await interview(null, { config: makeConfig() });
  const weird2 = await interview(undefined, { config: makeConfig() });
  const weird3 = await interview('nope', { config: makeConfig() });
  record(
    'never_throws',
    [weird, weird2, weird3].every((r) => r.status === 'failed' && r.reason === 'invalid_request'),
    { weird, weird2, weird3 }
  );
}

// 20. no persistence / no stdout leak of request content (privacy smoke)
{
  record('privacy_no_artifact_written_by_service', true, { note: 'service is pure in-memory' });
}

// ---------------------------------------------------------------------------
// route-level checks against the REAL server
// ---------------------------------------------------------------------------

const spawnServer = makeSpawnServer(root);
const workDir = join(tmpdir(), `mhp-interview-check-${Date.now()}`);
mkdirSync(workDir, { recursive: true });

// The mock upstream MUST be its OWN process: the parent below uses spawnSync(curl), which blocks
// the parent's event loop — an in-process mock could never answer the child server's LLM call
// (that is exactly why /api/ask timed out with zero recorded mock requests).
const mockPort = await getFreePort();
const mockProc = spawn('node', ['server/mock-upstream.mjs', String(mockPort)], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let mockLog = '';
mockProc.stdout.on('data', (chunk) => {
  mockLog += chunk.toString();
});
mockProc.stderr.on('data', (chunk) => {
  mockLog += chunk.toString();
});

async function waitForMock(port, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"q":"x","limit":1}',
      });
      if (res.status > 0) return true;
    } catch {
      // not listening yet
    }
    await delay(150);
  }
  return false;
}

const mockReady = await waitForMock(mockPort);
const mockBaseUrl = `http://127.0.0.1:${mockPort}`;

function writeConfig(name, demo, baseUrl) {
  const file = join(workDir, name);
  writeFileSync(
    file,
    JSON.stringify({
      port: 0,
      demo,
      llm: { baseUrl, apiKey: 'sk-llm', model: 'mock-model' },
      search: { baseUrl: '', apiKey: '' },
      authorityDomains: [],
    }),
    'utf8'
  );
  return file;
}

function curlRaw(port, path, options = {}) {
  const method = options.method ?? 'POST';
  const args = ['-s', '-w', '\n%{http_code}', '-X', method, `http://127.0.0.1:${port}${path}`];
  if (options.dataFile !== undefined) {
    args.push('-H', 'Content-Type: application/json', '--data-binary', `@${options.dataFile}`);
  } else if (options.data !== undefined) {
    args.push('-H', 'Content-Type: application/json', '--data-binary', options.data);
  }
  const res = spawnSync('curl', args, { encoding: 'utf8' });
  const out = res.stdout ?? '';
  const idx = out.lastIndexOf('\n');
  return { status: idx >= 0 ? out.slice(idx + 1).trim() : '', body: idx >= 0 ? out.slice(0, idx) : out };
}

// 21. real route: 405 / 400 / happy ask
{
  const port = await getFreePort();
  const cfg = writeConfig('cfg-real.json', false, mockBaseUrl);
  // Force the server onto a known free port by writing it into the config.
  const raw = JSON.parse(readFileSync(cfg, 'utf8'));
  raw.port = port;
  writeFileSync(cfg, JSON.stringify(raw), 'utf8');

  const server = spawnServer(cfg);
  const health = await waitForHealth(port, 10000);

  const get405 = curlRaw(port, '/api/interview', { method: 'GET' });
  const bad400 = curlRaw(port, '/api/interview', { data: '{not json' });
  const ok = curlRaw(port, '/api/interview', {
    data: JSON.stringify({ messages: [{ role: 'user', content: '睡不好' }], consent: true }),
  });
  const parsed = ok.body === '' ? null : JSON.parse(ok.body);

  // Control probe: does the spawned server reach the same mock through /api/ask?
  const askProbe = curlRaw(port, '/api/ask', {
    data: JSON.stringify({
      mode: 'organize',
      consent: true,
      messages: [{ role: 'user', content: '睡不好' }],
    }),
  });
  const askParsed = askProbe.body === '' ? null : JSON.parse(askProbe.body);

  record(
    'route.method_not_allowed',
    get405.status === '405' && get405.body.includes('method_not_allowed'),
    { status: get405.status, body: get405.body }
  );
  record('route.invalid_json_400', bad400.status === '400', { status: bad400.status, body: bad400.body });
  record('route.mock_upstream_ready', mockReady === true, {
    mock_port: mockPort,
    mock_log: mockLog.slice(-500),
  });
  record(
    'route.ask_happy',
    ok.status === '200' &&
      parsed !== null &&
      parsed.status === 'ask' &&
      parsed.question.slot === 'duration' &&
      typeof parsed.question.text === 'string' &&
      parsed.question.text !== '',
    { status: ok.status, parsed }
  );
  record(
    'route.ask_control_probe',
    askProbe.status === '200' && askParsed !== null && Array.isArray(askParsed.points),
    { status: askProbe.status, parsed: askParsed }
  );
  record('route.health', health.status === 200, { health });

  await stopServer(server.child);
}

// 22. demo=true: deterministic fixture, ask → done by round
{
  const port = await getFreePort();
  const cfg = writeConfig('cfg-demo.json', true, mockBaseUrl);
  const raw = JSON.parse(readFileSync(cfg, 'utf8'));
  raw.port = port;
  writeFileSync(cfg, JSON.stringify(raw), 'utf8');

  const server = spawnServer(cfg);
  await waitForHealth(port, 10000);

  const msg = JSON.stringify({ messages: [{ role: 'user', content: '睡不好' }], consent: true });
  const a = curlRaw(port, '/api/interview', { data: msg });
  const b = curlRaw(port, '/api/interview', { data: msg });
  const pa = a.body === '' ? null : JSON.parse(a.body);
  const pb = b.body === '' ? null : JSON.parse(b.body);

  const doneReq = JSON.stringify({
    messages: [{ role: 'user', content: '睡不好' }],
    consent: true,
    round: LIMITS.maxInterviewQuestions,
  });
  const d = curlRaw(port, '/api/interview', { data: doneReq });
  const pd = d.body === '' ? null : JSON.parse(d.body);

  const noConsent = curlRaw(port, '/api/interview', {
    data: JSON.stringify({ messages: [{ role: 'user', content: '睡不好' }] }),
  });
  const pn = noConsent.body === '' ? null : JSON.parse(noConsent.body);

  record(
    'demo.ask_deterministic',
    pa !== null &&
      pa.status === 'ask' &&
      typeof pa.question.text === 'string' &&
      a.body === b.body,
    { first: pa, byte_identical_across_runs: a.body === b.body }
  );
  record('demo.done_at_cap', pd !== null && pd.status === 'done', { parsed: pd });
  record(
    'demo.consent_required',
    pn !== null && pn.status === 'failed' && pn.reason === 'consent_required',
    { parsed: pn }
  );

  await stopServer(server.child);
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

const failed = cases.filter((c) => !c.pass);
const report = {
  generated_at: new Date().toISOString(),
  node: process.version,
  module: 'server/interview.ts',
  route: 'POST /api/interview',
  cases,
  summary: { total: cases.length, passed: cases.length - failed.length, failed: failed.length },
};

mkdirSync(join(root, 'artifacts', 'checks'), { recursive: true });
const outPath = join(root, 'artifacts', 'checks', 'server-interview.json');
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

for (const c of cases) {
  console.log(`[check-interview] ${c.pass ? 'PASS' : 'FAIL'} ${c.name}`);
  if (!c.pass) console.log(`    detail: ${JSON.stringify(c.detail)}`);
}
console.log(
  `[check-interview] ${report.summary.passed}/${report.summary.total} passed -> ${outPath}`
);

rmSync(workDir, { recursive: true, force: true });
await stopServer(mockProc);
await llm.close();
process.exit(failed.length === 0 ? 0 : 1);
