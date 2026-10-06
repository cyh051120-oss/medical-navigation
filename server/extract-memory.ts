// server/extract-memory.ts
// 记忆提炼服务：POST /api/extract-memory 的核心逻辑（任务 43）。
//
// 入口：
//   extractMemory(request, options?) -> Promise<ExtractResponse>   （JSON 可序列化；绝不抛异常）
//
// 请求：
//   { messages: {role,content}[]（仅最近一轮，合计 ≤2K 字符）, consent: true, maxItems?: number(≤3) }
//   - consent !== true        → {candidates:[], reason:'consent_required'}，零上游、零网络。
//   - messages 非法 / 为空    → {candidates:[], reason:'invalid_request'}，零上游。
//   - maxItems 非法（非正数） → {candidates:[], reason:'invalid_request'}，零上游。
//   - LLM 未配置（baseUrl/model 为空）→ {candidates:[], reason:'provider_not_configured'}，零网络。
//
// 响应（成功）：{ candidates: [{ text }] }（无 reason）。
// 响应（降级）：{ candidates: [], reason }（超时 / 非 2xx / JSON 非法 / 缺 candidates 字段 → upstream_error）。
//
// 提炼范围：仅用户偏好/习惯（作息/饮食/运动/沟通偏好）；逐条校验 text 为字符串、去空白非空、
//   ≤60 字、不含受限词（validate.ts 词表 + 记忆提炼专属医疗禁词）→ 违规条目丢弃、合法条目保留；
//   随后首现去重、截断到 maxItems。全部非法则 {candidates: []}。
//
// 隐私：不写盘、不打印任何请求/响应内容。绝不抛出（全部失败归一化为结构化对象）。
// 约束：可擦除语法；相对导入显式 .ts；仅类型导入使用 `import type`。

import type { ChatMessage } from './providers/llm.ts';
import { chat } from './providers/llm.ts';
import { loadConfig } from './config.ts';
import type { ServerConfig } from './config.ts';
import { LIMITS, buildExtractSystemPrompt } from './prompts.ts';
import { DECISION_TERMS, REFERRAL_TERMS, SELF_MEDICATION_TERMS } from './validate.ts';

const ROLES: readonly string[] = ['user', 'assistant', 'system'];

export type ExtractCandidate = { text: string };

export type ExtractReason =
  | 'invalid_request'
  | 'consent_required'
  | 'provider_not_configured'
  | 'upstream_error'
  | 'internal_error';

export type ExtractResponse = {
  candidates: ExtractCandidate[];
  /** 仅降级响应携带；成功响应不含该字段。 */
  reason?: ExtractReason;
};

export type ExtractRequest = {
  /** 最近一轮对话（客户端已做脱敏）；合计 >2K 时按序丢弃最早，再硬截断单条。 */
  messages: ChatMessage[];
  /** 必须为字面 true 才继续；否则 consent_required。 */
  consent: boolean;
  /** 候选条数上限；缺省 3，超出夹到 ≤3。 */
  maxItems?: number;
};

export type ExtractOptions = {
  /** 缺省时读取 server/config.json（沿用 config.ts 契约）。 */
  config?: ServerConfig;
  /** 覆盖 max_tokens；默认 LIMITS.defaultMaxTokens。 */
  maxTokens?: number;
  /** 覆盖上游超时（毫秒）。 */
  timeoutMs?: number;
  /** 调用方取消信号。 */
  signal?: AbortSignal;
};

/** 记忆提炼专属医疗禁词（与 validate.ts 词表合并；医生/医院/诊断等已在共用词表中）。 */
const EXTRACT_MEDICAL_TERMS: readonly string[] = ['症状', '疾病', '用药', '药物'];

const EXTRACT_BANNED_TERMS: readonly string[] = [
  ...DECISION_TERMS,
  ...REFERRAL_TERMS,
  ...SELF_MEDICATION_TERMS,
  ...EXTRACT_MEDICAL_TERMS,
];

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function empty(reason: ExtractReason): ExtractResponse {
  return { candidates: [], reason };
}

/** 消息数组规范化：非空、每项为对象且 role 合法、content 为字符串；否则 null。 */
function normalizeMessages(value: unknown): ChatMessage[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const out: ChatMessage[] = [];
  for (const item of value) {
    if (item === null || typeof item !== 'object') return null;
    const rec = item as Record<string, unknown>;
    if (typeof rec.role !== 'string' || !ROLES.includes(rec.role)) return null;
    if (typeof rec.content !== 'string') return null;
    out.push({ role: rec.role as ChatMessage['role'], content: rec.content });
  }
  return out;
}

/** 最近一轮合计 ≤2K 字符：从最早丢弃，剩余单条超大则硬截断。 */
function capMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  const out = messages.map((message) => ({ role: message.role, content: message.content }));
  const total = (): number => out.reduce((sum, message) => sum + message.content.length, 0);
  while (out.length > 1 && total() > LIMITS.maxExtractChars) out.shift();
  if (out.length === 1 && out[0].content.length > LIMITS.maxExtractChars) {
    return [{ role: out[0].role, content: out[0].content.slice(0, LIMITS.maxExtractChars) }];
  }
  return out;
}

/** maxItems：缺省 maxExtractItems（3）；正有限数夹到 ≤3；其余非法 → null。 */
function resolveMaxItems(value: unknown): number | null {
  if (value === undefined) return LIMITS.maxExtractItems;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.min(Math.floor(value), LIMITS.maxExtractItems);
  }
  return null;
}

/** 严格 JSON 解析；容忍外层 ```json 围栏；失败返回 null。 */
function parseJsonContent(content: string): { ok: true; value: unknown } | null {
  let text = content.trim();
  if (text === '') return null;
  const fence = /^```[a-zA-Z0-9]*\s*([\s\S]*?)\s*```$/.exec(text);
  if (fence !== null) text = fence[1].trim();
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return null;
  }
}

/** 逐条校验：合法返回去空白文本，否则 null（违规条目丢弃，不影响其余）。 */
function validateCandidate(raw: unknown): string | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const text = (raw as Record<string, unknown>).text;
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (trimmed === '') return null;
  if (trimmed.length > LIMITS.maxExtractItemChars) return null;
  for (const term of EXTRACT_BANNED_TERMS) {
    if (trimmed.includes(term)) return null;
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function runExtract(
  request: ExtractRequest,
  options: ExtractOptions
): Promise<ExtractResponse> {
  if (request === null || typeof request !== 'object') return empty('invalid_request');
  if (request.consent !== true) return empty('consent_required');

  const messages = normalizeMessages(request.messages);
  if (messages === null) return empty('invalid_request');

  const maxItems = resolveMaxItems(request.maxItems);
  if (maxItems === null) return empty('invalid_request');

  const config = options.config ?? loadConfig();
  if (config.llm.baseUrl.trim() === '' || config.llm.model.trim() === '') {
    return empty('provider_not_configured');
  }

  const outMessages: ChatMessage[] = [
    { role: 'system', content: buildExtractSystemPrompt() },
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
      stream: false,
      maxTokens,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    });
    content = result.content;
  } catch {
    return empty('upstream_error');
  }

  const parsed = parseJsonContent(content);
  if (parsed === null) return empty('upstream_error');

  const rawCandidates = asRecord(parsed.value).candidates;
  if (!Array.isArray(rawCandidates)) return empty('upstream_error');

  const seen = new Set<string>();
  const candidates: ExtractCandidate[] = [];
  for (const item of rawCandidates) {
    const text = validateCandidate(item);
    if (text === null || seen.has(text)) continue;
    seen.add(text);
    candidates.push({ text });
    if (candidates.length >= maxItems) break;
  }

  return { candidates };
}

/**
 * 记忆提炼入口。绝不抛异常：任何未预期错误归一化为 `{candidates:[], reason:'internal_error'}`。
 */
export async function extractMemory(
  request: ExtractRequest,
  options: ExtractOptions = {}
): Promise<ExtractResponse> {
  try {
    return await runExtract(request, options);
  } catch {
    return empty('internal_error');
  }
}
