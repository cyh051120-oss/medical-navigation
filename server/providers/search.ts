// server/providers/search.ts
// 搜索适配器 + 权威来源过滤（任务 24）。
//
// 契约（T25 编排器 / T26 mock-upstream / T27 检查脚本据此实现）：
//   search(query, options) -> Promise<{ results: SearchResult[]; reason: SearchReason | null }>
//
//   SearchResult = { title, url, snippet, domain, publishedAt? }
//     - domain = new URL(url).hostname.toLowerCase()（解析失败的条目直接丢弃）；url 保留原样。
//     - publishedAt 可选，仅当上游给出非空字符串时透传；否则字段缺席。
//     - 仅保留「权威域名命中」的条目（见 server/authorities.ts 的严格子域匹配）。
//
//   reason（结果为空时的原因；结果非空时恒为 null）：
//     - 'no_results'         : 上游成功但 0 条（或全部条目 url 不可解析而被丢弃）+ 空 query。
//     - 'no_authority_match' : 上游返回 ≥1 条可解析条目，但无一命中权威域名。
//     - 'search_unavailable' : 配置/网络/超时/非 2xx/响应非法等任何不可用情形（绝不抛异常）。
//     - 'not_configured'     : config.search.baseUrl 为空（不发请求）。
//
//   上游契约（自定义，精确定档，供 T26 的 server/mock-upstream.mjs 实现）：
//     - 方法  : POST
//     - URL   : {baseUrl}/search   （baseUrl 末尾斜杠会被规整掉）
//     - headers:
//         Content-Type: application/json
//         Authorization: Bearer <apiKey>   （仅当 apiKey 非空）
//     - 请求体: { "q": string, "limit": number }
//     - 2xx 响应 JSON: { "results": [ { "title": string, "url": string,
//                                      "snippet": string, "publishedAt"?: string }, ... ] }
//       注：空结果写作 { "results": [] }；missing/非数组 results 视为上游不可用。
//
//   - 超时经 AbortController 实现；默认 30000ms，可用 options.timeoutMs 覆盖。
//   - 上游失败 / 超时 / 限流（429）/ 5xx 一律不抛异常，统一归一化为
//       { results: [], reason: 'search_unavailable' }。
//   - authorityDomains：options.authorityDomains 非空时覆盖默认清单；空时用
//       DEFAULT_AUTHORITY_DOMAINS（语义见 server/authorities.ts）。
//   - 隐私：绝不写盘、绝不打印任何请求/响应内容（query / body / apiKey）。
//
// 仅使用 Node 内置全局 fetch / AbortController，零运行时依赖（Node >= 24）。
// 约束：可擦除语法（无 enum/namespace/参数属性）；仅类型导入使用 `import type`。

import type { SearchConfig } from '../config.ts';
import { asRecord, isPlaceholderBaseUrl } from '../config.ts';
import {
  isAuthorityUrl,
  resolveAuthorityDomains,
} from '../authorities.ts';

/** 归一化后的单条来源。字段形状即 T25 citations 的输入契约。 */
export type SearchResult = {
  title: string;
  url: string;
  snippet: string;
  /** new URL(url).hostname.toLowerCase()。 */
  domain: string;
  /** 可选，上游非空字符串时透传。 */
  publishedAt?: string;
};

/** 稳定机器码，供上层分支处理；见文件头 reason 语义。 */
export type SearchReason =
  | 'no_results'
  | 'no_authority_match'
  | 'search_unavailable'
  | 'not_configured';

export type SearchResponse = {
  results: SearchResult[];
  /** 结果非空时为 null。 */
  reason: SearchReason | null;
};

export type SearchOptions = {
  /** 上游配置（来自 server/config.json 的 search 段）。 */
  config: SearchConfig;
  /** 覆盖权威域名清单；非空生效，空/未提供回退默认。 */
  authorityDomains?: readonly string[];
  /** 上游请求的 limit；默认 10。 */
  limit?: number;
  /** 单次请求超时（毫秒）；默认 30000。 */
  timeoutMs?: number;
  /** 调用方取消信号；仅用于中止本次请求（同样归一化为 search_unavailable）。 */
  signal?: AbortSignal;
  /** 单请求总预算到期时刻（epoch ms）；用于把超时收敛到剩余预算。 */
  deadlineAt?: number;
};

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_LIMIT = 10;

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function endpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/search`;
}

/**
 * 归一化单条上游结果。仅当 url 为非空字符串且可被 `new URL` 解析时成功；
 * 否则返回 null（该条目被丢弃）。此处不做权威过滤，以便区分
 * 「上游零结果」与「有结果但全非权威」。
 */
function normalizeItem(raw: unknown): SearchResult | null {
  const rec = asRecord(raw);
  const url = typeof rec.url === 'string' ? rec.url.trim() : '';
  if (url === '') return null;

  let domain: string;
  try {
    domain = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (domain === '') return null;

  const item: SearchResult = {
    title: typeof rec.title === 'string' ? rec.title : '',
    url,
    snippet: typeof rec.snippet === 'string' ? rec.snippet : '',
    domain,
  };
  if (typeof rec.publishedAt === 'string' && rec.publishedAt.trim() !== '') {
    item.publishedAt = rec.publishedAt;
  }
  return item;
}

// ---------------------------------------------------------------------------
// 公开 API
// ---------------------------------------------------------------------------

/**
 * 调用配置驱动的搜索上游，归一化来源结构并按权威域名白名单过滤。
 *
 * 失败（未配置 / 网络 / 超时 / 限流 / 5xx / 响应非法）一律不抛异常，
 * 返回 `{ results: [], reason }`。
 *
 * @param query   搜索关键词；空白视为 no_results（不发请求）。
 * @param options config（必填）+ authorityDomains / limit / timeoutMs / signal。
 */
export async function search(query: string, options: SearchOptions): Promise<SearchResponse> {
  const q = typeof query === 'string' ? query.trim() : '';
  const baseUrl = options.config.baseUrl.trim();
  const domains = resolveAuthorityDomains(options.authorityDomains);

  if (baseUrl === '' || isPlaceholderBaseUrl(baseUrl)) {
    return { results: [], reason: 'not_configured' };
  }
  if (q === '') return { results: [], reason: 'no_results' };

  const baseTimeout =
    typeof options.timeoutMs === 'number' && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_TIMEOUT_MS;
  const remaining =
    options.deadlineAt === undefined ? Number.POSITIVE_INFINITY : options.deadlineAt - Date.now();
  const timeoutMs = Number.isFinite(remaining)
    ? Math.max(1, Math.min(baseTimeout, remaining))
    : baseTimeout;
  const limit =
    typeof options.limit === 'number' && Number.isInteger(options.limit) && options.limit > 0
      ? options.limit
      : DEFAULT_LIMIT;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const apiKey = options.config.apiKey.trim();
  if (apiKey !== '') headers.Authorization = `Bearer ${apiKey}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
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
        body: JSON.stringify({ q, limit }),
        signal: controller.signal,
      });
    } catch {
      // 网络错误 / 超时 / 取消：统一归一化，绝不外抛。
      return { results: [], reason: 'search_unavailable' };
    }

    if (!res.ok) {
      // 限流（429）/ 5xx 等：消费响应体使连接归还连接池，且不回显内容。
      try {
        await res.body?.cancel();
      } catch {
        // 已消费 / 已关闭：忽略。
      }
      return { results: [], reason: 'search_unavailable' };
    }

    let data: unknown;
    try {
      data = (await res.json()) as unknown;
    } catch {
      return { results: [], reason: 'search_unavailable' };
    }

    const root = asRecord(data);
    if (!Array.isArray(root.results)) {
      // 上游成功但违反响应形状：视为不可用。
      return { results: [], reason: 'search_unavailable' };
    }

    const normalized: SearchResult[] = [];
    for (const rawItem of root.results) {
      const item = normalizeItem(rawItem);
      if (item !== null) normalized.push(item);
    }
    if (normalized.length === 0) return { results: [], reason: 'no_results' };

    const authoritative = normalized.filter((item) => isAuthorityUrl(item.domain, domains));
    if (authoritative.length === 0) return { results: [], reason: 'no_authority_match' };

    return { results: authoritative, reason: null };
  } finally {
    clearTimeout(timer);
    if (options.signal !== undefined) {
      options.signal.removeEventListener('abort', onCallerAbort);
    }
  }
}
