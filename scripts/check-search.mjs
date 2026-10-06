#!/usr/bin/env node
// scripts/check-search.mjs
// Zero-dependency harness (tsx-run) for server/providers/search.ts + server/authorities.ts (task 24).
//
// Spins up a local search-mock upstream bound to 127.0.0.1 on an ephemeral port
// (OS-assigned), then dynamically imports the adapter and asserts:
//   - request shape: POST {baseUrl}/search with Content-Type + Authorization + body {q,limit}
//   - normalization: {title,url,snippet,domain,publishedAt?} with lowercased domain
//   - authority filtering: exact host + subdomain pass; spoofs (evil-nhc.gov.cn / nhcgov.cn) rejected
//   - mixed results -> only authority entries survive (reason null)
//   - zero results -> reason=no_results
//   - only non-authority -> reason=no_authority_match
//   - not_configured (empty baseUrl) / empty query -> no network call
//   - timeout / 429 / 500 / bad JSON -> {results:[], reason:'search_unavailable'}, NEVER throws
//   - config-supplied authorityDomains OVERRIDE the default list (both directions)
//   - strict subdomain matcher unit cases
//   - config loader reads server/config.json search.{baseUrl,apiKey} + authorityDomains (values NOT recorded)
//   - privacy: adapter+authorities sources contain no disk-write or console statements
//
// No external network I/O is performed; everything stays on 127.0.0.1.
//
// Modes:
//   (default)            happy run -> artifacts/checks/server-search.json, exit 0 on all-pass
//   --simulate-failure   raw failure transcript (real timeout/429/500/bad-json runs) ->
//                        artifacts/qa/24-failure.txt, exit 1 (failure-mode contract)

import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { makeDetailRecord } from './lib/check-helpers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const failureMode = process.argv.includes('--simulate-failure');

// ---------------------------------------------------------------------------
// Modules under test (+ config loader)
// ---------------------------------------------------------------------------

const { search } = await import(
  pathToFileURL(resolve(root, 'server/providers/search.ts')).href
);
const { isAuthorityUrl, resolveAuthorityDomains, DEFAULT_AUTHORITY_DOMAINS } = await import(
  pathToFileURL(resolve(root, 'server/authorities.ts')).href
);
const { loadConfig } = await import(pathToFileURL(resolve(root, 'server/config.ts')).href);

// ---------------------------------------------------------------------------
// Fixtures (synthetic; no patient data)
// ---------------------------------------------------------------------------

const EXACT = {
  title: '国家卫健委：疾病防治公告',
  url: 'https://nhc.gov.cn/notice/1',
  snippet: '官方公告摘要',
  publishedAt: '2026-01-02',
};
const SUBDOMAIN = {
  title: '疾控中心：健康提示',
  url: 'https://www.chinacdc.cn/tips/2',
  snippet: '健康提示摘要',
};
const SPOOF_HYPHEN = { title: '仿冒-连字符', url: 'https://evil-nhc.gov.cn/x', snippet: 'x' };
const SPOOF_NODOT = { title: '仿冒-无分隔点', url: 'https://nhcgov.cn/x', snippet: 'x' };
const COMMERCIAL = { title: '商业广告', url: 'https://some-clinic.example.com/ad', snippet: 'x' };
const BAD_URL = { title: '坏链接', url: 'not a url', snippet: 'x' };

// ---------------------------------------------------------------------------
// Mock upstream (search contract: POST /search -> {results:[...]})
// ---------------------------------------------------------------------------

function startMock(name) {
  const state = { mode: 'ok', results: [], requests: [] };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
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

      if (state.mode === 'always-429') {
        json(429, { error: { message: 'mock rate limited' } });
        return;
      }
      if (state.mode === 'always-500') {
        json(500, { error: { message: 'mock upstream 500' } });
        return;
      }
      if (state.mode === 'slow') {
        // Respond well after the client timeout; unref so it never blocks exit.
        const t = setTimeout(() => json(200, { results: state.results }), 800);
        t.unref();
        return;
      }
      if (state.mode === 'bad-json') {
        if (!res.writableEnded) {
          res.statusCode = 200;
          res.setHeader('content-type', 'application/json');
          res.end('this is not json');
        }
        return;
      }
      if (state.mode === 'wrong-shape') {
        json(200, { items: state.results });
        return;
      }
      json(200, { results: state.results });
    });
  });

  return new Promise((resolveP) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolveP({
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

function callSearch(mock, query, opts = {}) {
  const {
    apiKey = 'sk-search-123',
    baseUrl = mock.baseUrl,
    authorityDomains,
    timeoutMs,
    limit,
    signal,
  } = opts;
  return search(query, { config: { baseUrl, apiKey }, authorityDomains, timeoutMs, limit, signal });
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

  const mock = await startMock('failure-mock');

  log('T24 搜索适配器 — 失败路径原始记录');
  log('========================================');
  log(`timestamp: ${new Date().toISOString()}`);
  log(`node: ${process.version}`);
  log(`mock upstream: ${mock.baseUrl} (只在本机 127.0.0.1)`);
  log('');

  log('[a] 上游超时 (timeoutMs=150, 上游 800ms 后才有响应) -> 空结果 + reason=search_unavailable，不抛');
  mock.state.mode = 'slow';
  mock.state.results = [SUBDOMAIN];
  mock.state.requests.length = 0;
  const t0 = Date.now();
  try {
    const r = await callSearch(mock, '高血压', { timeoutMs: 150 });
    log(
      `returned: results.length=${r.results.length} reason=${r.reason} elapsed_ms=${Date.now() - t0}`
    );
  } catch (e) {
    log(`unexpected THROW: ${e instanceof Error ? e.message : String(e)}`);
  }
  log(`mock 收到的请求数 = ${mock.state.requests.length}`);
  log('');

  log('[b] 上游限流 429 -> 空结果 + reason=search_unavailable，不抛');
  mock.state.mode = 'always-429';
  mock.state.requests.length = 0;
  try {
    const r = await callSearch(mock, '糖尿病');
    log(`returned: results.length=${r.results.length} reason=${r.reason}`);
  } catch (e) {
    log(`unexpected THROW: ${e instanceof Error ? e.message : String(e)}`);
  }
  log(`mock 收到的请求数 = ${mock.state.requests.length}`);
  log('');

  log('[c] 上游 500 -> 空结果 + reason=search_unavailable，不抛');
  mock.state.mode = 'always-500';
  mock.state.requests.length = 0;
  try {
    const r = await callSearch(mock, '冠心病');
    log(`returned: results.length=${r.results.length} reason=${r.reason}`);
  } catch (e) {
    log(`unexpected THROW: ${e instanceof Error ? e.message : String(e)}`);
  }
  log(`mock 收到的请求数 = ${mock.state.requests.length}`);
  log('');

  log('[d] 上游返回非法 JSON -> 空结果 + reason=search_unavailable，不抛');
  mock.state.mode = 'bad-json';
  mock.state.requests.length = 0;
  try {
    const r = await callSearch(mock, '体检');
    log(`returned: results.length=${r.results.length} reason=${r.reason}`);
  } catch (e) {
    log(`unexpected THROW: ${e instanceof Error ? e.message : String(e)}`);
  }
  log(`mock 收到的请求数 = ${mock.state.requests.length}`);
  log('');

  log('结论：超时 / 限流(429) / 5xx / 非法响应 均已归一化为 {results:[], reason:"search_unavailable"}；');
  log('      全程未抛未捕获异常；本文件仅记录 reason/计数/耗时，绝不落盘请求内容。');

  await mock.close();
  mkdirSync(resolve(root, 'artifacts/qa'), { recursive: true });
  writeFileSync(resolve(root, 'artifacts/qa/24-failure.txt'), `${lines.join('\n')}\n`);
  console.log(`wrote ${resolve(root, 'artifacts/qa/24-failure.txt')}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Happy mode
// ---------------------------------------------------------------------------

const cases = [];
const record = makeDetailRecord(cases);

const primary = await startMock('primary');
const secondary = await startMock('secondary');

// 1) not_configured: empty baseUrl -> reason not_configured, NO network call.
primary.state.mode = 'ok';
primary.state.requests.length = 0;
const r1 = await search('高血压', { config: { baseUrl: '', apiKey: 'sk-x' } });
record(
  'not_configured: empty baseUrl -> reason=not_configured with NO network call',
  r1.results.length === 0 && r1.reason === 'not_configured' && primary.state.requests.length === 0,
  { reason: r1.reason, results_length: r1.results.length, request_count: primary.state.requests.length }
);

// 2) empty query -> no_results, NO network call.
primary.state.mode = 'ok';
primary.state.requests.length = 0;
const r2 = await search('   ', { config: { baseUrl: primary.baseUrl, apiKey: 'sk-search-123' } });
record(
  'no_results: blank query -> reason=no_results with NO network call',
  r2.results.length === 0 && r2.reason === 'no_results' && primary.state.requests.length === 0,
  { reason: r2.reason, results_length: r2.results.length, request_count: primary.state.requests.length }
);

// 3) request shape: POST /search + Authorization + Content-Type + body {q,limit}.
primary.state.mode = 'ok';
primary.state.results = [EXACT];
primary.state.requests.length = 0;
const r3 = await callSearch(primary, '高血压');
const req3 = primary.state.requests[0];
record(
  'request: POST {baseUrl}/search with Authorization + Content-Type + body{q,limit}',
  req3 !== undefined &&
    req3.method === 'POST' &&
    req3.url === '/search' &&
    req3.headers.authorization === 'Bearer sk-search-123' &&
    String(req3.headers['content-type']).includes('application/json') &&
    req3.body !== null &&
    req3.body.q === '高血压' &&
    typeof req3.body.limit === 'number',
  {
    method: req3?.method,
    url: req3?.url,
    authorization_ok: req3?.headers?.authorization === 'Bearer sk-search-123',
    content_type: req3?.headers?.['content-type'],
    body: req3?.body,
  }
);

// 4) exact authority domain passes + full source structure (incl. publishedAt).
record(
  'authority: exact host nhc.gov.cn passes with full structure {title,url,snippet,domain,publishedAt}',
  r3.results.length === 1 &&
    r3.reason === null &&
    r3.results[0].domain === 'nhc.gov.cn' &&
    r3.results[0].title === EXACT.title &&
    r3.results[0].url === EXACT.url &&
    r3.results[0].snippet === EXACT.snippet &&
    r3.results[0].publishedAt === '2026-01-02' &&
    Object.keys(r3.results[0]).sort().join(',') === 'domain,publishedAt,snippet,title,url',
  { reason: r3.reason, result: r3.results[0] }
);

// 5) subdomain authority passes (www.chinacdc.cn).
primary.state.mode = 'ok';
primary.state.results = [SUBDOMAIN];
primary.state.requests.length = 0;
const r5 = await callSearch(primary, '流感疫苗');
record(
  'authority: subdomain www.chinacdc.cn passes (domain normalized lowercased)',
  r5.results.length === 1 && r5.reason === null && r5.results[0].domain === 'www.chinacdc.cn',
  { reason: r5.reason, result: r5.results[0] }
);

// 6) spoof domains rejected -> no_authority_match.
primary.state.mode = 'ok';
primary.state.results = [SPOOF_HYPHEN, SPOOF_NODOT];
primary.state.requests.length = 0;
const r6 = await callSearch(primary, '伪权威');
record(
  'authority: spoof hosts evil-nhc.gov.cn + nhcgov.cn are REJECTED (reason=no_authority_match)',
  r6.results.length === 0 && r6.reason === 'no_authority_match',
  { reason: r6.reason, results_length: r6.results.length }
);

// 7) mixed results -> only authority survive, reason null.
primary.state.mode = 'ok';
primary.state.results = [SPOOF_HYPHEN, EXACT, COMMERCIAL, SUBDOMAIN, SPOOF_NODOT];
primary.state.requests.length = 0;
const r7 = await callSearch(primary, '混合结果');
record(
  'filter: mixed authority + non-authority -> only authority survive (reason=null)',
  r7.results.length === 2 &&
    r7.reason === null &&
    r7.results.every((x) => isAuthorityUrl(x.domain, DEFAULT_AUTHORITY_DOMAINS)) &&
    r7.results.some((x) => x.domain === 'nhc.gov.cn') &&
    r7.results.some((x) => x.domain === 'www.chinacdc.cn'),
  { reason: r7.reason, domains: r7.results.map((x) => x.domain) }
);

// 8) zero results -> no_results.
primary.state.mode = 'ok';
primary.state.results = [];
primary.state.requests.length = 0;
const r8 = await callSearch(primary, '无结果查询');
record(
  'no_results: upstream {results:[]} -> reason=no_results, empty array',
  r8.results.length === 0 && r8.reason === 'no_results',
  { reason: r8.reason, results_length: r8.results.length }
);

// 9) all non-authority -> no_authority_match.
primary.state.mode = 'ok';
primary.state.results = [COMMERCIAL];
primary.state.requests.length = 0;
const r9 = await callSearch(primary, '商业来源');
record(
  'no_authority_match: all results non-authority -> reason=no_authority_match, empty array',
  r9.results.length === 0 && r9.reason === 'no_authority_match',
  { reason: r9.reason, results_length: r9.results.length }
);

// 10) items with unparseable url are dropped; if all dropped -> no_results.
primary.state.mode = 'ok';
primary.state.results = [BAD_URL, SPOOF_HYPHEN];
primary.state.requests.length = 0;
const r10 = await callSearch(primary, '坏链接');
record(
  'normalize: unparseable-url item dropped; remaining non-authority -> no_authority_match',
  r10.results.length === 0 && r10.reason === 'no_authority_match',
  { reason: r10.reason, results_length: r10.results.length }
);
primary.state.mode = 'ok';
primary.state.results = [BAD_URL];
const r10b = await callSearch(primary, '全是坏链接');
record(
  'normalize: all items unparseable -> reason=no_results',
  r10b.results.length === 0 && r10b.reason === 'no_results',
  { reason: r10b.reason, results_length: r10b.results.length }
);

// 11) timeout -> search_unavailable, no throw.
primary.state.mode = 'slow';
primary.state.results = [SUBDOMAIN];
primary.state.requests.length = 0;
const t11 = Date.now();
let r11 = null;
try {
  r11 = await callSearch(primary, '超时', { timeoutMs: 150 });
} catch (e) {
  r11 = { threw: e instanceof Error ? e.message : String(e) };
}
record(
  'error: timeout -> {results:[], reason:search_unavailable}, does NOT throw',
  r11 !== null &&
    r11.threw === undefined &&
    r11.results.length === 0 &&
    r11.reason === 'search_unavailable',
  { reason: r11?.reason, results_length: r11?.results?.length, threw: r11?.threw, elapsed_ms: Date.now() - t11 }
);

// 12) 429 -> search_unavailable, no throw.
primary.state.mode = 'always-429';
primary.state.requests.length = 0;
let r12 = null;
try {
  r12 = await callSearch(primary, '限流');
} catch (e) {
  r12 = { threw: e instanceof Error ? e.message : String(e) };
}
record(
  'error: HTTP 429 -> {results:[], reason:search_unavailable}, does NOT throw',
  r12 !== null &&
    r12.threw === undefined &&
    r12.results.length === 0 &&
    r12.reason === 'search_unavailable',
  { reason: r12?.reason, results_length: r12?.results?.length, threw: r12?.threw, request_count: primary.state.requests.length }
);

// 13) 500 -> search_unavailable, no throw.
primary.state.mode = 'always-500';
primary.state.requests.length = 0;
let r13 = null;
try {
  r13 = await callSearch(primary, '上游错误');
} catch (e) {
  r13 = { threw: e instanceof Error ? e.message : String(e) };
}
record(
  'error: HTTP 500 -> {results:[], reason:search_unavailable}, does NOT throw',
  r13 !== null &&
    r13.threw === undefined &&
    r13.results.length === 0 &&
    r13.reason === 'search_unavailable',
  { reason: r13?.reason, results_length: r13?.results?.length, threw: r13?.threw }
);

// 14) malformed JSON / wrong shape -> search_unavailable.
primary.state.mode = 'bad-json';
primary.state.requests.length = 0;
const r14 = await callSearch(primary, '坏响应');
primary.state.mode = 'wrong-shape';
primary.state.results = [EXACT];
const r14b = await callSearch(primary, '错误形状');
record(
  'error: bad JSON + wrong response shape -> reason=search_unavailable',
  r14.results.length === 0 &&
    r14.reason === 'search_unavailable' &&
    r14b.results.length === 0 &&
    r14b.reason === 'search_unavailable',
  { bad_json_reason: r14.reason, wrong_shape_reason: r14b.reason }
);

// 15) config-supplied authorityDomains OVERRIDE the default list (both directions).
primary.state.mode = 'ok';
primary.state.results = [COMMERCIAL, EXACT];
primary.state.requests.length = 0;
const r15a = await callSearch(primary, '覆盖-放行', {
  authorityDomains: ['some-clinic.example.com'],
});
record(
  'override: custom list admits commercial host AND excludes default authority',
  r15a.results.length === 1 &&
    r15a.reason === null &&
    r15a.results[0].domain === 'some-clinic.example.com',
  { reason: r15a.reason, domains: r15a.results.map((x) => x.domain) }
);

primary.state.results = [EXACT];
const r15b = await callSearch(primary, '覆盖-拒绝默认', { authorityDomains: ['example.org'] });
record(
  'override: custom list excludes nhc.gov.cn (default does NOT leak through)',
  r15b.results.length === 0 && r15b.reason === 'no_authority_match',
  { reason: r15b.reason, results_length: r15b.results.length }
);

// 16) empty/blank override falls back to defaults.
primary.state.results = [EXACT];
const r16 = await callSearch(primary, '空覆盖', { authorityDomains: ['', '   '] });
record(
  'override: blank/empty config list falls back to DEFAULT_AUTHORITY_DOMAINS',
  r16.results.length === 1 && r16.reason === null && r16.results[0].domain === 'nhc.gov.cn',
  { reason: r16.reason, domains: r16.results.map((x) => x.domain) }
);

// 17) domain normalization: uppercase host + path + port.
primary.state.mode = 'ok';
primary.state.results = [
  { title: '大写主机', url: 'https://WWW.NHC.GOV.CN/Path?x=1', snippet: 's' },
  { title: '带端口', url: 'https://nhc.gov.cn:443/y', snippet: 's' },
];
primary.state.requests.length = 0;
const r17 = await callSearch(primary, '规整');
record(
  'normalize: uppercase host lowercased + path/port stripped in domain field',
  r17.results.length === 2 &&
    r17.results.some((x) => x.domain === 'www.nhc.gov.cn') &&
    r17.results.some((x) => x.domain === 'nhc.gov.cn'),
  { domains: r17.results.map((x) => x.domain) }
);

// 18) strict subdomain matcher unit cases.
const unitCases = [
  ['nhc.gov.cn', true],
  ['NHC.GOV.CN', true],
  ['www.nhc.gov.cn', true],
  ['a.b.nhc.gov.cn', true],
  ['https://www.nhc.gov.cn/x', true],
  ['https://nhc.gov.cn:443/x', true],
  ['evil-nhc.gov.cn', false],
  ['nhcgov.cn', false],
  ['notnhc.gov.cn', false],
  ['nhc.gov.cn.evil.com', false],
  ['', false],
  ['   ', false],
  ['not a host', false],
];
const unitOk = unitCases.every(([input, expected]) =>
  isAuthorityUrl(input, DEFAULT_AUTHORITY_DOMAINS) === expected
);
record(
  'matcher: isAuthorityUrl strict subdomain cases (exact/subdomain/ports/spoofs)',
  unitOk,
  {
    cases: unitCases.map(([input, expected]) => ({
      input,
      expected,
      actual: isAuthorityUrl(input, DEFAULT_AUTHORITY_DOMAINS),
    })),
  }
);

// 19) default list shape + resolveAuthorityDomains override semantics.
const hasCategories =
  DEFAULT_AUTHORITY_DOMAINS.includes('nhc.gov.cn') &&
  DEFAULT_AUTHORITY_DOMAINS.includes('chinacdc.cn') &&
  DEFAULT_AUTHORITY_DOMAINS.includes('nmpa.gov.cn') &&
  DEFAULT_AUTHORITY_DOMAINS.includes('cma.org.cn') &&
  DEFAULT_AUTHORITY_DOMAINS.includes('msdmanuals.cn') &&
  DEFAULT_AUTHORITY_DOMAINS.filter((d) => ['pumch.cn', 'wchscu.cn'].includes(d)).length >= 2;
const resolvedDefault = resolveAuthorityDomains([]);
const resolvedOverride = resolveAuthorityDomains(['  Example.COM ', 'example.com', '']);
record(
  'authorities: default list covers nhc/chinacdc/nmpa/cma/msdmanuals + >=2 tertiary hosts; resolve override+dedupe',
  hasCategories &&
    resolvedDefault.length === DEFAULT_AUTHORITY_DOMAINS.length &&
    resolvedOverride.length === 1 &&
    resolvedOverride[0] === 'example.com',
  {
    default_count: DEFAULT_AUTHORITY_DOMAINS.length,
    has_categories: hasCategories,
    resolved_default_count: resolvedDefault.length,
    resolved_override: resolvedOverride,
  }
);

// 20) config-driven routing: different baseUrl/apiKey selects a different upstream.
secondary.state.mode = 'ok';
secondary.state.results = [EXACT];
secondary.state.requests.length = 0;
primary.state.requests.length = 0;
const r20 = await search('路由', {
  config: { baseUrl: secondary.baseUrl, apiKey: 'sk-secondary' },
});
const req20 = secondary.state.requests[0];
record(
  'config-driven: baseUrl/apiKey select the upstream (primary untouched)',
  r20.results.length === 1 &&
    secondary.state.requests.length === 1 &&
    primary.state.requests.length === 0 &&
    req20?.headers?.authorization === 'Bearer sk-secondary',
  {
    secondary_request_count: secondary.state.requests.length,
    primary_request_count: primary.state.requests.length,
    routed_auth_ok: req20?.headers?.authorization === 'Bearer sk-secondary',
  }
);

// 21) config loader reads server/config.json search.{baseUrl,apiKey} + authorityDomains (values NOT recorded).
let cfgInfo = { ok: false };
try {
  const cfg = loadConfig();
  cfgInfo = {
    ok: true,
    has_base_url: typeof cfg.search.baseUrl === 'string',
    has_api_key: typeof cfg.search.apiKey === 'string',
    search_keys: Object.keys(cfg.search).sort(),
    authority_is_array: Array.isArray(cfg.authorityDomains),
  };
} catch (e) {
  cfgInfo = { ok: false, error: e instanceof Error ? e.message : String(e) };
}
record(
  'config: loadConfig() reads server/config.json search.{baseUrl,apiKey} + authorityDomains[] (values NOT recorded)',
  cfgInfo.ok === true &&
    cfgInfo.has_base_url === true &&
    cfgInfo.has_api_key === true &&
    Array.isArray(cfgInfo.search_keys) &&
    cfgInfo.search_keys.join(',') === 'apiKey,baseUrl' &&
    cfgInfo.authority_is_array === true,
  cfgInfo
);

// 22) privacy: adapter + authorities sources have no disk-write or console statements.
const adapterSrc = readFileSync(resolve(root, 'server/providers/search.ts'), 'utf8');
const authSrc = readFileSync(resolve(root, 'server/authorities.ts'), 'utf8');
const banned = [
  'writeFile',
  'appendFile',
  'createWriteStream',
  'node:fs',
  'console.log',
  'console.error',
  'console.warn',
];
const bannedHits = banned.filter((token) => adapterSrc.includes(token) || authSrc.includes(token));
record(
  'privacy: search.ts + authorities.ts sources have no disk-write or console statements',
  bannedHits.length === 0,
  { banned_hits: bannedHits }
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
  command: 'npx tsx scripts/check-search.mjs',
  timestamp: new Date().toISOString(),
  modules: ['server/providers/search.ts', 'server/authorities.ts'],
  mocks: [
    { name: primary.name, base_url: primary.baseUrl },
    { name: secondary.name, base_url: secondary.baseUrl },
  ],
  cases,
  summary,
};

const outDir = resolve(root, 'artifacts/checks');
mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, 'server-search.json'), `${JSON.stringify(artifact, null, 2)}\n`);

await primary.close();
await secondary.close();

for (const c of cases) {
  console.log(`${c.pass ? 'PASS' : 'FAIL'} - ${c.name}`);
}
console.log(`cases ${summary.passed}/${summary.total} passed, failed=${summary.failed}`);
console.log(`wrote ${resolve(outDir, 'server-search.json')}`);

process.exit(summary.failed === 0 ? 0 : 1);
