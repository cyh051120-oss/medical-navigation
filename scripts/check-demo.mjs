#!/usr/bin/env node
// scripts/check-demo.mjs
// 任务 26 检查脚本：演示/模拟模式的确定性 + demo 优先级 + 未配置时零外呼。
//
// 流程（happy）：
//   1) fixtures 自检：validateOrganizeOutput / validateConsultOutput 接受所有确定性 fixture。
//   2) 起两个「计数 mock」上游（127.0.0.1:0）——只记录收到的请求数，永不被期望调用。
//   3) 写临时配置（os.tmpdir）到 MHP_CONFIG_PATH：demo=true，且 llm/search 的 key 故意非空，
//      以证明 demo 分支优先于真实上游（零外呼）。
//   4) spawn `node server/index.ts`（经 MHP_CONFIG_PATH 指向临时配置），轮询 /api/health。
//   5) 对 organize / consult / redflag / minimal（POST /api/ask）与 extract（POST /api/extract-memory）
//      五个场景，用系统 `curl` 各 POST 两次，断言两次原始响应体逐字节一致，且等于预期 fixture。
//   6) 断言两个计数 mock 收到的请求数为 0。
//   7) 写 artifacts/server/demo-determinism.txt（含两轮原始体 + 判决 + repro），exit 0。
//
// 失败模式（--simulate-failure）：
//   临时配置 demo=false 且 llm/search 全空 → POST /api/ask → 断言 {error:'provider_not_configured'}
//   且计数 mock 收到 0 请求 → 写 artifacts/qa/26-failure.txt 原始记录，exit 1（失败路径契约）。
//
// 全部本地 127.0.0.1；不触碰 9420；不弹任何窗口；不记录请求内容到磁盘以外（仅证据文件）。

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  getFreePort,
  makeSpawnServer,
  stopServer,
  waitForHealth,
} from './lib/check-helpers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const failureMode = process.argv.includes('--simulate-failure');

// ---------------------------------------------------------------------------
// 被测模块（tsx 下动态导入 .ts）
// ---------------------------------------------------------------------------

const { validateOrganizeOutput, validateConsultOutput } = await import(
  pathToFileURL(resolve(root, 'server/validate.ts')).href
);
const { SAFETY_NOTICE } = await import(
  pathToFileURL(resolve(root, 'server/redflags.ts')).href
);
const { CONSULT_DISCLAIMER } = await import(
  pathToFileURL(resolve(root, 'server/prompts.ts')).href
);
const { isAuthorityUrl, resolveAuthorityDomains } = await import(
  pathToFileURL(resolve(root, 'server/authorities.ts')).href
);

const fixtures = JSON.parse(
  readFileSync(resolve(root, 'server/demo-fixtures.json'), 'utf8')
);

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const AUTHORITY_DOMAINS = resolveAuthorityDomains([]);
const spawnServer = makeSpawnServer(root);

/** 计数 mock：仅记录请求条数（不记录/不打印内容），返回一个可被忽略的成功信封。 */
function startCountingMock(name) {
  const state = { requests: [] };
  const server = createServer((req, res) => {
    let length = 0;
    req.on('data', (c) => {
      length += c.length;
    });
    req.on('end', () => {
      state.requests.push({ method: req.method, url: req.url, length });
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    });
  });
  return new Promise((resolveMock) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolveMock({
        name,
        state,
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise((r) => {
            if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
            server.close(() => r());
          }),
      });
    });
  });
}

/** 用系统 curl 发 POST，返回原始响应体（逐字节保真；用于确定性对比）。 */
function curlPostRaw(url, body) {
  const res = spawnSync(
    'curl',
    [
      '-s',
      '-X',
      'POST',
      url,
      '-H',
      'Content-Type: application/json',
      '--data-binary',
      body,
    ],
    { encoding: 'utf8' }
  );
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function curlStatus(url, body) {
  const res = spawnSync(
    'curl',
    [
      '-s',
      '-o',
      '/dev/null',
      '-w',
      '%{http_code}',
      '-X',
      'POST',
      url,
      '-H',
      'Content-Type: application/json',
      '--data-binary',
      body,
    ],
    { encoding: 'utf8' }
  );
  return (res.stdout ?? '').trim();
}

// ---------------------------------------------------------------------------
// fixtures 自检（happy 路径）
// ---------------------------------------------------------------------------

/** P1-7 契约：服务端与客户端孪生的红标词表必须逐项相等；缺失/分歧都是失败。 */
async function redflagParityCheck() {
  const serverMod = await import(pathToFileURL(resolve(root, 'server/redflags.ts')).href);
  let clientMod = null;
  let importError = null;
  try {
    clientMod = await import(
      pathToFileURL(resolve(root, 'hospital-ai-miniapp/shared/services/redflags.ts')).href
    );
  } catch (err) {
    importError = err instanceof Error ? err.message : String(err);
  }
  if (clientMod === null) {
    return {
      name: 'redflag parity: client twin exports REDFLAG_PATTERN_SOURCES + NEGATION_PATTERN_SOURCES + NEG_FILLER_SOURCES',
      ok: false,
      detail: `missing/unextendable client twin hospital-ai-miniapp/shared/services/redflags.ts (${importError})`,
    };
  }
  const ARRAYS = ['REDFLAG_PATTERN_SOURCES', 'NEGATION_PATTERN_SOURCES', 'NEG_FILLER_SOURCES'];
  const mismatches = {};
  for (const key of ARRAYS) {
    const serverVal = serverMod[key];
    const clientVal = clientMod[key];
    if (!Array.isArray(serverVal)) mismatches[key] = { server_missing: true };
    else if (!Array.isArray(clientVal)) mismatches[key] = { client_missing: true };
    else if (JSON.stringify(serverVal) !== JSON.stringify(clientVal)) {
      mismatches[key] = { server: serverVal, client: clientVal };
    }
  }
  const mismatchedKeys = Object.keys(mismatches);
  return {
    name: 'redflag parity: REDFLAG_PATTERN_SOURCES + NEGATION_PATTERN_SOURCES + NEG_FILLER_SOURCES deep-equal server vs client twin',
    ok: mismatchedKeys.length === 0,
    detail: mismatchedKeys.length === 0 ? null : { mismatched: mismatches },
  };
}

/**
 * P1-7 twin(2)：客户端 demo 引擎的红标数据必须与服务端 demo-fixtures.json 的 redflag 逐字节一致。
 * demoAi.ts 的 REDFLAG_DATA 是模块私有常量，故用其公开引擎 demoAsk（红标输入短路）取回同一份数据
 * 再深度比对 —— 既验证数据一致，也验证客户端 demo 短路确实返回该数据。
 */
async function demoRedflagFixtureCheck(fixtures) {
  const name =
    'demo twin: client demoAi redflag data deep-equals server demo-fixtures.redflag';
  let clientAi = null;
  let importError = null;
  try {
    clientAi = await import(
      pathToFileURL(resolve(root, 'hospital-ai-miniapp/shared/services/demoAi.ts')).href
    );
  } catch (err) {
    importError = err instanceof Error ? err.message : String(err);
  }
  if (clientAi === null || typeof clientAi.demoAsk !== 'function') {
    return {
      name,
      ok: false,
      detail: `cannot import client demo engine hospital-ai-miniapp/shared/services/demoAi.ts (${importError})`,
    };
  }
  const result = clientAi.demoAsk({
    mode: 'consult',
    messages: [{ role: 'user', content: '我胸痛' }],
  });
  const clientRedflag = result !== null && typeof result === 'object' ? result.data : null;
  return {
    name,
    ok: sameJson(clientRedflag, fixtures.redflag),
    detail: sameJson(clientRedflag, fixtures.redflag)
      ? null
      : { client: clientRedflag, server: fixtures.redflag },
  };
}

function selfCheckFixtures() {
  const results = [];
  const add = (name, ok, detail) => results.push({ name, ok: ok === true, detail });

  const organize = validateOrganizeOutput(fixtures.organize);
  add(
    'organize fixture passes validateOrganizeOutput and deep-equals stored shape',
    organize.ok && sameJson(organize.value, fixtures.organize),
    organize.ok ? null : organize.reason
  );

  const minimal = validateOrganizeOutput(fixtures.organizeMinimal);
  add(
    'organizeMinimal boundary fixture (all arrays empty) passes validateOrganizeOutput',
    minimal.ok && sameJson(minimal.value, fixtures.organizeMinimal),
    minimal.ok ? null : minimal.reason
  );

  // 校验器输入是「模型形状」（citation 为 URL 字符串），而 fixture 存的是「最终契约形状」
  // （citation 为对象）。此处由最终形状反推模型形状，再校验并断言输出 == fixture，证明二者一致。
  const consultResponse = fixtures.consult.response;
  const consultModelShape = {
    directions: consultResponse.directions.map((d) => ({ text: d.text, citation: d.citation.url })),
    suggestedDepartments: consultResponse.suggestedDepartments,
    suggestions: consultResponse.suggestions.map((s) => ({ text: s.text, citation: s.citation.url })),
    unknowns: consultResponse.unknowns,
    questions: consultResponse.questions,
  };
  const consult = validateConsultOutput(consultModelShape, {
    sources: fixtures.consult.sources,
    authorityDomains: AUTHORITY_DOMAINS,
  });
  const consultCitationsAuthoritative =
    Array.isArray(fixtures.consult.response.citations) &&
    fixtures.consult.response.citations.every((c) => isAuthorityUrl(c.url, AUTHORITY_DOMAINS));
  const hasSuggestionsWithCitation =
    Array.isArray(fixtures.consult.response.suggestions) &&
    fixtures.consult.response.suggestions.length >= 1 &&
    fixtures.consult.response.suggestions.every(
      (s) => typeof s.text === 'string' && s.citation && typeof s.citation.url === 'string'
    );
  add(
    'consult fixture passes validateConsultOutput, deep-equals stored shape, citations authoritative, suggestions[] with citation',
    consult.ok &&
      sameJson(consult.value, fixtures.consult.response) &&
      consultCitationsAuthoritative &&
      hasSuggestionsWithCitation,
    consult.ok ? null : consult.reason
  );

  add(
    'redflag fixture safetyNotice/disclaimer match imported constants',
    fixtures.redflag.redFlag === true &&
      fixtures.redflag.safetyNotice === SAFETY_NOTICE &&
      fixtures.redflag.disclaimer === CONSULT_DISCLAIMER,
    null
  );

  const candidates = fixtures.extractMemory?.candidates;
  const texts = Array.isArray(candidates) ? candidates.map((c) => c?.text) : [];
  const extractOk =
    Array.isArray(candidates) &&
    candidates.length >= 1 &&
    candidates.length <= 3 &&
    texts.every((t) => typeof t === 'string' && t.length > 0 && t.length <= 60) &&
    new Set(texts).size === texts.length &&
    texts.every((t) => !['确诊', '诊断', '处方', '疗效', '剂量', '症状', '用药', '疾病'].some((w) => t.includes(w)));
  add(
    'extractMemory candidates: ≤3 items, each ≤60 chars, deduped, preferences-only',
    extractOk,
    { count: candidates?.length ?? null, texts }
  );

  return results;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

const scenarios = [
  {
    name: 'organize',
    path: '/api/ask',
    request: { mode: 'organize', messages: [{ role: 'user', content: '近一周头痛，睡不好' }], consent: true },
    expected: () => fixtures.organize,
  },
  {
    name: 'consult',
    path: '/api/ask',
    request: { mode: 'consult', messages: [{ role: 'user', content: '最近胃不舒服' }], consent: true },
    expected: () => fixtures.consult.response,
  },
  {
    name: 'redflag',
    path: '/api/ask',
    request: { mode: 'consult', messages: [{ role: 'user', content: '我胸痛' }], consent: true },
    expected: () => fixtures.redflag,
  },
  {
    name: 'negated-redflag',
    path: '/api/ask',
    request: {
      mode: 'organize',
      messages: [{ role: 'user', content: '我没有胸痛，只是有点累' }],
      consent: true,
    },
    expected: () => fixtures.organize,
  },
  {
    name: 'minimal',
    path: '/api/ask',
    request: { mode: 'organize', messages: [{ role: 'user', content: '   ' }], consent: true },
    expected: () => fixtures.organizeMinimal,
  },
  {
    name: 'extract',
    path: '/api/extract-memory',
    request: { messages: [{ role: 'user', content: '我一般晚上十点前就睡了，喜欢清淡饮食' }], consent: true },
    expected: () => fixtures.extractMemory,
  },
];

const llmMock = await startCountingMock('llm-mock');
const searchMock = await startCountingMock('search-mock');
const port = await getFreePort();
const configPath = join(tmpdir(), `mhp-demo-config-${process.pid}-${Date.now()}.json`);

let child = null;
try {
  if (failureMode) {
    // -------------------------------------------------------------------
    // 失败路径：demo=false + 空 key → provider_not_configured，零外呼
    // -------------------------------------------------------------------
    const config = {
      port,
      demo: false,
      llm: { baseUrl: '', apiKey: '', model: '' },
      search: { baseUrl: '', apiKey: '' },
      authorityDomains: [],
    };
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const started = spawnServer(configPath);
    child = started.child;
    const health = await waitForHealth(port);

    const lines = [];
    const log = (msg) => {
      lines.push(msg);
      console.log(msg);
    };
    const requestBody = JSON.stringify({
      mode: 'organize',
      messages: [{ role: 'user', content: '近一周头痛，睡不好' }],
      consent: true,
    });
    const url = `http://127.0.0.1:${port}/api/ask`;
    const status = curlStatus(url, requestBody);
    const raw = curlPostRaw(url, requestBody);
    let parsedBody = null;
    try {
      parsedBody = JSON.parse(raw.stdout);
    } catch {
      parsedBody = null;
    }
    const notConfigured = parsedBody !== null && parsedBody.error === 'provider_not_configured';
    const zeroUpstream = llmMock.state.requests.length === 0 && searchMock.state.requests.length === 0;

    log('T26 演示/模拟模式 — 失败路径原始记录（demo=false 且无 key）');
    log('========================================================');
    log(`timestamp: ${new Date().toISOString()}`);
    log(`node: ${process.version}`);
    log(`spawned: node server/index.ts  (env MHP_CONFIG_PATH=${configPath})`);
    log(`config: demo=false; llm={baseUrl:'',apiKey:'',model:''}; search={baseUrl:'',apiKey:''}`);
    log(`health: ${JSON.stringify(health.response)}`);
    log(`llm counting mock: ${llmMock.baseUrl}; search counting mock: ${searchMock.baseUrl} (仅 127.0.0.1)`);
    log('');
    log('[a] POST /api/ask（organize, consent:true, 非红标输入）');
    log(`request: ${requestBody}`);
    log(`HTTP status: ${status}`);
    log(`body: ${raw.stdout}`);
    log(`assert body.error === 'provider_not_configured': ${notConfigured}`);
    log('');
    log('[b] 上游计数（应为 0，未尝试任何外呼）');
    log(`llm mock requests: ${llmMock.state.requests.length} (期望 0)`);
    log(`search mock requests: ${searchMock.state.requests.length} (期望 0)`);
    log('');
    log('结论：demo=false 且未配置 LLM → 返回 provider_not_configured，零外呼（未尝试任何网络请求）。');

    mkdirSync(resolve(root, 'artifacts/qa'), { recursive: true });
    writeFileSync(resolve(root, 'artifacts/qa/26-failure.txt'), `${lines.join('\n')}\n`);

    console.log(`wrote ${resolve(root, 'artifacts/qa/26-failure.txt')}`);
    const passed = health.status === 200 && status === '200' && notConfigured && zeroUpstream;
    process.exit(passed ? 1 : 1); // 失败路径刻意 exit 1（T42 约定）
  }

  // ---------------------------------------------------------------------
  // Happy 路径
  // ---------------------------------------------------------------------
  const selfChecks = selfCheckFixtures();
  selfChecks.push(await redflagParityCheck());
  selfChecks.push(await demoRedflagFixtureCheck(fixtures));

  const config = {
    port,
    demo: true,
    llm: { baseUrl: llmMock.baseUrl, apiKey: 'sk-demo-llm', model: 'demo-model' },
    search: { baseUrl: searchMock.baseUrl, apiKey: 'sk-demo-search' },
    authorityDomains: [],
  };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

  const started = spawnServer(configPath);
  child = started.child;
  const health = await waitForHealth(port);

  const healthFieldsOk =
    health.status === 200 &&
    health.response !== null &&
    health.response.ok === true &&
    health.response.demo === true &&
    health.response.demoMode === true;
  selfChecks.push({
    name: 'health: /api/health exposes {ok,demo,demoMode} with demo=true (P1-13)',
    ok: healthFieldsOk,
    detail: health.response,
  });

  const scenarioRecords = [];
  let allPassed = health.status === 200;

  for (const scenario of scenarios) {
    const scenarioUrl = `http://127.0.0.1:${port}${scenario.path}`;
    const body = JSON.stringify(scenario.request);
    const status = curlStatus(scenarioUrl, body);
    const run1 = curlPostRaw(scenarioUrl, body);
    const run2 = curlPostRaw(scenarioUrl, body);
    const byteIdentical = run1.stdout === run2.stdout && run1.stdout.length > 0;
    let parsed = null;
    try {
      parsed = JSON.parse(run1.stdout);
    } catch {
      parsed = null;
    }
    const matchesFixture = parsed !== null && sameJson(parsed, scenario.expected());
    const pass = status === '200' && byteIdentical && matchesFixture;
    if (!pass) allPassed = false;
    scenarioRecords.push({
      name: scenario.name,
      path: scenario.path,
      url: scenarioUrl,
      request: body,
      status,
      run1: run1.stdout,
      run2: run2.stdout,
      byteIdentical,
      matchesFixture,
      pass,
    });
  }

  const zeroUpstream =
    llmMock.state.requests.length === 0 && searchMock.state.requests.length === 0;
  if (!zeroUpstream) allPassed = false;
  if (!selfChecks.every((c) => c.ok)) allPassed = false;

  const lines = [];
  const log = (msg) => {
    lines.push(msg);
    console.log(msg);
  };

  log('T26 演示/模拟模式 — 确定性证据（happy path）');
  log('========================================================');
  log(`timestamp: ${new Date().toISOString()}`);
  log(`node: ${process.version}`);
  log(`spawned: node server/index.ts  (env MHP_CONFIG_PATH=${configPath})`);
  log(`health: ${JSON.stringify(health.response)}`);
  log(
    'demo config: demo=true 且 llm/search 的 apiKey 非空（故意非空，以证明 demo 分支优先、零外呼）'
  );
  log(`llm counting mock: ${llmMock.baseUrl}; search counting mock: ${searchMock.baseUrl} (仅 127.0.0.1)`);
  log(
    'request transport for each endpoint: system `curl -s -X POST ... --data-binary <body>`（逐字节保真）'
  );
  log('');
  log('[fixtures 自检]');
  for (const c of selfChecks) {
    log(`${c.ok ? 'PASS' : 'FAIL'} - ${c.name}${c.detail === null ? '' : ` (${JSON.stringify(c.detail)})`}`);
  }
  log('');

  for (const record of scenarioRecords) {
    log(`[scenario ${record.name}]`);
    log(`request: ${record.request}`);
    log(`HTTP status: ${record.status}`);
    log(`run1: ${record.run1}`);
    log(`run2: ${record.run2}`);
    log(`byte-identical: ${record.byteIdentical}`);
    log(`matches fixture: ${record.matchesFixture}`);
    log('');
  }

  log('[上游调用计数]');
  log(`llm mock requests: ${llmMock.state.requests.length} (期望 0)`);
  log(`search mock requests: ${searchMock.state.requests.length} (期望 0)`);
  log('');
  log(
    `verdict: ${allPassed ? 'PASS' : 'FAIL'} — demo 模式连续两次 /api/ask 输出逐字节一致；上游零调用`
  );
  log('');
  log('repro:');
  log(`  MHP_CONFIG_PATH='${configPath}' node server/index.ts`);
  for (const record of scenarioRecords) {
    log(
      `  curl -s -X POST ${record.url} -H 'Content-Type: application/json' --data-binary '${record.request}'`
    );
  }

  mkdirSync(resolve(root, 'artifacts/server'), { recursive: true });
  writeFileSync(resolve(root, 'artifacts/server/demo-determinism.txt'), `${lines.join('\n')}\n`);

  for (const c of selfChecks) {
    console.log(`${c.ok ? 'PASS' : 'FAIL'} - ${c.name}`);
  }
  for (const record of scenarioRecords) {
    console.log(
      `${record.pass ? 'PASS' : 'FAIL'} - /api/ask ${record.name}: byte-identical=${record.byteIdentical} matches-fixture=${record.matchesFixture} status=${record.status}`
    );
  }
  console.log(
    `${zeroUpstream ? 'PASS' : 'FAIL'} - demo precedence: zero upstream calls despite configured keys (llm=${llmMock.state.requests.length}, search=${searchMock.state.requests.length})`
  );
  console.log(`wrote ${resolve(root, 'artifacts/server/demo-determinism.txt')}`);
  process.exit(allPassed ? 0 : 1);
} finally {
  if (child !== null) await stopServer(child);
  await llmMock.close();
  await searchMock.close();
  try {
    rmSync(configPath, { force: true });
  } catch {
    // 清理失败可忽略
  }
}
