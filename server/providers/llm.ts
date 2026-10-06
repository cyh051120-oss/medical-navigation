// server/providers/llm.ts
// OpenAI 兼容 LLM 适配器（任务 23；P0-4/P1-23/P1-39 修订）。
//
// 契约：
//   chat(messages, options) -> Promise<ChatResult>
//   - 调用 POST {baseUrl}/chat/completions；apiKey 非空时带 `Authorization: Bearer <key>`。
//   - 仅支持非流式 JSON（SSE 流式实现无产品消费者，已移除，见报告 SERVER.md）。
//   - 超时通过 AbortController 实现；单次尝试预算 = min(options.timeoutMs ?? 60000, 剩余总预算)。
//   - 重试：默认最多 1 次（即最多 2 次尝试），可用 options.maxRetries 覆盖。
//       可重试：网络错误 / 超时 / 上游 5xx。剩余预算不足时不再重试。
//       不重试：配置错误（invalid_config）/ 4xx / 响应格式错误（invalid_response）/ 调用方取消（aborted）。
//   - 非 2xx 响应体一律消费/取消后再返回，避免 undici 连接不归还连接池（P1-23）。
//   - 错误归一化为 LlmError 实例：{ code, message }（code 为稳定机器码，见 LlmErrorCode）。
//   - 隐私：绝不写盘、绝不打印任何请求内容（messages / body / apiKey）。
//   - 配置驱动：调用方从 server/config.json 的 llm.{baseUrl,apiKey,model} 构造 options.config，
//     换厂商只需改 JSON，无需改代码。
//
// 仅使用 Node 内置全局 fetch / AbortController，零运行时依赖（Node >= 24）。
// 约束：可擦除语法（无 enum/namespace/参数属性）；仅类型导入使用 `import type`。

import type { LlmConfig } from '../config.ts';
import { asRecord } from '../config.ts';

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
  /** 恒为 false（非流式）。保留字段以维持既有响应形状。 */
  streamed: boolean;
};

export type ChatOptions = {
  /** 上游配置（来自 server/config.json 的 llm 段）。 */
  config: LlmConfig;
  /** 映射到请求体 max_tokens。 */
  maxTokens?: number;
  /** 单次尝试超时（毫秒）；默认 60000（推理型模型单次响应常 20–50s）。 */
  timeoutMs?: number;
  /** 最多重试次数；默认 1。 */
  maxRetries?: number;
  /** 调用方取消信号；与内部超时信号合并。 */
  signal?: AbortSignal;
  /** 单请求总预算到期时刻（epoch ms）；用于把单次尝试超时收敛到剩余预算。 */
  deadlineAt?: number;
};

const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_MAX_RETRIES = 1;
/** 重试前要求的最小剩余预算余量（毫秒）。 */
const RETRY_BUDGET_MARGIN_MS = 5000;

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

/** 剩余总预算（毫秒）；无 deadlineAt 时返回 Infinity（不限）。 */
function remainingBudget(deadlineAt: number | undefined): number {
  return deadlineAt === undefined ? Number.POSITIVE_INFINITY : deadlineAt - Date.now();
}

/** 按剩余预算收敛的单次尝试超时。 */
function effectiveTimeout(baseTimeout: number, remaining: number): number {
  if (!Number.isFinite(remaining)) return baseTimeout;
  return Math.max(1, Math.min(baseTimeout, remaining));
}

/**
 * 把 fetch / 响应读取抛出的底层异常归一化为 LlmError。
 * 注意：先判定超时与调用方取消，再归为网络错误。
 */
function mapTransportError(err: unknown, timedOut: boolean, callerAborted: boolean): LlmError {
  if (err instanceof LlmError) return err;
  if (timedOut) return new LlmError('timeout', '请求超时', true);
  if (callerAborted) return new LlmError('aborted', '请求已被调用方取消', false);
  const detail = err instanceof Error ? err.message : String(err);
  return new LlmError('network_error', `网络请求失败：${truncate(detail, 200)}`, true);
}

/** 消费/取消响应体，使连接可归还连接池（P1-23）。 */
async function discardBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // 已消费 / 已关闭：忽略。
  }
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

// ---------------------------------------------------------------------------
// 单次尝试
// ---------------------------------------------------------------------------

async function attemptChat(messages: ChatMessage[], options: ChatOptions): Promise<ChatResult> {
  const cfg = options.config;
  const baseUrl = cfg.baseUrl.trim();
  const model = cfg.model.trim();

  if (baseUrl === '') {
    throw new LlmError('invalid_config', 'LLM baseUrl 未配置', false);
  }
  if (model === '') {
    throw new LlmError('invalid_config', 'LLM model 未配置', false);
  }

  const baseTimeout =
    typeof options.timeoutMs === 'number' && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_TIMEOUT_MS;
  const timeoutMs = effectiveTimeout(baseTimeout, remainingBudget(options.deadlineAt));

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.apiKey.trim() !== '') {
    headers.Authorization = `Bearer ${cfg.apiKey.trim()}`;
  }

  const payload: Record<string, unknown> = { model, messages };
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
      await discardBody(res);
      throw new LlmError('upstream_error', `上游服务返回 HTTP ${res.status}`, res.status >= 500);
    }

    try {
      return await parseJsonResponse(res, model);
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
 * 调用 OpenAI 兼容的 `/chat/completions`（非流式）。
 *
 * @param messages 对话消息；不得为空。
 * @param options  配置（必填）+ 超时 / 重试 / 取消 / 预算。
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

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await attemptChat(messages, options);
    } catch (err) {
      const normalized =
        err instanceof LlmError
          ? err
          : new LlmError('network_error', '请求失败（未知错误）', true);
      const isLastAttempt = attempt >= attempts - 1;
      if (!normalized.retryable || isLastAttempt) {
        throw normalized;
      }
      const remaining = remainingBudget(options.deadlineAt);
      if (Number.isFinite(remaining)) {
        const baseTimeout =
          typeof options.timeoutMs === 'number' && options.timeoutMs > 0
            ? options.timeoutMs
            : DEFAULT_TIMEOUT_MS;
        const attemptTimeout = effectiveTimeout(baseTimeout, remaining);
        if (remaining <= attemptTimeout + RETRY_BUDGET_MARGIN_MS) {
          throw normalized;
        }
      }
    }
  }

  // 理论不可达：循环内要么 return，要么 throw。
  throw new LlmError('network_error', '请求失败', false);
}
