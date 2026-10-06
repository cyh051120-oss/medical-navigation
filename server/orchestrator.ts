// server/orchestrator.ts
// POST /api/ask 编排器：双模式契约 + 安全护栏 + 输出校验（任务 25）。
//
// 入口：
//   ask(request, options?) -> Promise<AskResponse>   （JSON 可序列化；绝不抛异常）
//
// 请求：
//   { mode: 'organize'|'consult', messages: {role,content}[], profileSummary?, consent: true,
//     recordExcerpts?: string[], memories?: string[] }
//   - consent !== true → {error:'consent_required'}，零上游调用。
//   - mode 非法 → {error:'invalid_mode'}，零上游调用。
//
// 响应（成功）：
//   organize → { points[], extracted{...}, unknowns[], questions[] }（无医疗判断，无问诊字段）
//   consult  → { directions[{text,citation}], suggestedDepartments[], citations[],
//                suggestions[{text,citation}], unknowns[], questions[], disclaimer }
// 响应（护栏/失败）：
//   红标命中 → { redFlag:true, safetyNotice, disclaimer }（固定句；零 LLM、零搜索）
//   错误      → { error, message, fallback? }   （unsafe_output 带 fallback:'organize'）
//
// 上游策略：
//   - consume：organize 0 次搜索；consult 最多 1 次（关键词取最近一条 user 消息，≤200 字）。
//   - chat()：非流式、严格 JSON（容忍可选代码块围栏）；解析/校验失败 → unsafe_output。
//   - LLM 未配置（baseUrl/model 为空）→ {error:'provider_not_configured'}，零网络。
//   - 上游失败 → {error:'upstream_error'}（不回显响应内容）。
//
// 上下文上限：会话窗口最近 ≤20 条且合计 ≤8K 字符（丢最早）；记录摘录 ≤2K、记忆 ≤20 条/≤1K。
//
// 隐私：不写盘、不打印任何内容。绝不抛出（全部失败归一化为结构化错误对象）。
// 约束：可擦除语法；相对导入显式 .ts；仅类型导入使用 `import type`。

import type { ChatMessage } from './providers/llm.ts';
import { LlmError, chat } from './providers/llm.ts';
import type { SearchReason, SearchResult } from './providers/search.ts';
import { search } from './providers/search.ts';
import { resolveAuthorityDomains } from './authorities.ts';
import { isLlmConfigured, loadConfig } from './config.ts';
import type { ServerConfig } from './config.ts';
import { SAFETY_NOTICE, detectRedFlag } from './redflags.ts';
import { CONSULT_DISCLAIMER, LIMITS, buildSystemPrompt } from './prompts.ts';
import type { AskMode } from './prompts.ts';
import { normalizeMessages, parseJsonContent, validateConsultOutput, validateOrganizeOutput } from './validate.ts';
import type { ConsultResult, OrganizeResult } from './validate.ts';

export type { AskMode } from './prompts.ts';
export type { Citation, ConsultResult, OrganizeResult } from './validate.ts';

export type AskRequest = {
  mode: AskMode;
  messages: ChatMessage[];
  /** 脱敏档案摘要（客户端脱敏；仅供语境）。 */
  profileSummary?: string;
  /** 必须为字面 true 才继续；否则 consent_required。 */
  consent: boolean;
  /** 用户确认后的记录摘录（合计 ≤2K 字符）。 */
  recordExcerpts?: string[];
  /** 启用的记忆条目文本（≤20 条、合计 ≤1K 字符）；仅偏好语义，不视为医学事实。 */
  memories?: string[];
};

export type AskOptions = {
  /** 缺省时读取 server/config.json（沿用 config.ts 契约）。 */
  config?: ServerConfig;
  /** 覆盖权威域名清单；省略则用 config.authorityDomains（空则回退默认）。 */
  authorityDomains?: readonly string[];
  /** 覆盖 max_tokens；默认 LIMITS.defaultMaxTokens。 */
  maxTokens?: number;
  /** 覆盖上游超时（毫秒）。 */
  timeoutMs?: number;
  /** 调用方取消信号（同时用于搜索与 LLM；客户端断连时及时释放上游）。 */
  signal?: AbortSignal;
  /** 单请求总预算到期时刻（epoch ms）；provider 据此计算剩余预算。 */
  deadlineAt?: number;
};

export type AskErrorCode =
  | 'invalid_request'
  | 'consent_required'
  | 'invalid_mode'
  | 'provider_not_configured'
  | 'upstream_error'
  | 'unsafe_output'
  | 'internal_error';

export type AskError = {
  error: AskErrorCode;
  message: string;
  /** 仅 unsafe_output 携带：客户端据此降级为 organize。 */
  fallback?: 'organize';
};

/** 红标命中时的固定响应（模式无关；不含任何方向/科室/引用/输入回显）。 */
export type RedFlagResult = {
  redFlag: true;
  safetyNotice: string;
  disclaimer: string;
};

export type AskResponse = OrganizeResult | ConsultResult | RedFlagResult | AskError;

// ---------------------------------------------------------------------------
// 请求解析
// ---------------------------------------------------------------------------

function isStringArrayOrUndefined(value: unknown): value is string[] | undefined {
  return (
    value === undefined ||
    (Array.isArray(value) && value.every((item) => typeof item === 'string'))
  );
}

/** 会话窗口：保留最近 ≤20 条，再从最早丢弃直到合计 ≤8K 字符；单条超大则硬截断。 */
function windowMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  const tail = messages.slice(-LIMITS.maxTurns);
  let start = 0;
  const total = (): number => {
    let sum = 0;
    for (let i = start; i < tail.length; i += 1) sum += tail[i].content.length;
    return sum;
  };
  while (start < tail.length - 1 && total() > LIMITS.maxContextChars) start += 1;
  const kept = tail.slice(start);
  if (kept.length === 1 && kept[0].content.length > LIMITS.maxContextChars) {
    return [{ role: kept[0].role, content: kept[0].content.slice(0, LIMITS.maxContextChars) }];
  }
  return kept;
}

/** 最近一条 user 消息 → 搜索关键词（压空白、≤200 字）。 */
function deriveQuery(messages: readonly ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') {
      return messages[i].content.replace(/\s+/g, ' ').trim().slice(0, LIMITS.maxSearchQueryChars);
    }
  }
  return '';
}

function errorResult(error: AskErrorCode, message: string): AskError {
  return { error, message };
}

function unsafeResult(): AskError {
  return {
    error: 'unsafe_output',
    message: '模型输出未通过安全校验，已降级为整理模式',
    fallback: 'organize',
  };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function runAsk(request: AskRequest, options: AskOptions): Promise<AskResponse> {
  if (request === null || typeof request !== 'object') {
    return errorResult('invalid_request', '请求体必须为对象');
  }
  if (request.consent !== true) {
    return errorResult('consent_required', '缺少用户同意（consent 必须为 true）');
  }
  if (request.mode !== 'organize' && request.mode !== 'consult') {
    return errorResult('invalid_mode', 'mode 必须为 organize 或 consult');
  }
  const messages = normalizeMessages(request.messages);
  if (messages === null) {
    return errorResult('invalid_request', 'messages 必须为非空且字段合法的消息数组');
  }
  if (request.profileSummary !== undefined && typeof request.profileSummary !== 'string') {
    return errorResult('invalid_request', 'profileSummary 必须为字符串');
  }
  if (!isStringArrayOrUndefined(request.recordExcerpts)) {
    return errorResult('invalid_request', 'recordExcerpts 必须为字符串数组');
  }
  if (!isStringArrayOrUndefined(request.memories)) {
    return errorResult('invalid_request', 'memories 必须为字符串数组');
  }

  const mode = request.mode;
  const config = options.config ?? loadConfig();
  const authorityDomains = resolveAuthorityDomains(
    options.authorityDomains ?? config.authorityDomains
  );
  const windowed = windowMessages(messages);
  const recordExcerpts = request.recordExcerpts ?? [];
  const memories = request.memories ?? [];

  // 红标：先于任何上游调用；扫描 user 消息 + 记录摘录 + 档案摘要（记忆不作为医学事实，不扫描）。
  const scan = detectRedFlag([
    ...windowed.filter((message) => message.role === 'user').map((message) => message.content),
    ...recordExcerpts,
    ...(request.profileSummary !== undefined ? [request.profileSummary] : []),
  ]);
  if (scan.hit) {
    return { redFlag: true, safetyNotice: SAFETY_NOTICE, disclaimer: CONSULT_DISCLAIMER };
  }

  if (!isLlmConfigured(config.llm)) {
    return errorResult('provider_not_configured', 'LLM 未配置（baseUrl/model/apiKey 为空或为占位示例域名）');
  }

  // 搜索：organize 0 次；consult 至多 1 次。reason 用于向客户端标记降级（P1-14）。
  let sources: SearchResult[] = [];
  let searchReason: SearchReason = 'no_results';
  if (mode === 'consult') {
    const query = deriveQuery(windowed);
    if (query !== '') {
      const response = await search(query, {
        config: config.search,
        authorityDomains,
        signal: options.signal,
        deadlineAt: options.deadlineAt,
      });
      sources = response.results;
      searchReason = response.reason ?? 'no_results';
    }
  }

  const systemContent = buildSystemPrompt(mode, {
    profileSummary: request.profileSummary,
    recordExcerpts,
    memories,
    sources,
  });
  const outMessages: ChatMessage[] = [{ role: 'system', content: systemContent }, ...windowed];
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
  } catch (err) {
    const code = err instanceof LlmError ? err.code : 'unknown';
    return errorResult('upstream_error', `LLM 上游调用失败（${code}）`);
  }

  const parsed = parseJsonContent(content);
  if (parsed === null) return unsafeResult();

  if (mode === 'organize') {
    const validated = validateOrganizeOutput(parsed.value);
    return validated.ok ? validated.value : unsafeResult();
  }
  const validated = validateConsultOutput(parsed.value, { sources, authorityDomains });
  if (!validated.ok) return unsafeResult();
  if (searchReason !== 'no_results' || sources.length === 0) {
    // 检索不可用/零命中/全非权威：标记降级并清空无来源的科室建议（P1-14）。
    return { ...validated.value, suggestedDepartments: [], degraded: searchReason };
  }
  return validated.value;
}

/**
 * 双模式编排入口。绝不抛异常：任何未预期错误归一化为 `{error:'internal_error'}`。
 */
export async function ask(request: AskRequest, options: AskOptions = {}): Promise<AskResponse> {
  try {
    return await runAsk(request, options);
  } catch {
    return errorResult('internal_error', '内部错误：编排失败');
  }
}
