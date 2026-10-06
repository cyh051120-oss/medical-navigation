#!/usr/bin/env node
// scripts/check-matrix.mjs
// T27 服务端检查矩阵 —— 聚合器（test:server 链的最后一环）。
//
// 职责（不重复已存在的用例，只做「清点 + 映射 + 聚合」）：
//   1) 读取链中已生成的证据文件：
//        artifacts/server/health.json            （check-server：health + tsc 门禁）
//        artifacts/checks/server-llm.json        （check-llm：13 例）
//        artifacts/checks/server-search.json     （check-search：24 例）
//        artifacts/checks/server-ask.json        （check-ask：30 例）
//        artifacts/checks/server-extract.json    （check-extract：27 例，含 6 条路由）
//        artifacts/server/demo-determinism.txt   （check-demo：demo 确定性）
//        artifacts/e2e/redaction.json            （check-aiclient：客户端脱敏，独立于本链）
//   2) 断言每个来源：存在、零失败、时间戳新鲜（本次链运行内产生；redaction 例外，见下）。
//   3) 把验收项 ①–⑪ 映射到具体用例（按用例名子串匹配 + 该用例 pass=true），任一缺失/失败即 matrix 失败。
//   4) 写 artifacts/checks/server-all.json，exit 0/1。
//
// 模式：
//   (default)           聚合 → artifacts/checks/server-all.json，exit 0（全绿）。
//   --simulate-failure  真实降级运行（LLM 不可达 / LLM 500 / 搜索不可达 / extract 上游 500），
//                       断言「降级而非崩溃」并写 artifacts/qa/27-failure.txt，刻意 exit 1。
//
// 新鲜度：链内脚本在本文件之前运行，故要求其时间戳距今 ≤ MAX_AGE_MS（15 分钟）。
//   redaction.json 由独立运行的 check-aiclient.mjs 生成、不在本链内，故只做「存在 + 零失败」，
//   不做新鲜度断言（freshness:false）。
//
// 设计：本文件不新增/复制任何服务端用例，只引用既有 harness 的 artifact（用例名子串即契约）。
// 零运行时依赖：仅 Node 内置模块（node:http / node:fs / node:path / node:url）。
// 约束：仅 127.0.0.1；绝不启动 devtools/E2E；mock 端口由 OS 分配（listen 0）。

import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const failureMode = process.argv.includes('--simulate-failure');

/** 链内来源时间戳的最大年龄（毫秒）。 */
const MAX_AGE_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------------------
// 证据来源（链内顺序由 package.json 的 test:server 决定）
// ---------------------------------------------------------------------------

const SOURCES = [
  {
    id: 'health',
    path: 'artifacts/server/health.json',
    kind: 'json',
    role: 'check-server：/api/health + 服务端 tsc + 全量 typecheck',
  },
  {
    id: 'llm',
    path: 'artifacts/checks/server-llm.json',
    kind: 'json',
    role: 'check-llm：LLM 适配器请求/解析/错误（13 例）',
  },
  {
    id: 'search',
    path: 'artifacts/checks/server-search.json',
    kind: 'json',
    role: 'check-search：搜索归一化 + 权威域名白名单（24 例）',
  },
  {
    id: 'ask',
    path: 'artifacts/checks/server-ask.json',
    kind: 'json',
    role: 'check-ask：双模式编排器 + 护栏 + 上下文/记忆上限（30 例）',
  },
  {
    id: 'extract',
    path: 'artifacts/checks/server-extract.json',
    kind: 'json',
    role: 'check-extract：记忆提炼契约 + 6 条路由回归（27 例）',
  },
  {
    id: 'demo',
    path: 'artifacts/server/demo-determinism.txt',
    kind: 'text',
    role: 'check-demo：demo 模式逐字节确定性、零外呼',
  },
  {
    id: 'redaction',
    path: 'artifacts/e2e/redaction.json',
    kind: 'json',
    role: 'check-aiclient：客户端脱敏（独立于本链运行，不计新鲜度）',
    freshness: false,
  },
];

// ---------------------------------------------------------------------------
// 验收项 ①–⑪ → 证据（来源 id + 既有用例名子串）
// ---------------------------------------------------------------------------

const COVERAGE = [
  {
    id: '①',
    label: 'LLM 请求/解析/错误',
    evidence: [
      ['llm', 'non-stream: POST {baseUrl}/chat/completions'],
      ['llm', 'non-stream: content / model / finish_reason parsed'],
      ['llm', 'retry: 5xx is retried exactly once'],
      ['llm', 'error: persistent 500'],
      ['llm', 'error: 4xx'],
      ['llm', 'error: empty baseUrl'],
    ],
  },
  {
    id: '②',
    label: '搜索归一化/白名单过滤',
    evidence: [
      ['search', 'request: POST {baseUrl}/search'],
      ['search', 'authority: exact host nhc.gov.cn'],
      ['search', 'authority: subdomain www.chinacdc.cn'],
      ['search', 'authority: spoof hosts evil-nhc.gov.cn'],
      ['search', 'filter: mixed authority + non-authority'],
      ['search', 'normalize: unparseable-url item dropped'],
    ],
  },
  {
    id: '③',
    label: '双模式输出结构',
    evidence: [
      ['ask', 'organize happy: {points,extracted,unknowns,questions}'],
      ['ask', 'consult happy: directions<=20 with citations'],
    ],
  },
  {
    id: '④',
    label: '边界输入（红标 per-sample / 挂哪个科 / 找哪个医生）',
    evidence: [
      [
        'ask',
        'redflag: all 8 plan terms fire with fixed notice, no department/direction, zero upstream (per-sample)',
      ],
      ['ask', 'redflag consult: fixed notice'],
      ['ask', 'redflag organize: fixed notice'],
      ['ask', 'consult happy: directions<=20 with citations'],
      ['ask', 'consult: model recommends a doctor'],
    ],
  },
  {
    id: '⑤',
    label: '脱敏（上行 payload 无姓名/手机号/证件号）',
    evidence: [
      ['redaction', 'payload: 去掉姓名/手机号/证件号'],
      ['redaction', 'preview: 逐段还原后与 payload 逐字节相等'],
      ['redaction', 'happy send: 发送字节 = 预览还原 = payload'],
    ],
  },
  {
    id: '⑥',
    label: '超时/上游失败降级（不崩溃）',
    evidence: [
      ['llm', 'error: timeout'],
      ['search', 'error: timeout'],
      ['search', 'error: HTTP 500'],
      ['ask', 'LLM persistent 500'],
      ['extract', 'upstream 500'],
      ['extract', 'upstream timeout'],
    ],
  },
  {
    id: '⑦',
    label: '上下文截断规则（>20 轮 / >8K 字符）',
    evidence: [
      ['ask', 'context: 25 incoming messages'],
      ['ask', 'context: huge content'],
    ],
  },
  {
    id: '⑧',
    label: 'suggestions 契约（带引用；剂量/疗效词拦截）',
    evidence: [
      ['ask', 'consult happy: directions<=20 with citations'],
      ['ask', 'consult: suggestion with「剂量」'],
      ['ask', 'consult: suggestion with「服用」'],
    ],
  },
  {
    id: '⑨',
    label: '脱敏扩展（档案摘要/记录摘录不含标识）',
    evidence: [
      ['redaction', 'payload: 去掉姓名/手机号/证件号（含自由文本内）'],
      ['redaction', 'recordExcerpts: 多选 + 确定性截断'],
      ['redaction', 'extract-memory: 仅最近一轮、脱敏'],
    ],
  },
  {
    id: '⑩',
    label: '记忆注入（≤20 条/≤1K；预览=发送；仅偏好非医学断言）',
    evidence: [
      ['ask', 'memories: >20 items'],
      ['ask', 'memories: >1K chars'],
      ['ask', 'memories are not medical facts'],
      ['redaction', 'memories: 关闭的记忆不发送'],
      ['redaction', 'preview: 四段（档案摘要/记录摘录/记忆/对话）标题齐全'],
    ],
  },
  {
    id: '⑪',
    label: '/api/extract-memory 契约与反例',
    evidence: [
      ['extract', 'happy: structured {candidates'],
      ['extract', 'count cap: 5 valid candidates'],
      ['extract', 'length cap: 61-char item dropped'],
      ['extract', 'banned medical terms dropped'],
      ['extract', 'dedupe: duplicate texts removed'],
      ['extract', 'route: oversized body to /api/extract-memory'],
      ['extract', 'route: GET /api/extract-memory'],
      ['extract', 'route: malformed JSON'],
    ],
  },
];

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function parseTextTimestamp(text) {
  const match = /^timestamp:\s*(\S+)/m.exec(text);
  return match === null ? null : match[1];
}

function ageOf(timestamp) {
  if (typeof timestamp !== 'string') return null;
  const ms = Date.parse(timestamp);
  return Number.isFinite(ms) ? Date.now() - ms : null;
}

// ---------------------------------------------------------------------------
// 失败模式（--simulate-failure）：真实降级运行 —— 降级而非崩溃。
// ---------------------------------------------------------------------------

async function runFailureMode() {
  const { ask } = await import(pathToFileURL(resolve(root, 'server/orchestrator.ts')).href);
  const { extractMemory } = await import(
    pathToFileURL(resolve(root, 'server/extract-memory.ts')).href
  );
  const { CONSULT_DISCLAIMER } = await import(
    pathToFileURL(resolve(root, 'server/prompts.ts')).href
  );

  const lines = [];
  const log = (...parts) => {
    const msg = parts.join(' ');
    lines.push(msg);
    console.log(msg);
  };

  // --- 本机 mock + 空闲端口工具（绝不触网、绝不碰 devtools/9420） ---
  function readJsonBody(req, onBody) {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let parsed = null;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        parsed = null;
      }
      onBody(parsed);
    });
  }

  const listen = (server, state) =>
    new Promise((resolveP) => {
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        resolveP({
          state,
          baseUrl: `http://127.0.0.1:${port}`,
          close: () =>
            new Promise((r) => {
              if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
              server.close(() => r());
            }),
        });
      });
    });

  function startLlmMock() {
    const state = { mode: 'ok', content: '{}', requests: [] };
    const server = createServer((req, res) => {
      readJsonBody(req, (parsed) => {
        state.requests.push({ method: req.method, url: req.url, body: parsed });
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
        json(200, {
          id: 'chatcmpl-mock',
          object: 'chat.completion',
          model: 'mock-model',
          choices: [
            { index: 0, message: { role: 'assistant', content: state.content }, finish_reason: 'stop' },
          ],
        });
      });
    });
    return listen(server, state);
  }

  function startSearchMock() {
    const state = { requests: [] };
    const server = createServer((req, res) => {
      readJsonBody(req, (parsed) => {
        state.requests.push({ method: req.method, url: req.url, body: parsed });
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ results: [] }));
      });
    });
    return listen(server, state);
  }

  /** 取一个当前空闲、随后关闭的端口 → 连接必然 ECONNREFUSED（离线/不可达）。 */
  function getUnreachableBaseUrl() {
    return new Promise((resolveP) => {
      const probe = createServer();
      probe.on('error', () => resolveP('http://127.0.0.1:1'));
      probe.listen(0, '127.0.0.1', () => {
        const port = probe.address().port;
        probe.close(() => resolveP(`http://127.0.0.1:${port}`));
      });
    });
  }

  const llm = await startLlmMock();
  const search = await startSearchMock();

  const makeConfig = (overrides = {}) => ({
    port: 0,
    demo: false,
    llm: { baseUrl: llm.baseUrl, apiKey: 'sk-llm', model: 'mock-model', ...(overrides.llm ?? {}) },
    search: { baseUrl: search.baseUrl, apiKey: 'sk-search', ...(overrides.search ?? {}) },
    authorityDomains: overrides.authorityDomains ?? [],
  });
  const resetMocks = () => {
    llm.state.mode = 'ok';
    llm.state.content = '{}';
    llm.state.requests.length = 0;
    search.state.requests.length = 0;
  };
  const request = (overrides = {}) => ({
    mode: 'organize',
    messages: [{ role: 'user', content: '你好' }],
    consent: true,
    ...overrides,
  });

  log('T27 服务端检查矩阵 — 失败路径原始记录（降级而非崩溃）');
  log('========================================================');
  log(`timestamp: ${new Date().toISOString()}`);
  log(`node: ${process.version}`);
  log(`llm mock: ${llm.baseUrl}; search mock: ${search.baseUrl} (仅 127.0.0.1)`);
  log('');

  // [a] LLM 不可达（baseUrl 指向已关闭端口）→ 结构化 upstream_error，不抛异常，零 mock 请求。
  log('[a] LLM 不可达（连接被拒）→ 结构化 {error:upstream_error}，不抛异常');
  resetMocks();
  {
    const unreachable = await getUnreachableBaseUrl();
    const threw = await ask(request({ mode: 'organize' }), {
      config: makeConfig({ llm: { baseUrl: unreachable } }),
    }).then(
      (r) => ({ r, threw: false }),
      () => ({ r: null, threw: true })
    );
    log(`unreachable baseUrl = ${unreachable}`);
    log(`returned: ${JSON.stringify(threw.r)}`);
    log(`threw = ${threw.threw} (期望 false)`);
    log(`llm mock 请求数 = ${llm.state.requests.length} (期望 0，指向不可达地址而非 mock)`);
    log(
      `断言 error === 'upstream_error' 且未抛异常: ${
        threw.threw === false && threw.r !== null && threw.r.error === 'upstream_error'
      }`
    );
  }
  log('');

  // [b] LLM 持续 500 → 结构化 upstream_error，首次 + 1 次重试（共 2 次尝试），不抛异常。
  log('[b] LLM 上游持续 500 → 结构化 {error:upstream_error}，最多重试 1 次，不抛异常');
  resetMocks();
  llm.state.mode = 'always-500';
  {
    const threw = await ask(request({ mode: 'organize' }), { config: makeConfig() }).then(
      (r) => ({ r, threw: false }),
      () => ({ r: null, threw: true })
    );
    log(`returned: ${JSON.stringify(threw.r)}`);
    log(`threw = ${threw.threw} (期望 false)`);
    log(`llm 请求数 = ${llm.state.requests.length} (期望 2 = 首次 + 1 次重试)`);
    log(
      `断言 error === 'upstream_error' 且请求数 === 2: ${
        threw.threw === false &&
        threw.r !== null &&
        threw.r.error === 'upstream_error' &&
        llm.state.requests.length === 2
      }`
    );
  }
  log('');

  // [c] 搜索不可达（consult）→ 不抛、不编造引用，仍返回合法 consult 结构 + disclaimer。
  log('[c] 搜索不可达（consult）→ 不抛异常、零编造引用、仍返回合法 consult 结构');
  resetMocks();
  llm.state.content = JSON.stringify({
    directions: [],
    suggestedDepartments: [],
    suggestions: [],
    unknowns: ['缺少来源'],
    questions: [],
  });
  {
    const unreachable = await getUnreachableBaseUrl();
    const threw = await ask(
      request({ mode: 'consult', messages: [{ role: 'user', content: '最近胃不舒服' }] }),
      { config: makeConfig({ search: { baseUrl: unreachable } }) }
    ).then(
      (r) => ({ r, threw: false }),
      () => ({ r: null, threw: true })
    );
    const r = threw.r;
    const shapeOk =
      threw.threw === false &&
      r !== null &&
      !('error' in r) &&
      Array.isArray(r.citations) &&
      r.citations.length === 0 &&
      Array.isArray(r.directions) &&
      r.directions.length === 0 &&
      r.disclaimer === CONSULT_DISCLAIMER;
    log(`unreachable search baseUrl = ${unreachable}`);
    log(`returned: ${JSON.stringify(r)}`);
    log(`threw = ${threw.threw} (期望 false); search mock 请求数 = ${search.state.requests.length} (期望 0)`);
    log(`断言：未抛 + 无 error + citations=[] + disclaimer 一致: ${shapeOk}`);
  }
  log('');

  // [d] extract 上游 500 → 结构化 {candidates:[], reason:'upstream_error'}，不抛异常。
  log('[d] /api/extract-memory 上游 500 → {candidates:[], reason:upstream_error}，不抛异常');
  resetMocks();
  llm.state.mode = 'always-500';
  {
    const threw = await extractMemory(
      { messages: [{ role: 'user', content: '我一般晚上十点前就睡了' }], consent: true },
      { config: makeConfig() }
    ).then(
      (r) => ({ r, threw: false }),
      () => ({ r: null, threw: true })
    );
    const r = threw.r;
    log(`returned: ${JSON.stringify(r)}`);
    log(`threw = ${threw.threw} (期望 false); llm 请求数 = ${llm.state.requests.length} (期望 2)`);
    log(
      `断言 candidates=[] 且 reason === 'upstream_error': ${
        threw.threw === false &&
        r !== null &&
        Array.isArray(r.candidates) &&
        r.candidates.length === 0 &&
        r.reason === 'upstream_error'
      }`
    );
  }
  log('');

  log('结论：四类真实降级（LLM 不可达 / LLM 500 / 搜索不可达 / extract 上游 500）均归一化为');
  log('      结构化对象，全程未抛未捕获异常；搜索不可达不产生任何编造引用。');

  await llm.close();
  await search.close();

  mkdirSync(resolve(root, 'artifacts/qa'), { recursive: true });
  const out = resolve(root, 'artifacts/qa/27-failure.txt');
  writeFileSync(out, `${lines.join('\n')}\n`);
  console.log(`wrote ${out}`);
  process.exit(1); // 失败模式刻意 exit 1（house 约定）
}

// ---------------------------------------------------------------------------
// happy 模式：聚合
// ---------------------------------------------------------------------------

async function runHappyMode() {
  const checks = [];
  const record = (name, pass, detail) => checks.push({ name, pass: pass === true, detail });

  const sources = [];
  const byId = {};

  for (const src of SOURCES) {
    const abs = resolve(root, src.path);
    const present = existsSync(abs);
    let raw = '';
    let parsed = null;
    let timestamp = null;
    if (present) {
      try {
        raw = readFileSync(abs, 'utf8');
      } catch {
        raw = '';
      }
      if (src.kind === 'json') {
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = null;
        }
        timestamp = parsed !== null && typeof parsed.timestamp === 'string' ? parsed.timestamp : null;
      } else {
        timestamp = parseTextTimestamp(raw);
      }
    }

    let zeroFailures = false;
    let failureDetail = null;
    if (parsed !== null) {
      byId[src.id] = Array.isArray(parsed.cases) ? parsed.cases : [];
      if (src.id === 'health') {
        zeroFailures = parsed.summary?.passed === true;
        failureDetail = parsed.summary?.checks ?? null;
      } else if (src.id === 'redaction') {
        zeroFailures =
          parsed.summary?.failed === 0 && parsed.summary?.typecheck_exit === 0;
        failureDetail = parsed.summary ?? null;
      } else {
        zeroFailures = parsed.summary?.failed === 0;
        failureDetail = parsed.summary ?? null;
      }
    } else if (src.kind === 'text') {
      zeroFailures = /^verdict:\s*PASS\b/m.test(raw);
    }

    const ageMs = ageOf(timestamp);
    const fresh =
      src.freshness === false ? true : ageMs !== null && ageMs >= -60000 && ageMs <= MAX_AGE_MS;

    const entry = {
      id: src.id,
      path: src.path,
      kind: src.kind,
      role: src.role,
      present,
      zero_failures: zeroFailures,
      timestamp,
      age_ms: ageMs,
      fresh,
      freshness_enforced: src.freshness !== false,
      detail: failureDetail,
    };
    sources.push(entry);

    record(`source ${src.id}: present`, present, { path: src.path });
    record(`source ${src.id}: zero failures`, zeroFailures, failureDetail);
    record(
      `source ${src.id}: freshness`,
      fresh,
      { timestamp, age_ms: ageMs, enforced: src.freshness !== false, max_age_ms: MAX_AGE_MS }
    );
  }

  // --- 映射 ①–⑪ → 既有用例（子串匹配 + pass） ---
  const coverage = [];
  for (const item of COVERAGE) {
    const evidence = item.evidence.map(([srcId, needle]) => {
      const cases = byId[srcId] ?? [];
      const found = cases.find((c) => typeof c.name === 'string' && c.name.includes(needle));
      return {
        source: srcId,
        case: needle,
        found: found !== undefined,
        pass: found !== undefined && found.pass === true,
      };
    });
    const ok = evidence.every((e) => e.pass);
    coverage.push({ id: item.id, label: item.label, ok, evidence });
    record(
      `coverage ${item.id} ${item.label}`,
      ok,
      { evidence }
    );
  }

  const summary = {
    total: checks.length,
    passed: checks.filter((c) => c.pass).length,
    failed: checks.filter((c) => !c.pass).length,
    sources_ok: sources.every((s) => s.present && s.zero_failures && s.fresh),
    coverage_ok: coverage.every((c) => c.ok),
  };

  const artifact = {
    command: 'npx tsx scripts/check-matrix.mjs',
    timestamp: new Date().toISOString(),
    role: 'aggregator (runs LAST in the test:server chain)',
    max_age_ms: MAX_AGE_MS,
    sources,
    coverage,
    cases: checks,
    summary,
  };

  const outDir = resolve(root, 'artifacts/checks');
  mkdirSync(outDir, { recursive: true });
  const outPath = resolve(outDir, 'server-all.json');
  writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`);

  for (const s of sources) {
    console.log(
      `${s.present && s.zero_failures && s.fresh ? 'PASS' : 'FAIL'} - source ${s.id} (${s.path})`
    );
  }
  for (const c of coverage) {
    console.log(`${c.ok ? 'PASS' : 'FAIL'} - coverage ${c.id} ${c.label}`);
  }
  console.log(`matrix ${summary.passed}/${summary.total} passed, failed=${summary.failed}`);
  console.log(`wrote ${outPath}`);

  process.exit(summary.failed === 0 ? 0 : 1);
}

if (failureMode) {
  await runFailureMode();
} else {
  await runHappyMode();
}
