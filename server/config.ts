// server/config.ts
// 配置加载与类型（任务 23 从 server/index.ts 抽出，供 LLM/检索适配器与编排器复用）。
//
// 契约与任务 22 完全一致（行为不变，仅搬家）：
//   - 缺失配置  -> 非零退出 + 可读中文指引（提示复制 config.example.json），绝不静默兜底。
//   - JSON 破损 -> 非零退出 + 文件路径 + 解析错误 + 修复提示。
//   - 文件存在但 key 为空 -> 服务照常运行，由调用方派生 providerReady/searchReady=false。
//
// 本模块无副作用（不会启动服务），可被 server/**.ts 安全导入。
// 约束：可擦除语法（无 enum/namespace/参数属性）；仅类型导入使用 `import type`。

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
};

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 配置文件路径固定为 server/config.json（已被 .gitignore 忽略）。 */
export const CONFIG_PATH = resolve(__dirname, 'config.json');

/** 默认端口（避开 devtools 自动化端口 9420）。 */
export const DEFAULT_PORT = 8787;

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

function asRecord(value: unknown): Record<string, unknown> {
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
    authorityDomains: asStringArray(root.authorityDomains),
  };
}
