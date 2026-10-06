#!/usr/bin/env node
// scripts/check-llm.mjs
// Zero-dependency harness (tsx-run) for server/providers/llm.ts (task 23).
//
// Spins up local OpenAI-compatible mock upstream(s) bound to 127.0.0.1 on an
// ephemeral port (OS-assigned), then dynamically imports the adapter and asserts:
//   - request shape: POST {baseUrl}/chat/completions, Authorization, body {model,messages}
//   - non-stream JSON parse (content / model / finish_reason)
//   - retry policy: 5xx retried exactly once; 4xx not retried; persistent 5xx -> 1 retry
//   - timeout -> normalized `timeout` error, retried once
//   - invalid_config -> no network call; invalid_response -> no retry
//   - config-driven routing: different baseUrl/apiKey/model selects a different upstream
//   - privacy: adapter source contains no disk-write or console statements
//
// SSE streaming was removed (P1-39/P1-40): it had zero product consumers and the abort
// chain was unreachable; its test claims are removed with it.
//
// No external network I/O is performed; everything stays on 127.0.0.1.
//
// Modes:
//   (default)            happy run -> artifacts/checks/server-llm.json, exit 0 on all-pass
//   --simulate-failure   raw failure transcript (real 500/timeout/4xx runs) ->
//                        artifacts/qa/23-failure.txt, exit 1 (failure-mode contract)

import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { makeDetailRecord } from './lib/check-helpers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const failureMode = process.argv.includes('--simulate-failure');

// ---------------------------------------------------------------------------
// Module under test (+ config loader)
// ---------------------------------------------------------------------------

const { chat, LlmError } = await import(
  pathToFileURL(resolve(root, 'server/providers/llm.ts')).href
);
const { loadConfig } = await import(pathToFileURL(resolve(root, 'server/config.ts')).href);

// ---------------------------------------------------------------------------
// Mock upstream (OpenAI-compatible /chat/completions)
// ---------------------------------------------------------------------------

function okJson(content = 'Hello from mock', model = 'mock-model') {
  return {
    id: 'chatcmpl-mock',
    object: 'chat.completion',
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
  };
}

function startMock(name) {
  const state = { mode: 'ok-json', requests: [] };
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

      const mode = state.mode;
      const json = (status, payload) => {
        if (res.writableEnded) return;
        res.statusCode = status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(payload));
      };

      if (mode === 'always-500') {
        json(500, { error: { message: 'mock upstream 500' } });
        return;
      }
      if (mode === 'always-400') {
        json(400, { error: { message: 'mock bad request' } });
        return;
      }
      if (mode === 'fail-once-500') {
        state.mode = 'ok-json';
        json(500, { error: { message: 'mock flaky 500' } });
        return;
      }
      if (mode === 'slow') {
        // Respond well after the client timeout; unref so it never blocks exit.
        const t = setTimeout(() => json(200, okJson()), 800);
        t.unref();
        return;
      }
      if (mode === 'bad-json') {
        if (!res.writableEnded) {
          res.statusCode = 200;
          res.setHeader('content-type', 'application/json');
          res.end('this is not json');
        }
        return;
      }
      json(200, okJson());
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

function callChat(mock, opts = {}) {
  const {
    timeoutMs,
    maxRetries,
    apiKey = 'sk-test-123',
    model = 'gpt-test',
    baseUrl = mock.baseUrl,
  } = opts;
  return chat(
    [
      { role: 'system', content: '你是助手' },
      { role: 'user', content: '你好' },
    ],
    { config: { baseUrl, apiKey, model }, timeoutMs, maxRetries }
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

  const mock = await startMock('failure-mock');

  log('T23 LLM 适配器 — 失败路径原始记录');
  log('========================================');
  log(`timestamp: ${new Date().toISOString()}`);
  log(`node: ${process.version}`);
  log(`mock upstream: ${mock.baseUrl} (只在本机 127.0.0.1)`);
  log('');

  log('[a] 上游持续 500 -> 归一化错误，且最多重试 1 次');
  mock.state.mode = 'always-500';
  mock.state.requests.length = 0;
  try {
    await callChat(mock);
    log('unexpected: 未抛错');
  } catch (e) {
    log(`thrown: code=${e?.code} message=${e?.message} retryable=${e?.retryable}`);
  }
  log(`mock 收到的请求数 = ${mock.state.requests.length} (期望 2 = 首次 + 1 次重试)`);
  log('');

  log('[b] 上游超时 (timeoutMs=150, 上游 800ms 后才有响应) -> 归一化超时错误 + 1 次重试');
  mock.state.mode = 'slow';
  mock.state.requests.length = 0;
  const t0 = Date.now();
  try {
    await callChat(mock, { timeoutMs: 150 });
    log('unexpected: 未抛错');
  } catch (e) {
    log(
      `thrown: code=${e?.code} message=${e?.message} retryable=${e?.retryable} elapsed_ms=${Date.now() - t0}`
    );
  }
  log(`mock 收到的请求数 = ${mock.state.requests.length} (期望 2 = 首次 + 1 次重试)`);
  log('');

  log('[c] 上游 4xx -> 归一化错误，不重试');
  mock.state.mode = 'always-400';
  mock.state.requests.length = 0;
  try {
    await callChat(mock);
    log('unexpected: 未抛错');
  } catch (e) {
    log(`thrown: code=${e?.code} message=${e?.message} retryable=${e?.retryable}`);
  }
  log(`mock 收到的请求数 = ${mock.state.requests.length} (期望 1，不重试)`);
  log('');

  log('结论：错误已归一化为 {code,message}；500 与超时最多重试 1 次后放弃；4xx 不重试；');
  log('      整个失败路径未写入任何请求内容（本文件仅记录状态码/计数/错误码）。');

  await mock.close();
  mkdirSync(resolve(root, 'artifacts/qa'), { recursive: true });
  writeFileSync(resolve(root, 'artifacts/qa/23-failure.txt'), `${lines.join('\n')}\n`);
  console.log(`wrote ${resolve(root, 'artifacts/qa/23-failure.txt')}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Happy mode
// ---------------------------------------------------------------------------

const cases = [];
const record = makeDetailRecord(cases);

const primary = await startMock('primary');
const secondary = await startMock('secondary');

// 1) non-stream request shape + parse
primary.state.mode = 'ok-json';
primary.state.requests.length = 0;
const r1 = await callChat(primary);
const req1 = primary.state.requests[0];
record(
  'non-stream: POST {baseUrl}/chat/completions with Authorization + body{model,messages}',
  req1 !== undefined &&
    req1.method === 'POST' &&
    req1.url === '/chat/completions' &&
    req1.headers.authorization === 'Bearer sk-test-123' &&
    String(req1.headers['content-type']).includes('application/json') &&
    req1.body !== null &&
    req1.body.model === 'gpt-test' &&
    !('stream' in req1.body) &&
    Array.isArray(req1.body.messages) &&
    req1.body.messages.length === 2 &&
    req1.body.messages[1].content === '你好',
  {
    method: req1?.method,
    url: req1?.url,
    authorization_ok: req1?.headers?.authorization === 'Bearer sk-test-123',
    content_type: req1?.headers?.['content-type'],
    body: req1?.body,
  }
);
record(
  'non-stream: content / model / finish_reason parsed',
  r1.content === 'Hello from mock' && r1.streamed === false && r1.finishReason === 'stop',
  { content: r1.content, model: r1.model, finish_reason: r1.finishReason, streamed: r1.streamed }
);

// 3) 5xx retried exactly once -> success
primary.state.mode = 'fail-once-500';
primary.state.requests.length = 0;
const r3 = await callChat(primary);
record(
  'retry: 5xx is retried exactly once then succeeds (request_count === 2)',
  r3.content === 'Hello from mock' && primary.state.requests.length === 2,
  { content: r3.content, request_count: primary.state.requests.length }
);

// 4) persistent 5xx -> normalized error, at most 1 retry
primary.state.mode = 'always-500';
primary.state.requests.length = 0;
let e4 = null;
try {
  await callChat(primary);
} catch (e) {
  e4 = e;
}
record(
  'error: persistent 500 -> code=upstream_error, exactly 1 retry (request_count === 2)',
  e4 instanceof LlmError &&
    e4.code === 'upstream_error' &&
    e4.retryable === true &&
    primary.state.requests.length === 2,
  { code: e4?.code, message: e4?.message, request_count: primary.state.requests.length }
);

// 5) 4xx -> no retry
primary.state.mode = 'always-400';
primary.state.requests.length = 0;
let e5 = null;
try {
  await callChat(primary);
} catch (e) {
  e5 = e;
}
record(
  'error: 4xx -> code=upstream_error, NO retry (request_count === 1)',
  e5 instanceof LlmError &&
    e5.code === 'upstream_error' &&
    e5.retryable === false &&
    primary.state.requests.length === 1,
  {
    code: e5?.code,
    message: e5?.message,
    retryable: e5?.retryable,
    request_count: primary.state.requests.length,
  }
);

// 6) timeout -> normalized, retried once
primary.state.mode = 'slow';
primary.state.requests.length = 0;
const timeoutStart = Date.now();
let e6 = null;
try {
  await callChat(primary, { timeoutMs: 150 });
} catch (e) {
  e6 = e;
}
record(
  'error: timeout -> code=timeout, retried once (request_count === 2)',
  e6 instanceof LlmError &&
    e6.code === 'timeout' &&
    e6.retryable === true &&
    primary.state.requests.length === 2,
  {
    code: e6?.code,
    message: e6?.message,
    request_count: primary.state.requests.length,
    elapsed_ms: Date.now() - timeoutStart,
  }
);

// 7) invalid_config -> no network call
primary.state.mode = 'ok-json';
primary.state.requests.length = 0;
let e7 = null;
try {
  await chat([{ role: 'user', content: 'x' }], {
    config: { baseUrl: '', apiKey: 'sk', model: 'm' },
  });
} catch (e) {
  e7 = e;
}
record(
  'error: empty baseUrl -> code=invalid_config with NO network call',
  e7 instanceof LlmError && e7.code === 'invalid_config' && primary.state.requests.length === 0,
  { code: e7?.code, message: e7?.message, request_count: primary.state.requests.length }
);

// 8) invalid response body -> no retry
primary.state.mode = 'bad-json';
primary.state.requests.length = 0;
let e8 = null;
try {
  await callChat(primary);
} catch (e) {
  e8 = e;
}
record(
  'error: non-JSON 2xx body -> code=invalid_response, NO retry (request_count === 1)',
  e8 instanceof LlmError && e8.code === 'invalid_response' && primary.state.requests.length === 1,
  { code: e8?.code, message: e8?.message, request_count: primary.state.requests.length }
);

// 9) config-driven routing: different config -> different upstream, no vendor hardcoding
primary.state.mode = 'ok-json';
primary.state.requests.length = 0;
secondary.state.mode = 'ok-json';
secondary.state.requests.length = 0;
const r9 = await chat([{ role: 'user', content: 'route-me' }], {
  config: { baseUrl: secondary.baseUrl, apiKey: 'sk-secondary', model: 'model-b' },
});
const req9 = secondary.state.requests[0];
record(
  'config-driven: baseUrl/apiKey/model select the upstream (primary untouched)',
  r9.content === 'Hello from mock' &&
    secondary.state.requests.length === 1 &&
    primary.state.requests.length === 0 &&
    req9?.body?.model === 'model-b' &&
    req9?.headers?.authorization === 'Bearer sk-secondary',
  {
    secondary_request_count: secondary.state.requests.length,
    primary_request_count: primary.state.requests.length,
    routed_model: req9?.body?.model,
    routed_auth_ok: req9?.headers?.authorization === 'Bearer sk-secondary',
  }
);

// 11) config loader reads server/config.json (values intentionally NOT recorded)
let cfgInfo = { ok: false };
try {
  const cfg = loadConfig();
  cfgInfo = {
    ok: true,
    has_base_url: typeof cfg.llm.baseUrl === 'string',
    has_model: typeof cfg.llm.model === 'string',
    llm_keys: Object.keys(cfg.llm).sort(),
  };
} catch (e) {
  cfgInfo = { ok: false, error: e instanceof Error ? e.message : String(e) };
}
record(
  'config: loadConfig() reads server/config.json llm.{baseUrl,apiKey,model} (values NOT recorded)',
  cfgInfo.ok === true &&
    cfgInfo.has_base_url === true &&
    cfgInfo.has_model === true &&
    Array.isArray(cfgInfo.llm_keys) &&
    cfgInfo.llm_keys.join(',') === 'apiKey,baseUrl,model',
  cfgInfo
);

// 12) privacy: adapter has no disk-write or console statements
const source = readFileSync(resolve(root, 'server/providers/llm.ts'), 'utf8');
const banned = ['writeFile', 'appendFile', 'createWriteStream', 'node:fs', 'console.log', 'console.error', 'console.warn'];
const bannedHits = banned.filter((token) => source.includes(token));
record(
  'privacy: adapter source has no disk-write or console statements',
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
  command: 'npx tsx scripts/check-llm.mjs',
  timestamp: new Date().toISOString(),
  module: 'server/providers/llm.ts',
  mocks: [
    { name: primary.name, base_url: primary.baseUrl },
    { name: secondary.name, base_url: secondary.baseUrl },
  ],
  cases,
  summary,
};

const outDir = resolve(root, 'artifacts/checks');
mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, 'server-llm.json'), `${JSON.stringify(artifact, null, 2)}\n`);

await primary.close();
await secondary.close();

for (const c of cases) {
  console.log(`${c.pass ? 'PASS' : 'FAIL'} - ${c.name}`);
}
console.log(`cases ${summary.passed}/${summary.total} passed, failed=${summary.failed}`);
console.log(`wrote ${resolve(outDir, 'server-llm.json')}`);

process.exit(summary.failed === 0 ? 0 : 1);
