// server/config.ts
// 配置加载与类型（任务 23 从 server/index.ts 抽出，供 LLM/检索适配器与编排器复用）。
//
// 契约与任务 22 完全一致（行为不变，仅搬家）：
//   - 缺失配置  -> 非零退出 + 可读中文指引（提示复制 config.example.json），绝不静默兜底。
//   - JSON 破损 -> 非零退出 + 文件路径 + 解析错误 + 修复提示。
//   - 文件存在但 key 为空 -> 服务照常运行，由调用方派生 providerReady/searchReady=false。
//
// 总预算（P0-4）：
//   - TOTAL_DEADLINE_MS = 110000：单个请求（搜索 + LLM 含重试）的总预算，短于客户端 120000ms。
//     实际值可用环境变量 MHP_TOTAL_DEADLINE_MS 覆盖（仅供测试）。
//
// 未配置判定（P1-30）：占位示例域名（api.example.com 等）一律显式拒绝，避免照抄示例即外发。
//
// 本模块无副作用（不会启动服务），可被 server/**.ts 安全导入。
// 约束：可擦除语法（无 enum/namespace/参数属性）；仅类型导入使用 `import type`。

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPlausibleAuthorityDomain } from './authorities.ts';

export type LlmConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
};

export type SearchConfig = {
  baseUrl: string;
  apiKey: string;
};

export type ServerConfig = {
  port: number;
  demo: boolean;
  llm: LlmConfig;
  search: SearchConfig;
  authorityDomains: string[];
  /** 额外允许的浏览器 Origin（本地回环之外）；缺省 []。 */
  corsOrigins: string[];
};

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 配置文件路径固定为 server/config.json（已被 .gitignore 忽略）。 */
export const CONFIG_PATH = resolve(__dirname, 'config.json');

/** 默认端口（避开 devtools 自动化端口 9420）。 */
export const DEFAULT_PORT = 8787;

/** 单请求总预算（毫秒）：搜索 + LLM（含重试）全过程。客户端默认预算为 120000ms。 */
export const TOTAL_DEADLINE_MS = 110000;

/** 读取生效的总预算：环境变量 MHP_TOTAL_DEADLINE_MS（正整数）优先，否则 TOTAL_DEADLINE_MS。 */
export function resolveTotalDeadlineMs(): number {
  const raw = process.env.MHP_TOTAL_DEADLINE_MS;
  if (typeof raw === 'string' && /^\d+$/.test(raw)) {
    const value = Number(raw);
    if (value > 0) return value;
  }
  return TOTAL_DEADLINE_MS;
}

/** 占位示例域名（照抄 config.example.json 时会让真实症状文本外发到这些 host，必须拒绝）。 */
const PLACEHOLDER_HOSTS: readonly string[] = ['example.com', 'example.org', 'example.net'];

/** 判定 baseUrl 是否指向占位示例域名（example.com / example.org / example.net 及其子域）。 */
export function isPlaceholderBaseUrl(baseUrl: string): boolean {
  const value = baseUrl.trim().toLowerCase();
  if (value === '') return false;
  let host: string;
  try {
    host = new URL(value.includes('://') ? value : `https://${value}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  return PLACEHOLDER_HOSTS.some((placeholder) => host === placeholder || host.endsWith(`.${placeholder}`));
}

/** providerReady：baseUrl、model、apiKey 均非空且 baseUrl 非占位示例域名。 */
export function isLlmConfigured(llm: LlmConfig): boolean {
  return (
    llm.baseUrl.trim() !== '' &&
    llm.model.trim() !== '' &&
    llm.apiKey.trim() !== '' &&
    !isPlaceholderBaseUrl(llm.baseUrl)
  );
}

/** searchReady：baseUrl 非空且非占位示例域名。 */
export function isSearchConfigured(search: SearchConfig): boolean {
  return search.baseUrl.trim() !== '' && !isPlaceholderBaseUrl(search.baseUrl);
}

/** 打印可读错误并终止，退出码 1。返回 never，便于控制流收窄。 */
export function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function readTextOrExit(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return fail(`无法读取配置文件：${path}\n${detail}`);
  }
}

function parseJsonOrExit(path: string, raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return fail(
      [
        `配置文件不是合法 JSON：${path}`,
        detail,
        '请检查 JSON 语法（常见原因：多余逗号、缺少引号、括号不匹配）。',
        '可从示例重新复制：cp server/config.example.json server/config.json',
      ].join('\n')
    );
  }
}

/** 收窄为普通对象；非对象返回 {}（供 server/**.ts 复用；单一权威定义）。 */
export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asPort(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 65535) {
    return value;
  }
  return fallback;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/**
 * 校验 authorityDomains 并在发现问题时打印可见告警（P1-42）：
 *   - 非数组：忽略并回退默认；
 *   - 含非法项（裸 TLD / 空串 / 非法标签）：丢弃该非法项并告警；
 *   - 声明非空但全部非法：回退默认并告警。
 * 返回值仅含合法项（可能为空，由 resolveAuthorityDomains 回退默认）。
 */
function sanitizeAuthorityDomains(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    console.error(
      '[server] authorityDomains 必须为字符串数组，已忽略并回退默认权威域名清单。'
    );
    return [];
  }
  const valid: string[] = [];
  const rejected: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !isPlausibleAuthorityDomain(item)) {
      rejected.push(typeof item === 'string' ? item : String(item));
      continue;
    }
    valid.push(item);
  }
  if (rejected.length > 0) {
    console.error(
      `[server] authorityDomains 含 ${rejected.length} 个非法项（裸 TLD / 空串 / 非法标签），已丢弃：${rejected
        .map((item) => JSON.stringify(item))
        .join(', ')}`
    );
  }
  if (valid.length === 0 && value.length > 0) {
    console.error('[server] authorityDomains 全部非法，已回退默认权威域名清单。');
  }
  return valid;
}

/**
 * 读取并校验配置。默认读取 server/config.json；可传入路径用于测试。
 * 缺失 / 破损会打印可读指引并 `process.exit(1)`（返回类型 ServerConfig，控制流由 fail(): never 收窄）。
 */
export function loadConfig(configPath: string = CONFIG_PATH): ServerConfig {
  if (!existsSync(configPath)) {
    fail(
      [
        `未找到配置文件：${configPath}`,
        '本服务不会在缺少配置时静默启动（避免误用默认凭据）。',
        '请先复制示例配置，再按需填写：',
        '  cp server/config.example.json server/config.json',
        'llm/search 的 apiKey 可留空：服务仍会启动，/api/health 会报 providerReady=false / searchReady=false。',
      ].join('\n')
    );
  }

  const raw = readTextOrExit(configPath);
  const parsed = parseJsonOrExit(configPath, raw);
  const root = asRecord(parsed);
  const llm = asRecord(root.llm);
  const search = asRecord(root.search);

  return {
    port: asPort(root.port, DEFAULT_PORT),
    demo: asBoolean(root.demo, false),
    llm: {
      baseUrl: asString(llm.baseUrl, ''),
      apiKey: asString(llm.apiKey, ''),
      model: asString(llm.model, ''),
    },
    search: {
      baseUrl: asString(search.baseUrl, ''),
      apiKey: asString(search.apiKey, ''),
    },
    authorityDomains: sanitizeAuthorityDomains(root.authorityDomains),
    corsOrigins: asStringArray(root.corsOrigins),
  };
}
