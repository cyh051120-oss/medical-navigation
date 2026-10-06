// server/providers/llm.ts
// OpenAI 兼容 LLM 适配器（任务 23）。
//
// 契约：
//   chat(messages, options) -> Promise<ChatResult>
//   - 调用 POST {baseUrl}/chat/completions；apiKey 非空时带 `Authorization: Bearer <key>`。
//   - 支持非流式 JSON 与流式 SSE（`data:` 帧，以 `data: [DONE]` 结束）。
//   - 超时通过 AbortController 实现；默认 30000ms，可用 options.timeoutMs 覆盖。
//   - 重试：默认最多 1 次（即最多 2 次尝试），可用 options.maxRetries 覆盖。
//       可重试：网络错误 / 超时 / 上游 5xx。
//       不重试：配置错误（invalid_config）/ 4xx / 响应格式错误（invalid_response）/ 调用方取消（aborted）。
//   - 流式一旦已向上层发出增量（onDelta 触发过），失败后不再重试，避免内容重复。
//   - 错误归一化为 LlmError 实例：{ code, message }（code 为稳定机器码，见 LlmErrorCode）。
//   - 隐私：绝不写盘、绝不打印任何请求内容（messages / body / apiKey）。
//   - 配置驱动：调用方从 server/config.json 的 llm.{baseUrl,apiKey,model} 构造 options.config，
//     换厂商只需改 JSON，无需改代码。
//
// 仅使用 Node 内置全局 fetch / AbortController / TextDecoder，零运行时依赖（Node >= 24）。
// 约束：可擦除语法（无 enum/namespace/参数属性）；仅类型导入使用 `import type`。

import type { LlmConfig } from '../config.ts';

export type ChatRole = 'system' | 'user' | 'assistant';

export type ChatMessage = {
  role: ChatRole;
  content: string;
};

/** 稳定机器码；上层据此分支处理。 */
export type LlmErrorCode =
  | 'invalid_config'
  | 'network_error'
  | 'timeout'
  | 'aborted'
  | 'upstream_error'
  | 'invalid_response';

/** 归一化错误：`{ code, message }` 是稳定契约；`retryable` 供内部重试判定。 */
export class LlmError extends Error {
  readonly code: LlmErrorCode;
  readonly retryable: boolean;

  constructor(code: LlmErrorCode, message: string, retryable: boolean) {
    super(message);
    this.name = 'LlmError';
    this.code = code;
    this.retryable = retryable;
  }
}

export type ChatUsage = {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
};

export type ChatResult = {
  content: string;
  model: string;
  finishReason: string | null;
  usage: ChatUsage | null;
  streamed: boolean;
};

export type ChatOptions = {
  /** 上游配置（来自 server/config.json 的 llm 段）。 */
  config: LlmConfig;
  /** true = 流式（SSE）；默认 false。 */
  stream?: boolean;
  /** 流式增量回调；每收到一个增量调用一次。 */
  onDelta?: (delta: string) => void;
  /** 覆盖 config.model。 */
  model?: string;
  temperature?: number;
  /** 映射到请求体 max_tokens。 */
  maxTokens?: number;
  /** 单次尝试超时（毫秒）；默认 60000（推理型模型单次响应常 20–50s）。 */
  timeoutMs?: number;
  /** 最多重试次数；默认 1。 */
  maxRetries?: number;
  /** 调用方取消信号；与内部超时信号合并。 */
  signal?: AbortSignal;
};

const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_MAX_RETRIES = 1;

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseUsage(value: unknown): ChatUsage | null {
  const usage = asRecord(value);
  if (Object.keys(usage).length === 0) return null;
  return {
    promptTokens: asFiniteNumber(usage.prompt_tokens),
    completionTokens: asFiniteNumber(usage.completion_tokens),
    totalTokens: asFiniteNumber(usage.total_tokens),
  };
}

function endpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * 把 fetch / 流读取抛出的底层异常归一化为 LlmError。
 * 注意：先判定超时与调用方取消，再归为网络错误。
 */
function mapTransportError(err: unknown, timedOut: boolean, callerAborted: boolean): LlmError {
  if (err instanceof LlmError) return err;
  if (timedOut) return new LlmError('timeout', '请求超时', true);
  if (callerAborted) return new LlmError('aborted', '请求已被调用方取消', false);
  const detail = err instanceof Error ? err.message : String(err);
  return new LlmError('network_error', `网络请求失败：${truncate(detail, 200)}`, true);
}

// ---------------------------------------------------------------------------
// 响应解析
// ---------------------------------------------------------------------------

async function parseJsonResponse(res: Response, fallbackModel: string): Promise<ChatResult> {
  let data: unknown;
  try {
    data = (await res.json()) as unknown;
  } catch {
    throw new LlmError('invalid_response', '上游响应不是合法 JSON', false);
  }
  const root = asRecord(data);
  const choices = Array.isArray(root.choices) ? root.choices : [];
  const first = asRecord(choices[0]);
  const message = asRecord(first.message);
  const content = typeof message.content === 'string' ? message.content : null;
  if (content === null) {
    throw new LlmError('invalid_response', '上游响应缺少 choices[0].message.content', false);
  }
  return {
    content,
    model: typeof root.model === 'string' && root.model !== '' ? root.model : fallbackModel,
    finishReason: typeof first.finish_reason === 'string' ? first.finish_reason : null,
    usage: parseUsage(root.usage),
    streamed: false,
  };
}

async function parseSseResponse(
  res: Response,
  fallbackModel: string,
  onDelta: ((delta: string) => void) | undefined
): Promise<ChatResult> {
  if (res.body === null) {
    throw new LlmError('invalid_response', '上游流式响应为空', false);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let model = '';
  let finishReason: string | null = null;
  let sawDone = false;
  let sawInvalidFrame = false;

  const handleLine = (rawLine: string): void => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!line.startsWith('data:')) return; // 忽略注释行 / 其它 SSE 字段
    const payload = line.slice(5).trim();
    if (payload === '') return;
    if (payload === '[DONE]') {
      sawDone = true;
      return;
    }
    let chunk: unknown;
    try {
      chunk = JSON.parse(payload) as unknown;
    } catch {
      sawInvalidFrame = true;
      return;
    }
    const root = asRecord(chunk);
    if (typeof root.model === 'string' && root.model !== '') model = root.model;
    const choices = Array.isArray(root.choices) ? root.choices : [];
    const first = asRecord(choices[0]);
    if (typeof first.finish_reason === 'string') finishReason = first.finish_reason;
    const delta = asRecord(first.delta);
    const piece = typeof delta.content === 'string' ? delta.content : '';
    if (piece !== '') {
      content += piece;
      if (onDelta !== undefined) onDelta(piece);
    }
  };

  try {
    while (!sawDone) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex = buffer.indexOf('\n');
      while (!sawDone && newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        handleLine(line);
        newlineIndex = buffer.indexOf('\n');
      }
    }
    // 冲刷解码器缓冲与最后一行（无尾随换行时）。
    buffer += decoder.decode();
    if (!sawDone && buffer.length > 0) handleLine(buffer);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // 释放失败可忽略（连接可能已被上游关闭）。
    }
  }

  if (sawInvalidFrame) {
    throw new LlmError('invalid_response', '流式响应包含无法解析的 data 帧', false);
  }
  if (!sawDone) {
    throw new LlmError('invalid_response', '流式响应未以 [DONE] 结束', false);
  }
  return {
    content,
    model: model !== '' ? model : fallbackModel,
    finishReason,
    usage: null,
    streamed: true,
  };
}

// ---------------------------------------------------------------------------
// 单次尝试
// ---------------------------------------------------------------------------

async function attemptChat(
  messages: ChatMessage[],
  options: ChatOptions,
  onDelta: ((delta: string) => void) | undefined
): Promise<ChatResult> {
  const cfg = options.config;
  const baseUrl = cfg.baseUrl.trim();
  const model = (options.model ?? cfg.model).trim();

  if (baseUrl === '') {
    throw new LlmError('invalid_config', 'LLM baseUrl 未配置', false);
  }
  if (model === '') {
    throw new LlmError('invalid_config', 'LLM model 未配置', false);
  }

  const stream = options.stream === true;
  const timeoutMs =
    typeof options.timeoutMs === 'number' && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_TIMEOUT_MS;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.apiKey.trim() !== '') {
    headers.Authorization = `Bearer ${cfg.apiKey.trim()}`;
  }
  if (stream) {
    headers.Accept = 'text/event-stream';
  }

  const payload: Record<string, unknown> = { model, messages, stream };
  if (typeof options.temperature === 'number') payload.temperature = options.temperature;
  if (typeof options.maxTokens === 'number') payload.max_tokens = options.maxTokens;
  const body = JSON.stringify(payload);

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onCallerAbort = (): void => controller.abort();
  if (options.signal !== undefined) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener('abort', onCallerAbort, { once: true });
  }

  try {
    let res: Response;
    try {
      res = await fetch(endpoint(baseUrl), {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });
    } catch (err) {
      throw mapTransportError(err, timedOut, options.signal?.aborted === true);
    }

    if (!res.ok) {
      // 不回显上游响应体（可能包含提示词回显）；仅归一化状态。
      throw new LlmError('upstream_error', `上游服务返回 HTTP ${res.status}`, res.status >= 500);
    }

    try {
      return stream
        ? await parseSseResponse(res, model, onDelta)
        : await parseJsonResponse(res, model);
    } catch (err) {
      throw mapTransportError(err, timedOut, options.signal?.aborted === true);
    }
  } finally {
    clearTimeout(timer);
    if (options.signal !== undefined) {
      options.signal.removeEventListener('abort', onCallerAbort);
    }
  }
}

// ---------------------------------------------------------------------------
// 公开 API
// ---------------------------------------------------------------------------

/**
 * 调用 OpenAI 兼容的 `/chat/completions`。
 *
 * @param messages 对话消息；不得为空。
 * @param options  配置（必填）+ 流式 / 超时 / 重试等。
 * @returns ChatResult（含 content / model / finishReason / streamed）。
 * @throws LlmError 归一化错误（`{ code, message }`）。
 */
export async function chat(messages: ChatMessage[], options: ChatOptions): Promise<ChatResult> {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new LlmError('invalid_config', 'messages 不能为空', false);
  }

  const maxRetries =
    typeof options.maxRetries === 'number' &&
    Number.isInteger(options.maxRetries) &&
    options.maxRetries >= 0
      ? options.maxRetries
      : DEFAULT_MAX_RETRIES;
  const attempts = maxRetries + 1;

  // 流式重试保护：一旦向调用方发出过增量，就不可重放，避免内容重复。
  let emittedDelta = false;
  const onDelta =
    options.stream === true && options.onDelta !== undefined
      ? (delta: string): void => {
          emittedDelta = true;
          options.onDelta?.(delta);
        }
      : options.onDelta;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await attemptChat(messages, options, onDelta);
    } catch (err) {
      const normalized =
        err instanceof LlmError
          ? err
          : new LlmError('network_error', '请求失败（未知错误）', true);
      const isLastAttempt = attempt >= attempts - 1;
      if (!normalized.retryable || isLastAttempt || emittedDelta) {
        throw normalized;
      }
      // 否则进行下一次（唯一一次）尝试。
    }
  }

  // 理论不可达：循环内要么 return，要么 throw。
  throw new LlmError('network_error', '请求失败', false);
}
