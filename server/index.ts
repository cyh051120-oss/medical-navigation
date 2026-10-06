#!/usr/bin/env node
// server/index.ts
// 本地 AI 代理 —— HTTP 装配层（任务 22 骨架；任务 26 接线 POST /api/ask）。
//
// 目标：
//   - 仅绑定 127.0.0.1（本机回环），绝不对外网暴露。
//   - 零依赖：只用 Node 内置模块（node:http / node:fs / node:path / node:url）。
//   - GET  /api/health     返回 { ok, providerReady, searchReady, demo }。
//   - POST /api/ask        薄处理器：demo 分支零网络返回 fixtures；否则委托 orchestrator。
//   - POST /api/extract-memory 薄处理器：demo 分支零网络返回 fixtures；否则委托 extract-memory。
//   - 配置来自 server/config.json（gitignored）；可用环境变量 MHP_CONFIG_PATH 覆盖（测试用）。
//
// 运行（Node >= 24，原生类型擦除直跑，无需构建）：
//   node server/index.ts
//   npm run dev:api
//
// POST /api/ask 语义：
//   - 仅接受 POST；非 POST → 405。
//   - 请求体上限 MAX_BODY_BYTES（64KB）；超限 → 413。
//   - 非法 JSON → 400 {error:'invalid_request'}。
//   - 业务结果（成功 / 错误信封 / 红标）一律 HTTP 200（错误码在 body 的 error 字段）。
//   - demo=true  → 零网络、始终返回 server/demo-fixtures.json 的确定性内容（即使配置了 key）。
//   - demo=false → await ask(body, { config })；未配置 LLM 时其内部先返回 provider_not_configured，零外呼。
//
// 本文件遵循 server/tsconfig.json 约束：可擦除语法（无 enum/namespace/参数属性）、
// 相对导入写显式 .ts 扩展名、仅类型导入使用 `import type`。

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.ts';
import type { ServerConfig } from './config.ts';
import { ask } from './orchestrator.ts';
import type { AskRequest, AskResponse } from './orchestrator.ts';
import { extractMemory } from './extract-memory.ts';
import type { ExtractRequest, ExtractResponse } from './extract-memory.ts';
import { interview } from './interview.ts';
import type { InterviewRequest, InterviewResponse } from './interview.ts';
import { LIMITS } from './prompts.ts';
import type { ConsultResult, OrganizeResult } from './validate.ts';
import type { SearchResult } from './providers/search.ts';
import { detectRedFlag } from './redflags.ts';

/** 仅本机监听。不要改成 0.0.0.0，也不要省略 host。 */
const HOST = '127.0.0.1';

/** POST /api/ask 请求体上限（字节）。超限直接 413，不读取更多数据。 */
const MAX_BODY_BYTES = 64 * 1024;

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_PATH = resolve(__dirname, 'demo-fixtures.json');

// ---------------------------------------------------------------------------
// 演示 fixtures（启动时一次性读取；内容确定性，无时间戳）
// ---------------------------------------------------------------------------

type DemoRedFlag = {
  redFlag: true;
  safetyNotice: string;
  disclaimer: string;
};

type ConsultFixture = {
  sources: SearchResult[];
  response: ConsultResult;
};

type DemoFixtures = {
  redflag: DemoRedFlag;
  organize: OrganizeResult;
  organizeMinimal: OrganizeResult;
  consult: ConsultFixture;
  extractMemory: { candidates: { text: string }[] };
  interview: { question: { text: string; slot: string } };
};

const FIXTURES = JSON.parse(readFileSync(FIXTURES_PATH, 'utf8')) as DemoFixtures;

// ---------------------------------------------------------------------------
// 健康检查派生字段（只反映“是否配置了 key”，绝不回显 key 本身）
// ---------------------------------------------------------------------------

function hasKey(value: string): boolean {
  return value.trim().length > 0;
}

function buildHealth(config: ServerConfig): {
  ok: true;
  providerReady: boolean;
  searchReady: boolean;
  demo: boolean;
} {
  return {
    ok: true,
    providerReady: hasKey(config.llm.apiKey),
    searchReady: hasKey(config.search.apiKey),
    demo: config.demo,
  };
}

// ---------------------------------------------------------------------------
// 请求体读取（带上限）
// ---------------------------------------------------------------------------

type ReadBodyResult =
  | { ok: true; text: string }
  | { ok: false; reason: 'payload_too_large' | 'read_error' };

function readBody(req: IncomingMessage): Promise<ReadBodyResult> {
  return new Promise((resolveBody) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const settle = (result: ReadBodyResult): void => {
      if (settled) return;
      settled = true;
      resolveBody(result);
    };

    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // 停止消费但绝不 req.destroy()：同步销毁 socket 会让调用方在 413 信封写出前收到连接重置。
        settle({ ok: false, reason: 'payload_too_large' });
        req.pause();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      settle({ ok: true, text: Buffer.concat(chunks).toString('utf8') });
    });
    req.on('error', () => {
      settle({ ok: false, reason: 'read_error' });
    });
  });
}

// ---------------------------------------------------------------------------
// demo 分支：请求 → fixtures（确定性映射，零网络）
//
//   1) consent !== true           → {error:'consent_required'}
//   2) mode 非 organize/consult   → {error:'invalid_mode'}
//   3) messages 非数组 / 非对象项 → {error:'invalid_request'}
//   4) 本地 detectRedFlag 扫描 user 消息命中 → redflag fixture（模式无关）
//   5) mode=organize：无任何非空 user 文本 → organizeMinimal fixture；否则 organize fixture
//   6) mode=consult → consult.response fixture
//
// 全程不联网，且优先于真实上游（即使配置了 key）。
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function resolveDemoResponse(raw: unknown): unknown {
  if (!isObject(raw)) {
    return { error: 'invalid_request', message: '请求体必须为对象' };
  }
  if (raw.consent !== true) {
    return { error: 'consent_required', message: '缺少用户同意（consent 必须为 true）' };
  }
  if (raw.mode !== 'organize' && raw.mode !== 'consult') {
    return { error: 'invalid_mode', message: 'mode 必须为 organize 或 consult' };
  }
  const messages = raw.messages;
  if (!Array.isArray(messages)) {
    return { error: 'invalid_request', message: 'messages 必须为消息数组' };
  }

  const userTexts: string[] = [];
  for (const item of messages) {
    if (!isObject(item)) {
      return { error: 'invalid_request', message: 'messages 项必须为对象' };
    }
    if (item.role === 'user' && typeof item.content === 'string') {
      userTexts.push(item.content);
    }
  }

  if (detectRedFlag(userTexts).hit) {
    return FIXTURES.redflag;
  }
  if (raw.mode === 'organize') {
    const hasUserText = userTexts.some((text) => text.trim() !== '');
    return hasUserText ? FIXTURES.organize : FIXTURES.organizeMinimal;
  }
  return FIXTURES.consult.response;
}

// ---------------------------------------------------------------------------
// demo 分支（记忆提炼）：请求 → fixtures（确定性，零网络）
//
//   1) consent !== true                       → {candidates:[], reason:'consent_required'}
//   2) messages 非非空数组 / 项非法            → {candidates:[], reason:'invalid_request'}
//   3) maxItems 显式非法（非正数）             → {candidates:[], reason:'invalid_request'}
//   4) 否则返回 extractMemory.candidates（有 maxItems 时按 ≤3 夹取后切片）
// ---------------------------------------------------------------------------

const MAX_EXTRACT_ITEMS = 3;

function resolveDemoExtractResponse(raw: unknown): unknown {
  if (!isObject(raw)) {
    return { candidates: [], reason: 'invalid_request' };
  }
  if (raw.consent !== true) {
    return { candidates: [], reason: 'consent_required' };
  }
  const messages = raw.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return { candidates: [], reason: 'invalid_request' };
  }
  for (const item of messages) {
    if (!isObject(item) || typeof item.role !== 'string' || typeof item.content !== 'string') {
      return { candidates: [], reason: 'invalid_request' };
    }
  }
  const candidates = FIXTURES.extractMemory.candidates;
  if (raw.maxItems === undefined) return { candidates };
  if (typeof raw.maxItems !== 'number' || !Number.isFinite(raw.maxItems) || raw.maxItems <= 0) {
    return { candidates: [], reason: 'invalid_request' };
  }
  const limit = Math.min(Math.floor(raw.maxItems), MAX_EXTRACT_ITEMS);
  return { candidates: candidates.slice(0, limit) };
}

// ---------------------------------------------------------------------------
// demo 分支（问诊引导）：请求 → fixtures（确定性，零网络）
//
//   1) consent !== true                              → {status:'failed', reason:'consent_required'}
//   2) messages 非非空数组 / 项非法 / round 显式非法   → {status:'failed', reason:'invalid_request'}
//   3) 本地 detectRedFlag 扫描 user 消息命中           → redflag fixture（零网络）
//   4) round >= LIMITS.maxInterviewQuestions          → {status:'done'}
//   5) 否则 → {status:'ask', question: interview.question fixture}
// ---------------------------------------------------------------------------

function resolveDemoInterviewResponse(raw: unknown): unknown {
  if (!isObject(raw)) return { status: 'failed', reason: 'invalid_request' };
  if (raw.consent !== true) return { status: 'failed', reason: 'consent_required' };
  const messages = raw.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return { status: 'failed', reason: 'invalid_request' };
  }
  for (const item of messages) {
    if (!isObject(item) || typeof item.role !== 'string' || typeof item.content !== 'string') {
      return { status: 'failed', reason: 'invalid_request' };
    }
  }

  const userTexts: string[] = [];
  let assistantTurns = 0;
  for (const item of messages) {
    if (item.role === 'user' && typeof item.content === 'string') userTexts.push(item.content);
    if (item.role === 'assistant') assistantTurns += 1;
  }

  let round: number;
  if (raw.round === undefined) {
    round = assistantTurns;
  } else if (typeof raw.round === 'number' && Number.isFinite(raw.round) && raw.round >= 0) {
    round = Math.floor(raw.round);
  } else {
    return { status: 'failed', reason: 'invalid_request' };
  }

  if (detectRedFlag(userTexts).hit) return FIXTURES.redflag;
  if (round >= LIMITS.maxInterviewQuestions) return { status: 'done' };
  return { status: 'ask', question: FIXTURES.interview.question };
}

// ---------------------------------------------------------------------------
// HTTP 处理
// ---------------------------------------------------------------------------

function applyCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  // devtools 的 Origin 形如 http://127.0.0.1:<port>；有则回显，无则用通配。
  res.setHeader(
    'Access-Control-Allow-Origin',
    typeof origin === 'string' && origin.length > 0 ? origin : '*'
  );
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

/** 超限响应：显式 Connection: close，确保 413 信封在未读请求体被丢弃、连接关闭前送达客户端。 */
function sendPayloadTooLarge(res: ServerResponse): void {
  res.setHeader('Connection', 'close');
  sendJson(res, 413, {
    error: 'payload_too_large',
    message: `请求体超过 ${MAX_BODY_BYTES} 字节上限`,
  });
}

async function handleAsk(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  if (!body.ok) {
    if (body.reason === 'payload_too_large') {
      sendPayloadTooLarge(res);
    } else {
      sendJson(res, 400, { error: 'invalid_request', message: '无法读取请求体' });
    }
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.text) as unknown;
  } catch {
    sendJson(res, 400, { error: 'invalid_request', message: '请求体不是合法 JSON' });
    return;
  }

  try {
    if (config.demo) {
      sendJson(res, 200, resolveDemoResponse(parsed));
      return;
    }
    const response: AskResponse = await ask(parsed as AskRequest, { config });
    sendJson(res, 200, response);
  } catch {
    // ask() 契约上绝不抛异常；此兜底仅防御装配层自身错误。
    sendJson(res, 500, { error: 'internal_error', message: '内部错误：请求处理失败' });
  }
}

async function handleExtractMemory(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  if (!body.ok) {
    if (body.reason === 'payload_too_large') {
      sendPayloadTooLarge(res);
    } else {
      sendJson(res, 400, { error: 'invalid_request', message: '无法读取请求体' });
    }
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.text) as unknown;
  } catch {
    sendJson(res, 400, { error: 'invalid_request', message: '请求体不是合法 JSON' });
    return;
  }

  try {
    if (config.demo) {
      sendJson(res, 200, resolveDemoExtractResponse(parsed));
      return;
    }
    const response: ExtractResponse = await extractMemory(parsed as ExtractRequest, { config });
    sendJson(res, 200, response);
  } catch {
    // extractMemory() 契约上绝不抛异常；此兜底仅防御装配层自身错误。
    sendJson(res, 500, { candidates: [], reason: 'internal_error' });
  }
}

async function handleInterview(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  if (!body.ok) {
    if (body.reason === 'payload_too_large') {
      sendPayloadTooLarge(res);
    } else {
      sendJson(res, 400, { status: 'failed', reason: 'invalid_request' });
    }
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.text) as unknown;
  } catch {
    sendJson(res, 400, { status: 'failed', reason: 'invalid_request' });
    return;
  }

  try {
    if (config.demo) {
      sendJson(res, 200, resolveDemoInterviewResponse(parsed));
      return;
    }
    const response: InterviewResponse = await interview(parsed as InterviewRequest, { config });
    sendJson(res, 200, response);
  } catch {
    // interview() 契约上绝不抛异常；此兜底仅防御装配层自身错误。
    sendJson(res, 500, { status: 'failed', reason: 'internal_error' });
  }
}

// ---------------------------------------------------------------------------
// 配置与监听
// ---------------------------------------------------------------------------

// MHP_CONFIG_PATH 覆盖仅供测试：spawn 时指向临时配置，绝不改写仓库 server/config.json。
const config = loadConfig(process.env.MHP_CONFIG_PATH);
const health = buildHealth(config);

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  applyCors(req, res);

  const method = req.method ?? 'GET';
  const path = new URL(req.url ?? '/', `http://${HOST}`).pathname;

  // 预检请求：直接 204。
  if (method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (path === '/api/health') {
    if (method !== 'GET') {
      sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
      return;
    }
    sendJson(res, 200, health);
    return;
  }

  if (path === '/api/ask') {
    if (method !== 'POST') {
      sendJson(res, 405, { error: 'method_not_allowed' });
      return;
    }
    void handleAsk(req, res);
    return;
  }

  if (path === '/api/extract-memory') {
    if (method !== 'POST') {
      sendJson(res, 405, { error: 'method_not_allowed' });
      return;
    }
    void handleExtractMemory(req, res);
    return;
  }

  if (path === '/api/interview') {
    if (method !== 'POST') {
      sendJson(res, 405, { error: 'method_not_allowed' });
      return;
    }
    void handleInterview(req, res);
    return;
  }

  sendJson(res, 404, { ok: false, error: 'not_found', path });
});

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

function shutdown(signal: string): void {
  console.log(`[server] 收到 ${signal}，正在关闭…`);
  server.close(() => {
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

server.on('error', (err: NodeJS.ErrnoException) => {
  const hint =
    err.code === 'EADDRINUSE'
      ? `端口 ${config.port} 已被占用，请修改 server/config.json 的 port 后重试。`
      : '请检查 server/config.json 与运行环境。';
  console.error(`[server] 启动失败：${err.code ?? 'ERROR'} ${err.message}\n${hint}`);
  process.exit(1);
});

server.listen(config.port, HOST, () => {
  const address = server.address();
  const actualPort =
    address !== null && typeof address === 'object' ? address.port : config.port;
  // 启动日志只打印端口与布尔模式标记；绝不打印 apiKey。
  console.log(`[server] 监听 http://${HOST}:${actualPort}`);
  console.log(
    `[server] demo=${health.demo} providerReady=${health.providerReady} searchReady=${health.searchReady}`
  );
  console.log(`[server] 仅本机可访问（${HOST}）；CORS 允许本地 devtools；不记录请求内容。`);
});
