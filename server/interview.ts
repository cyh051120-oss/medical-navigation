// server/interview.ts
// 问诊引导服务：POST /api/interview 的核心逻辑。
//
// 入口：
//   interview(request, options?) -> Promise<InterviewResponse>   （JSON 可序列化；绝不抛异常）
//
// 请求：
//   { messages: {role,content}[]（含本轮追问的全部对话）, consent: true, round?: number }
//   - consent !== true        → {status:'failed', reason:'consent_required'}，零上游。
//   - messages 非法 / 为空    → {status:'failed', reason:'invalid_request'}，零上游。
//   - round 显式非法（非非负整数）→ {status:'failed', reason:'invalid_request'}，零上游。
//   - LLM 未配置（baseUrl/model 为空）→ {status:'failed', reason:'provider_not_configured'}，零网络。
//
// 响应：
//   { status:'ask', question:{ text, slot } }   —— 继续追问（一次一个问题）
//   { status:'done' }                           —— 信息够了或已达轮数上限
//   { redFlag:true, safetyNotice, disclaimer }   —— 危重信号短路（零 LLM、零搜索）
//   { status:'failed', reason }                 —— 降级，绝不伪造问题
//
// 上限：窗口内 assistant 轮数（或客户端上报的 round）达到 LIMITS.maxInterviewQuestions 即强制
//   {status:'done'}（零 LLM），避免无限追问。上下文合计受 LIMITS.maxInterviewChars 约束。
//
// 校验：只保留 status / question.{text,slot}；question.text 去空白非空、≤ maxInterviewQuestionChars
//   且不含 DECISION_TERMS；slot 必须命中 INTERVIEW_SLOTS 白名单。任一不满足 → unsafe_output。
//
// 隐私：不写盘、不打印任何请求/响应内容。
// 约束：可擦除语法；相对导入显式 .ts；仅类型导入使用 `import type`。

import type { ChatMessage } from './providers/llm.ts';
import { chat } from './providers/llm.ts';
import { asRecord, isLlmConfigured, loadConfig } from './config.ts';
import type { ServerConfig } from './config.ts';
import { CONSULT_DISCLAIMER, INTERVIEW_SLOTS, LIMITS, buildInterviewSystemPrompt } from './prompts.ts';
import { DECISION_TERMS, normalizeMessages, parseJsonContent } from './validate.ts';
import { SAFETY_NOTICE, detectRedFlag } from './redflags.ts';

export type InterviewQuestion = {
  text: string;
  slot: string;
};

export type InterviewReason =
  | 'invalid_request'
  | 'consent_required'
  | 'provider_not_configured'
  | 'upstream_error'
  | 'unsafe_output'
  | 'internal_error';

export type InterviewResponse =
  | { status: 'ask'; question: InterviewQuestion }
  | { status: 'done' }
  | { redFlag: true; safetyNotice: string; disclaimer: string }
  | { status: 'failed'; reason: InterviewReason };

export type InterviewRequest = {
  /** 含本轮追问在内的全部对话（客户端已脱敏）。 */
  messages: ChatMessage[];
  /** 必须为字面 true 才继续；否则 consent_required。 */
  consent: boolean;
  /** 已完成的追问轮数（客户端计数）；缺省按消息里的 assistant 轮数估算。 */
  round?: number;
  /** 启用中的记忆条目文本（偏好语义，仅用于调整提问的表达方式）。 */
  memories?: string[];
};

export type InterviewOptions = {
  /** 缺省时读取 server/config.json（沿用 config.ts 契约）。 */
  config?: ServerConfig;
  /** 覆盖 max_tokens；默认 LIMITS.defaultMaxTokens。 */
  maxTokens?: number;
  /** 覆盖上游超时（毫秒）。 */
  timeoutMs?: number;
  /** 调用方取消信号。 */
  signal?: AbortSignal;
  /** 单请求总预算到期时刻（epoch ms）。 */
  deadlineAt?: number;
};

/** 可选字段：undefined 或纯字符串数组。 */
function isStringArrayOrUndefined(value: unknown): value is string[] | undefined {
  return value === undefined || (Array.isArray(value) && value.every((item) => typeof item === 'string'));
}

function failed(reason: InterviewReason): InterviewResponse {
  return { status: 'failed', reason };
}

/** 上下文合计 ≤ maxInterviewChars：从最早丢弃，剩余单条超大则硬截断。 */
function capMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  const out = messages.map((message) => ({ role: message.role, content: message.content }));
  const total = (): number => out.reduce((sum, message) => sum + message.content.length, 0);
  while (out.length > 1 && total() > LIMITS.maxInterviewChars) out.shift();
  if (out.length === 1 && out[0].content.length > LIMITS.maxInterviewChars) {
    return [{ role: out[0].role, content: out[0].content.slice(0, LIMITS.maxInterviewChars) }];
  }
  return out;
}

/** 已问轮数：优先用客户端上报的 round；缺省按 assistant 轮数估算。 */
function resolveRound(value: unknown, messages: readonly ChatMessage[]): number | null {
  if (value !== undefined) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
    return Math.floor(value);
  }
  let count = 0;
  for (const message of messages) {
    if (message.role === 'assistant') count += 1;
  }
  return count;
}

/**
 * 只接受一个追问：text 去空白非空、≤ maxInterviewQuestionChars、不含 DECISION_TERMS；
 * slot 必须命中 INTERVIEW_SLOTS。多余字段一律丢弃。
 */
function resolveQuestion(raw: unknown): InterviewQuestion | null {
  const rec = asRecord(raw);
  const text = typeof rec.text === 'string' ? rec.text.trim() : '';
  if (text === '') return null;
  if (text.length > LIMITS.maxInterviewQuestionChars) return null;
  for (const term of DECISION_TERMS) {
    if (text.includes(term)) return null;
  }
  const slot = typeof rec.slot === 'string' ? rec.slot.trim() : '';
  if (!INTERVIEW_SLOTS.includes(slot)) return null;
  return { text, slot };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function runInterview(
  request: InterviewRequest,
  options: InterviewOptions
): Promise<InterviewResponse> {
  if (request === null || typeof request !== 'object') return failed('invalid_request');
  if (request.consent !== true) return failed('consent_required');

  const messages = normalizeMessages(request.messages);
  if (messages === null) return failed('invalid_request');

  const round = resolveRound(request.round, messages);
  if (round === null) return failed('invalid_request');
  if (!isStringArrayOrUndefined(request.memories)) return failed('invalid_request');

  // 危重信号：任何上游调用之前；只扫 user 消息（助手生成的追问不参与扫描）。
  const scan = detectRedFlag(messages.filter((m) => m.role === 'user').map((m) => m.content));
  if (scan.hit) {
    return { redFlag: true, safetyNotice: SAFETY_NOTICE, disclaimer: CONSULT_DISCLAIMER };
  }

  const config = options.config ?? loadConfig();
  if (!isLlmConfigured(config.llm)) {
    return failed('provider_not_configured');
  }

  // 轮数上限：已达上限直接结束，零 LLM 调用。
  if (round >= LIMITS.maxInterviewQuestions) return { status: 'done' };

  const outMessages: ChatMessage[] = [
    { role: 'system', content: buildInterviewSystemPrompt({ memories: request.memories ?? [] }) },
    ...capMessages(messages),
  ];
  const maxTokens =
    typeof options.maxTokens === 'number' && options.maxTokens > 0
      ? options.maxTokens
      : LIMITS.defaultMaxTokens;

  let content: string;
  try {
    const result = await chat(outMessages, {
      config: config.llm,
      maxTokens,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      deadlineAt: options.deadlineAt,
    });
    content = result.content;
  } catch {
    return failed('upstream_error');
  }

  const parsed = parseJsonContent(content);
  if (parsed === null) return failed('unsafe_output');

  const root = asRecord(parsed.value);
  if (root.status === 'done') return { status: 'done' };
  if (root.status !== 'ask') return failed('unsafe_output');

  const question = resolveQuestion(root.question);
  if (question === null) return failed('unsafe_output');
  return { status: 'ask', question };
}

/**
 * 问诊引导入口。绝不抛异常：任何未预期错误归一化为 `{status:'failed', reason:'internal_error'}`。
 */
export async function interview(
  request: InterviewRequest,
  options: InterviewOptions = {}
): Promise<InterviewResponse> {
  try {
    return await runInterview(request, options);
  } catch {
    return failed('internal_error');
  }
}
