#!/usr/bin/env node
// server/index.ts
// 本地 AI 代理 —— HTTP 装配层。
//
// 目标：
//   - 仅绑定 127.0.0.1（本机回环），绝不对外网暴露。
//   - 零依赖：只用 Node 内置模块（node:http / node:fs / node:path / node:url）。
//   - GET  /api/health          返回 { ok, providerReady, searchReady, demo, demoMode }。
//   - POST /api/ask             薄处理器：demo 分支零网络返回 fixtures；否则委托 orchestrator。
//   - POST /api/extract-memory  薄处理器：demo 分支零网络返回 fixtures；否则委托 extract-memory。
//   - POST /api/interview       薄处理器：demo 分支零网络返回 fixtures；否则委托 interview。
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
//   - demo=false → await ask(body, { config, signal, deadlineAt })；未配置 LLM 时其内部先返回 provider_not_configured，零外呼。
//
// 总预算（P0-4）：
//   - 每个路由都受 TOTAL_DEADLINE_MS 总预算约束；超时返回 504 {ok:false, error:'deadline_exceeded'}。
//   - req 关闭（客户端断连）→ AbortController.abort()，把取消一路传到搜索 / LLM（P1-22）。
//
// 边界（P1-29）：CORS 仅允许本地回环 Origin（或 config.corsOrigins 显式清单）；
//   Host 头必须是本机；POST JSON 路由要求 Content-Type: application/json。
//
// 本文件遵循 server/tsconfig.json 约束：可擦除语法（无 enum/namespace/参数属性）、
// 相对导入写显式 .ts 扩展名、仅类型导入使用 `import type`。

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isLlmConfigured, isSearchConfigured, loadConfig, resolveTotalDeadlineMs } from './config.ts';
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

/** 允许非回环但显式放行的 Origin host（微信开发者工具 / 关联域）。 */
const WECHAT_ORIGIN_SUFFIXES: readonly string[] = ['servicewechat.com', 'qq.com'];

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
// 健康检查派生字段（只反映“是否可用”，绝不回显 key 本身）
// ---------------------------------------------------------------------------

function buildHealth(config: ServerConfig): {
  ok: true;
  providerReady: boolean;
  searchReady: boolean;
  demo: boolean;
  demoMode: boolean;
} {
  return {
    ok: true,
    providerReady: isLlmConfigured(config.llm),
    searchReady: isSearchConfigured(config.search),
    demo: config.demo,
    demoMode: config.demo,
  };
}

// ---------------------------------------------------------------------------
// 请求体读取（带上限；413 时排空并摘除监听器，P1-25）
// ---------------------------------------------------------------------------

type ReadBodyResult =
  | { ok: true; text: string }
  | { ok: false; reason: 'payload_too_large' | 'read_error' | 'deadline_exceeded' };

/**
 * 读取请求体（带上限与总预算）。
 * 预算从请求派发时开始计时：慢速上传同样消耗 TOTAL_DEADLINE_MS，超预算 → deadline_exceeded。
 */
function readBody(req: IncomingMessage, deadlineAt: number): Promise<ReadBodyResult> {
  return new Promise((resolveBody) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const settle = (result: ReadBodyResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      resolveBody(result);
    };

    const onData = (chunk: Buffer): void => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        settle({ ok: false, reason: 'payload_too_large' });
        // 通过 settle 已摘除 data/end 监听器；保留 error 监听器（onError 会重新入队，settle 幂等），
        // 再排空剩余字节，避免 413 信封送达前连接被未读数据阻塞。
        req.resume();
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      settle({ ok: true, text: Buffer.concat(chunks).toString('utf8') });
    };
    const onError = (): void => {
      settle({ ok: false, reason: 'read_error' });
    };

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);

    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) {
      settle({ ok: false, reason: 'deadline_exceeded' });
      req.resume();
      return;
    }
    timer = setTimeout(() => {
      settle({ ok: false, reason: 'deadline_exceeded' });
      req.resume();
    }, remaining);
    timer.unref();
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
// ---------------------------------------------------------------------------

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
  const limit = Math.min(Math.floor(raw.maxItems), LIMITS.maxExtractItems);
  return { candidates: candidates.slice(0, limit) };
}

// ---------------------------------------------------------------------------
// demo 分支（问诊引导）：请求 → fixtures（确定性，零网络）
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
// CORS / Host（P1-29）
// ---------------------------------------------------------------------------

function hostnameOf(value: string): string {
  try {
    const withScheme = value.includes('://') ? value : `http://${value}`;
    return new URL(withScheme).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function isLocalHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

function isAllowedOrigin(origin: string, config: ServerConfig): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const hostname = parsed.hostname.toLowerCase();
  if (isLocalHostname(hostname)) return true;
  if (config.corsOrigins.includes(origin)) return true;
  return WECHAT_ORIGIN_SUFFIXES.some(
    (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`)
  );
}

/** 只对允许的 Origin 回显 ACAO；非白名单 Origin 不回显（浏览器据此拦截）。 */
function applyCors(req: IncomingMessage, res: ServerResponse, config: ServerConfig): void {
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin.length > 0 && isAllowedOrigin(origin, config)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function isLocalHostHeader(hostHeader: string | undefined): boolean {
  if (typeof hostHeader !== 'string' || hostHeader === '') return false;
  return isLocalHostname(hostnameOf(hostHeader));
}

function hasJsonContentType(req: IncomingMessage): boolean {
  const value = req.headers['content-type'];
  return typeof value === 'string' && value.toLowerCase().includes('application/json');
}

// ---------------------------------------------------------------------------
// HTTP 处理
// ---------------------------------------------------------------------------

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

type RouteOutcome<T> = { kind: 'value'; value: T } | { kind: 'error' } | { kind: 'deadline' };

/**
 * 在总预算内执行路由，并把取消信号一路传到上游：
 *   - 预算截止时间在请求派发时计算（含 body 读取），调用方传入绝对 `deadlineAt`；
 *   - req 关闭（客户端断连）→ abort；
 *   - 超过 deadlineAt → abort + 返回 {kind:'deadline'}（调用方回 504）。
 */
async function executeRoute<T>(
  req: IncomingMessage,
  res: ServerResponse,
  deadlineAt: number,
  run: (signal: AbortSignal, deadlineAt: number) => Promise<T>
): Promise<RouteOutcome<T>> {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) return { kind: 'deadline' };
  const controller = new AbortController();
  const onClose = (): void => {
    if (!res.writableEnded) controller.abort();
  };
  req.on('close', onClose);

  let timer: NodeJS.Timeout | undefined;
  const deadlinePromise = new Promise<RouteOutcome<T>>((resolveOutcome) => {
    timer = setTimeout(() => {
      controller.abort();
      resolveOutcome({ kind: 'deadline' });
    }, remaining);
    timer.unref();
  });
  const runPromise = run(controller.signal, deadlineAt).then(
    (value) => ({ kind: 'value', value }) as RouteOutcome<T>,
    () => ({ kind: 'error' }) as RouteOutcome<T>
  );

  try {
    const outcome = await Promise.race([runPromise, deadlinePromise]);
    if (outcome.kind === 'value' && Date.now() >= deadlineAt) {
      return { kind: 'deadline' };
    }
    return outcome;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    req.removeListener('close', onClose);
  }
}

const DEADLINE_BODY = { ok: false, error: 'deadline_exceeded' } as const;

async function parseBodyJson(req: IncomingMessage, res: ServerResponse, errorBody: unknown, deadlineAt: number): Promise<unknown | null> {
  const body = await readBody(req, deadlineAt);
  if (!body.ok) {
    if (body.reason === 'payload_too_large') sendPayloadTooLarge(res);
    else if (body.reason === 'deadline_exceeded') sendJson(res, 504, DEADLINE_BODY);
    else sendJson(res, 400, errorBody);
    return null;
  }
  try {
    return JSON.parse(body.text) as unknown;
  } catch {
    sendJson(res, 400, errorBody);
    return null;
  }
}

async function handleAsk(req: IncomingMessage, res: ServerResponse, deadlineAt: number): Promise<void> {
  const parsed = await parseBodyJson(req, res, { error: 'invalid_request', message: '请求体不是合法 JSON' }, deadlineAt);
  if (parsed === null) return;

  if (config.demo) {
    sendJson(res, 200, resolveDemoResponse(parsed));
    return;
  }
  const outcome = await executeRoute<AskResponse>(req, res, deadlineAt, (signal, runDeadlineAt) =>
    ask(parsed as AskRequest, { config, signal, deadlineAt: runDeadlineAt })
  );
  if (outcome.kind === 'deadline') {
    sendJson(res, 504, DEADLINE_BODY);
    return;
  }
  if (outcome.kind === 'error') {
    sendJson(res, 500, { error: 'internal_error', message: '内部错误：请求处理失败' });
    return;
  }
  sendJson(res, 200, outcome.value);
}

async function handleExtractMemory(req: IncomingMessage, res: ServerResponse, deadlineAt: number): Promise<void> {
  const parsed = await parseBodyJson(req, res, { candidates: [], reason: 'invalid_request' }, deadlineAt);
  if (parsed === null) return;

  if (config.demo) {
    sendJson(res, 200, resolveDemoExtractResponse(parsed));
    return;
  }
  const outcome = await executeRoute<ExtractResponse>(req, res, deadlineAt, (signal, runDeadlineAt) =>
    extractMemory(parsed as ExtractRequest, { config, signal, deadlineAt: runDeadlineAt })
  );
  if (outcome.kind === 'deadline') {
    sendJson(res, 504, DEADLINE_BODY);
    return;
  }
  if (outcome.kind === 'error') {
    sendJson(res, 500, { candidates: [], reason: 'internal_error' });
    return;
  }
  sendJson(res, 200, outcome.value);
}

async function handleInterview(req: IncomingMessage, res: ServerResponse, deadlineAt: number): Promise<void> {
  const parsed = await parseBodyJson(req, res, { status: 'failed', reason: 'invalid_request' }, deadlineAt);
  if (parsed === null) return;

  if (config.demo) {
    sendJson(res, 200, resolveDemoInterviewResponse(parsed));
    return;
  }
  const outcome = await executeRoute<InterviewResponse>(req, res, deadlineAt, (signal, runDeadlineAt) =>
    interview(parsed as InterviewRequest, { config, signal, deadlineAt: runDeadlineAt })
  );
  if (outcome.kind === 'deadline') {
    sendJson(res, 504, DEADLINE_BODY);
    return;
  }
  if (outcome.kind === 'error') {
    sendJson(res, 500, { status: 'failed', reason: 'internal_error' });
    return;
  }
  sendJson(res, 200, outcome.value);
}

// ---------------------------------------------------------------------------
// 配置与监听
// ---------------------------------------------------------------------------

// MHP_CONFIG_PATH 覆盖仅供测试：spawn 时指向临时配置，绝不改写仓库 server/config.json。
const config = loadConfig(process.env.MHP_CONFIG_PATH);
const health = buildHealth(config);

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  let path: string;
  try {
    path = new URL(req.url ?? '/', `http://${HOST}`).pathname;
  } catch {
    sendJson(res, 400, { ok: false, error: 'invalid_request' });
    return;
  }

  applyCors(req, res, config);

  const method = req.method ?? 'GET';
  if (method === 'OPTIONS') {
    const origin = req.headers.origin;
    if (typeof origin === 'string' && origin.length > 0 && !isAllowedOrigin(origin, config)) {
      sendJson(res, 403, { ok: false, error: 'forbidden_origin' });
      return;
    }
    res.statusCode = 204;
    res.end();
    return;
  }

  if (!isLocalHostHeader(req.headers.host)) {
    sendJson(res, 403, { ok: false, error: 'forbidden_host' });
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

  if (path === '/api/ask' || path === '/api/extract-memory' || path === '/api/interview') {
    if (method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
      return;
    }
    if (!hasJsonContentType(req)) {
      sendJson(res, 415, { ok: false, error: 'unsupported_media_type' });
      return;
    }
    // 总预算在派发时一次性确定（早于 readBody/JSON 解析）：慢速上传同样消耗该预算。
    const deadlineAt = Date.now() + resolveTotalDeadlineMs();
    if (path === '/api/ask') void handleAsk(req, res, deadlineAt);
    else if (path === '/api/extract-memory') void handleExtractMemory(req, res, deadlineAt);
    else void handleInterview(req, res, deadlineAt);
    return;
  }

  sendJson(res, 404, { ok: false, error: 'not_found', path });
});

server.keepAliveTimeout = 5000;
server.headersTimeout = 10000;
// 环境感知（MHP_TOTAL_DEADLINE_MS）的预算 + 10s 余量，与 executeRoute 使用同一解析器。
server.requestTimeout = resolveTotalDeadlineMs() + 10000;

// ---------------------------------------------------------------------------
// 生命周期（P1-24：closeAllConnections + 兜底定时器）
// ---------------------------------------------------------------------------

function shutdown(signal: string): void {
  console.log(`[server] 收到 ${signal}，正在关闭…`);
  const force = setTimeout(() => {
    console.error('[server] 关闭超时，强制退出。');
    process.exit(1);
  }, 3000);
  force.unref();
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  server.close(() => {
    clearTimeout(force);
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
