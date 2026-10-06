#!/usr/bin/env node
// scripts/check-aiclient.mjs
// Zero-dependency harness (tsx-run) for hospital-ai-miniapp/shared/services/aiClient.ts (task 28).
//
// Installs a `wx` shim BEFORE importing the modules under test:
//   - in-memory Map backing storage.ts (get/set/remove/getStorageInfoSync);
//   - programmable `wx.request` mock recording every call, with modes
//     ok / unreachable / timeout / http-500 / bad-json.
// NO devtools, NO window, NO real network: this node harness is the plan-approved
// alternative to the frozen E2E path.
//
// Modes:
//   (default)            happy run -> artifacts/e2e/redaction.json, exit 0 on all-pass
//   --simulate-failure   real degraded/skipped runs (proxy unreachable, aiEnabled off,
//                        blocked host) -> artifacts/qa/28-failure.txt, exit 1.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { makeRunTypecheck, resetStore } from './lib/check-helpers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const failureMode = process.argv.includes('--simulate-failure');

const EXACT_NOTICE = '回复后将自动提炼偏好记忆（可在设置关闭）';

// ---------------------------------------------------------------------------
// wx shim (installed before any module under test is imported)
// ---------------------------------------------------------------------------
function createWxShim() {
  const store = new Map();
  const requests = [];
  const shim = {
    _store: store,
    _requests: requests,
    _requestMode: 'ok',
    _response: { ok: true, mode: 'organize' },

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

    request(options) {
      requests.push(options);
      setTimeout(() => {
        switch (shim._requestMode) {
          case 'unreachable':
            options.fail({ errMsg: 'request:fail' });
            break;
          case 'timeout':
            options.fail({ errMsg: 'request:fail timeout' });
            break;
          case 'http-500':
            options.success({ statusCode: 500, data: { error: 'boom' } });
            break;
          case 'bad-json':
            options.success({ statusCode: 200, data: 'not-json' });
            break;
          default:
            options.success({ statusCode: 200, data: shim._response });
        }
      }, 0);
      return { abort() {} };
    },
  };
  return shim;
}

globalThis.wx = createWxShim();
const wx = globalThis.wx;

function resetRequests() {
  wx._requests.length = 0;
  wx._requestMode = 'ok';
  wx._response = { ok: true, mode: 'organize' };
}
function countOf(text, needle) {
  return text.split(needle).length - 1;
}

// ---------------------------------------------------------------------------
// Modules under test (after the shim is installed)
// ---------------------------------------------------------------------------
const ai = await import(
  pathToFileURL(resolve(root, 'hospital-ai-miniapp/shared/services/aiClient.ts')).href
);
const records = await import(
  pathToFileURL(resolve(root, 'hospital-ai-miniapp/shared/services/records.ts')).href
);
const texts = await import(pathToFileURL(resolve(root, 'hospital-ai-miniapp/config/texts.ts')).href);

// ---------------------------------------------------------------------------
// Fixtures (synthetic; fake PII only)
// ---------------------------------------------------------------------------
const PROFILE = {
  name: '张伟',
  ageRange: '60-69 岁',
  gender: '男',
  allergies: '对青霉素过敏，联系电话 13800138000',
  medications: '长期服用降压药',
  history: '张伟 2019 年住院；身份证 11010119500101123X',
};
const PHONE_A = '13800138000';
const PHONE_B = '13912345678';
const ID_CARD = '11010119500101123X';
const USER_MESSAGE = { role: 'user', content: `我最近咳嗽，我是张伟，电话 ${PHONE_B}` };
const ASSISTANT_MESSAGE = { role: 'assistant', content: '我们可以先把情况整理一下。' };
const EXCERPTS = ['症状：咳嗽持续 3 天（2026-09-01）', '资料：体检报告：张伟，肺功能正常'];

function seedProfile() {
  records.profile.add({ ...PROFILE });
  return records.profile.list()[0];
}

function seedMemories() {
  records.memory.add({ text: '希望回复简短一些', source: 'manual', enabled: true });
  records.memory.add({ text: '不要推荐具体医生', source: 'ai', enabled: true });
  const hidden = records.memory.add({ text: '关闭的记忆不应发送 13800138000', enabled: false });
  return { all: records.memory.list(), hiddenId: hidden.id };
}

function baseAskInput() {
  return {
    mode: 'consult',
    messages: [USER_MESSAGE, ASSISTANT_MESSAGE],
    profile: seedProfile(),
    excerpts: EXCERPTS,
    memories: seedMemories().all,
  };
}

function expectedSectionText(key, value) {
  if (key === 'profileSummary') return value;
  if (key === 'recordExcerpts' || key === 'memories') {
    return value.map((line, index) => `${index + 1}. ${line}`).join('\n');
  }
  const label = { user: '用户', assistant: '助手', system: '系统' };
  return value.map((message) => `${label[message.role]}：${message.content}`).join('\n');
}

const runTypecheck = makeRunTypecheck(root);

// ---------------------------------------------------------------------------
// Failure mode (--simulate-failure): REAL degraded/skipped runs, exit 1.
// ---------------------------------------------------------------------------
if (failureMode) {
  const lines = [];
  const log = (...parts) => {
    const msg = parts.join(' ');
    lines.push(msg);
    console.log(msg);
  };

  log('T28 aiClient — 失败路径原始记录（代理不可达 / 未开启 / 未同意 / 非本机地址）');
  log('========================================');
  log(`timestamp: ${new Date().toISOString()}`);
  log(`node: ${process.version}`);
  log(`proxy: ${ai.DEFAULT_PROXY_URL}（host 白名单 ${ai.ALLOWED_PROXY_HOSTS.join(' / ')}）`);
  log('');

  const input = {
    mode: 'organize',
    messages: [{ role: 'user', content: '我最近睡不好' }],
    profile: null,
    excerpts: [],
    memories: [],
  };

  log('[a] aiEnabled=false → {skipped:true, reason:ai_disabled}，零 wx.request');
  resetStore();
  resetRequests();
  {
    const res = await ai.sendAsk(input, { prefs: { aiEnabled: false }, consent: true });
    log(`returned: ${JSON.stringify(res)}`);
    log(`wx.request 调用数 = ${wx._requests.length} (期望 0)`);
  }
  log('');

  log('[b] consent 未给 → {skipped:true, reason:consent_required}，零 wx.request');
  resetStore();
  resetRequests();
  {
    const res = await ai.sendAsk(input, { prefs: { aiEnabled: true } });
    log(`returned: ${JSON.stringify(res)}`);
    log(`wx.request 调用数 = ${wx._requests.length} (期望 0)`);
  }
  log('');

  log('[c] 代理不可达（wx.request fail）→ 结构化降级 {ok:false, degraded:true}，不抛异常、无伪内容');
  resetStore();
  resetRequests();
  wx._requestMode = 'unreachable';
  {
    let threw = false;
    let res = null;
    try {
      res = await ai.sendAsk(input, { prefs: { aiEnabled: true }, consent: true });
    } catch (e) {
      threw = true;
    }
    log(`threw = ${threw}`);
    log(`returned: ${JSON.stringify(res)}`);
    log(`has_fake_data = ${res !== null && 'data' in res}`);
    log(`wx.request 调用数 = ${wx._requests.length} (期望 1：已尝试连接本机代理)`);
  }
  log('');

  log('[d] 非本机代理地址（http://evil.example.com）→ {ok:false, error:blocked_host}，零 wx.request');
  resetStore();
  resetRequests();
  {
    let threw = false;
    let code = '';
    try {
      ai.assertProxyUrl('http://evil.example.com:8787');
    } catch (e) {
      threw = true;
      code = e && e.code ? String(e.code) : '';
    }
    const res = await ai.sendAsk(input, {
      prefs: { aiEnabled: true },
      consent: true,
      baseUrl: 'http://evil.example.com:8787',
    });
    log(`assertProxyUrl threw = ${threw}, code = ${code}`);
    log(`returned: ${JSON.stringify(res)}`);
    log(`wx.request 调用数 = ${wx._requests.length} (期望 0)`);
  }
  log('');

  log('结论：关闭 / 未同意 → 零网络直接返回 {skipped:true}；代理不可达 → 结构化降级且不伪造；');
  log('      非本机地址在传输前被 host 白名单拒绝。全程未抛未捕获异常。');

  const outDir = resolve(root, 'artifacts/qa');
  mkdirSync(outDir, { recursive: true });
  const body = [
    'T28 aiClient failure demo (proxy unreachable + skipped paths)',
    'command: npx tsx scripts/check-aiclient.mjs --simulate-failure',
    `timestamp: ${new Date().toISOString()}`,
    '',
    ...lines,
    '',
    'exit_code: 1',
    '',
  ].join('\n');
  writeFileSync(resolve(outDir, '28-failure.txt'), body);
  console.log(`wrote ${resolve(outDir, '28-failure.txt')}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Happy run
// ---------------------------------------------------------------------------
const typecheck = runTypecheck();
const cases = [];
function record(name, pass, details) {
  cases.push({ name, pass: pass === true, details });
}

// 1) redaction across every section (profile / excerpts / memories / messages).
resetStore();
const built = ai.buildAskPayload(baseAskInput());
const sentHappy = ai.serializeAskPayload(built.payload);
{
  const leaked = [PROFILE.name, PHONE_A, PHONE_B, ID_CARD].filter((token) => sentHappy.includes(token));
  const placeholders = [ai.NAME_PLACEHOLDER, ai.PHONE_PLACEHOLDER, ai.ID_PLACEHOLDER].filter((token) =>
    sentHappy.includes(token)
  );
  record(
    'payload: 去掉姓名/手机号/证件号（含自由文本内），并保留占位符',
    leaked.length === 0 &&
      placeholders.length === 3 &&
      built.payload.profileSummary.includes('60-69 岁') &&
      built.payload.recordExcerpts.length === EXCERPTS.length,
    { leaked_tokens: leaked, placeholders_present: placeholders, profile_summary: built.payload.profileSummary }
  );
}

// 2) preview reassembles EXACTLY to the payload (canonical byte-equal).
{
  const reassembled = ai.reassembleAskPayload(built.preview);
  const byteEqual = ai.serializeAskPayload(reassembled) === sentHappy;
  record('preview: 逐段还原后与 payload 逐字节相等', byteEqual, {
    payload_bytes: sentHappy.length,
    reassembled_bytes: ai.serializeAskPayload(reassembled).length,
  });
}

// 3) preview sections are titled and their text matches the payload fragments.
{
  const titles = built.preview.sections.map((section) => section.title);
  const textOk = built.preview.sections.every(
    (section) => section.text === expectedSectionText(section.key, section.value)
  );
  record(
    'preview: 四段（档案摘要/记录摘录/记忆/对话）标题齐全且 text 与片段一致',
    ['档案摘要', '记录摘录', '记忆', '对话'].every((title) => titles.includes(title)) && textOk,
    { titles, text_consistent: textOk }
  );
}

// 4) memories: disabled excluded; caps <=20 items / <=1K chars.
resetStore();
{
  for (let i = 0; i < 25; i += 1) {
    records.memory.add({ text: `启用记忆 ${i}：` + 'x'.repeat(30), enabled: true });
  }
  const hidden = records.memory.add({ text: '这条关闭的记忆绝不能发送', enabled: false });
  const memories = records.memory.list();
  const { payload } = ai.buildAskPayload({ mode: 'organize', messages: [USER_MESSAGE], memories });
  const capItems = payload.memories ? payload.memories.length : 0;
  const capChars = payload.memories ? payload.memories.reduce((sum, item) => sum + item.length, 0) : 0;
  record(
    'memories: 关闭的记忆不发送；≤20 条且合计 ≤1K 字符',
    capItems <= ai.MAX_MEMORY_ITEMS &&
      capItems > 0 &&
      capChars <= ai.MAX_MEMORY_CHARS &&
      !JSON.stringify(payload).includes('这条关闭的记忆绝不能发送') &&
      payload.memories.every((item) => !item.includes('13800138000')) &&
      hidden.id !== undefined,
    { injected_items: capItems, injected_chars: capChars, caps: [ai.MAX_MEMORY_ITEMS, ai.MAX_MEMORY_CHARS] }
  );
}

// 5) recordExcerpts: multi-select + deterministic <=2K cap.
resetStore();
{
  const five = [];
  for (let i = 0; i < 5; i += 1) five.push(`摘录${i}:` + 'z'.repeat(600));
  const first = ai.buildAskPayload({ mode: 'consult', messages: [USER_MESSAGE], excerpts: five });
  const second = ai.buildAskPayload({ mode: 'consult', messages: [USER_MESSAGE], excerpts: five });
  const total = first.payload.recordExcerpts.reduce((sum, item) => sum + item.length, 0);
  record(
    'recordExcerpts: 多选 + 确定性截断 ≤2K 字符',
    total <= ai.MAX_RECORD_EXCERPTS_CHARS &&
      total > 0 &&
      first.payload.recordExcerpts.length < five.length &&
      ai.serializeAskPayload(first.payload) === ai.serializeAskPayload(second.payload),
    { injected_chars: total, injected_items: first.payload.recordExcerpts.length, cap: ai.MAX_RECORD_EXCERPTS_CHARS }
  );
}

// 6) excerpt candidates: default recent N (sorted updatedAt desc).
{
  const symptoms = [
    { id: 'sym_2', updatedAt: '2026-09-02T00:00:00.000Z', text: '喉咙痛', occurredAt: '2026-09-02', duration: '1 天', impact: '', tags: [], attachment: null },
    { id: 'sym_1', updatedAt: '2026-09-01T00:00:00.000Z', text: '咳嗽', occurredAt: '2026-09-01', duration: '3 天', impact: '影响睡眠', tags: [], attachment: null },
  ];
  const notes = [
    { id: 'note_1', updatedAt: '2026-09-03T00:00:00.000Z', name: '体检报告', excerpt: '肺功能正常', sourceDate: '2026-08-20', remark: '', attachment: null },
  ];
  const questions = [
    { id: 'ques_1', updatedAt: '2026-09-04T00:00:00.000Z', text: '需要拍胸片吗？', done: false, group: '' },
  ];
  const candidates = ai.buildExcerptCandidates({ symptoms, notes, questions });
  const recent = ai.defaultRecentExcerpts(candidates);
  const sorted = candidates.every(
    (entry, index) => index === 0 || candidates[index - 1].updatedAt >= entry.updatedAt
  );
  record(
    'excerpts: 候选按 updatedAt 降序，默认近期 N 条（N=' + ai.DEFAULT_RECENT_RECORDS + '）',
    sorted &&
      recent.length === Math.min(ai.DEFAULT_RECENT_RECORDS, candidates.length) &&
      recent[0].id === 'ques_1' &&
      candidates.every((entry) => entry.excerpt.length > 0),
    { candidates: candidates.map((entry) => `${entry.kind}:${entry.id}`), recent: recent.map((entry) => entry.id) }
  );
}

// 7) aiEnabled=false -> {skipped:true} + zero requests.
resetStore();
resetRequests();
{
  const res = await ai.sendAsk(baseAskInput(), { prefs: { aiEnabled: false }, consent: true });
  record(
    'aiEnabled=false: {skipped:true, reason:ai_disabled}，零 wx.request',
    res.skipped === true && res.reason === 'ai_disabled' && wx._requests.length === 0,
    { result: res, requests: wx._requests.length }
  );
}

// 8) consent not given -> {skipped:true} + zero requests.
resetStore();
resetRequests();
{
  const res = await ai.sendAsk(baseAskInput(), { prefs: { aiEnabled: true } });
  record(
    'consent 未给: {skipped:true, reason:consent_required}，零 wx.request',
    res.skipped === true && res.reason === 'consent_required' && wx._requests.length === 0,
    { result: res, requests: wx._requests.length }
  );
}

// 9) proxy unreachable -> structured degraded, no fake content, no throw.
resetStore();
resetRequests();
wx._requestMode = 'unreachable';
{
  let threw = false;
  let res = null;
  try {
    res = await ai.sendAsk(baseAskInput(), { prefs: { aiEnabled: true }, consent: true });
  } catch (e) {
    threw = true;
  }
  record(
    'proxy unreachable: {ok:false, degraded:true, error:proxy_unreachable}，不抛、无 data',
    threw === false &&
      res !== null &&
      res.ok === false &&
      res.degraded === true &&
      res.error === 'proxy_unreachable' &&
      !('data' in res) &&
      wx._requests.length === 1,
    { threw, result: res, requests: wx._requests.length }
  );
}

// 10) proxy timeout -> proxy_timeout.
resetStore();
resetRequests();
wx._requestMode = 'timeout';
{
  const res = await ai.sendAsk(baseAskInput(), { prefs: { aiEnabled: true }, consent: true });
  record(
    'proxy timeout: {ok:false, degraded:true, error:proxy_timeout}',
    res.ok === false && res.degraded === true && res.error === 'proxy_timeout',
    { result: res }
  );
}

// 11) upstream 500 -> proxy_error with status.
resetStore();
resetRequests();
wx._requestMode = 'http-500';
{
  const res = await ai.sendAsk(baseAskInput(), { prefs: { aiEnabled: true }, consent: true });
  record(
    'proxy 500: {ok:false, degraded:true, error:proxy_error, status:500}',
    res.ok === false && res.error === 'proxy_error' && res.status === 500,
    { result: res }
  );
}

// 12) non-JSON 2xx body -> invalid_response.
resetStore();
resetRequests();
wx._requestMode = 'bad-json';
{
  const res = await ai.sendAsk(baseAskInput(), { prefs: { aiEnabled: true }, consent: true });
  record(
    '代理返回非法 JSON: {ok:false, degraded:true, error:invalid_response}',
    res.ok === false && res.error === 'invalid_response' && res.status === 200,
    { result: res }
  );
}

// 13) host allowlist: local accepted; non-local rejected with structured error + zero calls.
resetStore();
resetRequests();
{
  let localOk = true;
  let throwCode = '';
  try {
    ai.assertProxyUrl('http://localhost:8787');
  } catch (e) {
    localOk = false;
  }
  try {
    ai.assertProxyUrl('http://evil.example.com:8787');
  } catch (e) {
    throwCode = e && e.code ? String(e.code) : '';
  }
  const res = await ai.sendAsk(baseAskInput(), {
    prefs: { aiEnabled: true },
    consent: true,
    baseUrl: 'http://evil.example.com:8787',
  });
  record(
    'host 白名单: 允许 localhost；非本机地址被拒（blocked_host）且零 wx.request',
    localOk &&
      throwCode === 'blocked_host' &&
      ai.proxyHostOf(ai.DEFAULT_PROXY_URL) === '127.0.0.1' &&
      res.ok === false &&
      res.error === 'blocked_host' &&
      wx._requests.length === 0,
    { local_allowed: localOk, thrown_code: throwCode, result: res, requests: wx._requests.length }
  );
}

// 14) extract-memory: last round only, redacted, <=2K, consent:true, items<=3, notice present.
resetStore();
{
  const { payload, preview } = ai.buildExtractMemoryPayload({
    messages: [
      { role: 'assistant', content: '上一轮内容不应出现' },
      { role: 'user', content: `我更喜欢简短回复，我是张伟，电话 ${PHONE_B}` },
      { role: 'assistant', content: '明白了。' },
    ],
    profile: PROFILE,
    maxItems: 10,
  });
  const serialized = ai.serializeExtractPayload(payload);
  const chars = payload.messages.reduce((sum, message) => sum + message.content.length, 0);
  record(
    'extract-memory: 仅最近一轮、脱敏、≤2K、consent:true、maxItems≤3、含提炼说明',
    payload.consent === true &&
      payload.maxItems === ai.MAX_EXTRACT_ITEMS &&
      chars <= ai.MAX_EXTRACT_CHARS &&
      !serialized.includes(PROFILE.name) &&
      !serialized.includes(PHONE_B) &&
      !serialized.includes('上一轮内容不应出现') &&
      preview.notice === EXACT_NOTICE &&
      texts.MEMORY.autoExtractNotice === EXACT_NOTICE &&
      texts.CONSENT.autoExtract === EXACT_NOTICE,
    { messages: payload.messages.length, chars, maxItems: payload.maxItems, notice: preview.notice }
  );
}

// 15) happy send: bytes actually sent === preview reassembly === payload; no PII in body.
resetStore();
resetRequests();
{
  const input = baseAskInput();
  const fresh = ai.buildAskPayload(input);
  const res = await ai.sendAsk(input, { prefs: { aiEnabled: true }, consent: true });
  const sent = wx._requests.length > 0 ? wx._requests[0].data : '';
  const fromPayload = ai.serializeAskPayload(fresh.payload);
  const fromPreview = ai.serializeAskPayload(ai.reassembleAskPayload(fresh.preview));
  const leaked = [PROFILE.name, PHONE_A, PHONE_B, ID_CARD].filter((token) => sent.includes(token));
  record(
    'happy send: 发送字节 = 预览还原 = payload，且不含姓名/手机号；url 为本机代理',
    res.ok === true &&
      sent === fromPayload &&
      sent === fromPreview &&
      leaked.length === 0 &&
      wx._requests[0].url === `${ai.DEFAULT_PROXY_URL}${ai.ASK_PATH}` &&
      wx._requests[0].method === 'POST',
    {
      status: res.status,
      url: wx._requests[0] ? wx._requests[0].url : null,
      leaked_tokens: leaked,
      sent_body: sent,
    }
  );
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const summary = {
  total: cases.length,
  passed: cases.filter((entry) => entry.pass).length,
  failed: cases.filter((entry) => !entry.pass).length,
  typecheck_exit: typecheck.exit,
};

const artifact = {
  command: 'npx tsx scripts/check-aiclient.mjs',
  timestamp: new Date().toISOString(),
  modules: ['hospital-ai-miniapp/shared/services/aiClient.ts', 'hospital-ai-miniapp/config/texts.ts'],
  mocks: [{ name: 'wx.request', modes: ['ok', 'unreachable', 'timeout', 'http-500', 'bad-json'] }],
  cases,
  typecheck,
  summary,
};

const outDir = resolve(root, 'artifacts/e2e');
mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, 'redaction.json'), `${JSON.stringify(artifact, null, 2)}\n`);

for (const entry of cases) {
  console.log(`${entry.pass ? 'PASS' : 'FAIL'} - ${entry.name}`);
}
console.log(`typecheck exit=${typecheck.exit}`);
console.log(`cases ${summary.passed}/${summary.total} passed, failed=${summary.failed}`);
console.log(`wrote ${resolve(outDir, 'redaction.json')}`);

const allPassed = summary.failed === 0 && typecheck.exit === 0;
process.exit(allPassed ? 0 : 1);
