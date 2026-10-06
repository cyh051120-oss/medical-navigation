#!/usr/bin/env node
// scripts/check-server.mjs
// 服务端骨架检查（任务 22 的最小骨架；任务 27 会在此扩展）。
//
// 流程：
//   1) 要求 server/config.json 存在（缺失则打印可读指引并非零退出）。
//   2) 门禁一：npx tsc -p server/tsconfig.json --noEmit。
//   3) 门禁二：npm run typecheck（小程序 + 服务端两个 tsconfig）。
//   4) 拉起 `node server/index.ts`，轮询 GET /api/health 直到 200（超时 ~10s）。
//   5) 断言 health 为 { ok:true, providerReady:false, searchReady:false }（布尔）。
//   6) 写 artifacts/server/health.json，干净结束子进程，全部通过则 exit 0。
//
// 说明：本脚本使用「空 key」临时配置（经 MHP_CONFIG_PATH 注入，独立于开发者本地 config.json），
// 因而 /api/health 稳定报 providerReady=false / searchReady=false，无需还原本地真实 key。

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { delay } from './lib/check-helpers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const configPath = resolve(root, 'server/config.json');
const healthPath = resolve(root, 'artifacts/server/health.json');

const HEALTH_TIMEOUT_MS = 10000;
const POLL_INTERVAL_MS = 250;
const STARTED_COMMAND = 'node server/index.ts';

// ---------------------------------------------------------------------------
// 0) 前置：config.json 必须存在
// ---------------------------------------------------------------------------

if (!existsSync(configPath)) {
  console.error('未找到 server/config.json，无法进行服务端检查。');
  console.error('请先复制示例配置：');
  console.error('  cp server/config.example.json server/config.json');
  console.error('apiKey 可留空（健康检查仍会通过，providerReady/searchReady 为 false）。');
  process.exit(1);
}

// 读取端口（用于轮询）；文件破损则明确报错退出。
let config;
try {
  config = JSON.parse(readFileSync(configPath, 'utf8'));
} catch (err) {
  const detail = err instanceof Error ? err.message : String(err);
  console.error(`server/config.json 不是合法 JSON：${detail}`);
  console.error('可从示例重新复制：cp server/config.example.json server/config.json');
  process.exit(1);
}
// 仅校验 config.json 为合法 JSON；检查用端口与配置由下方临时配置决定（不读本地真实 key）。

// ---------------------------------------------------------------------------
// 工具：捕获带退出码的命令输出
// ---------------------------------------------------------------------------

function run(command, args) {
  const res = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    // Windows: `npx`/`npm` are .cmd shims; without a shell spawnSync cannot resolve them (status=null).
    shell: process.platform === 'win32',
  });
  const output = `${res.stdout || ''}${res.stderr || ''}`.trim();
  const tail = output.length > 2000 ? output.slice(-2000) : output;
  return { command: [command, ...args].join(' '), exit: res.status, output_tail: tail };
}

// ---------------------------------------------------------------------------
// 门禁：服务端 tsc + 全量 typecheck
// ---------------------------------------------------------------------------

const serverTsc = run('npx', ['tsc', '-p', 'server/tsconfig.json', '--noEmit']);
const fullTypecheck = run('npm', ['run', 'typecheck']);

// ---------------------------------------------------------------------------
// 拉起服务并轮询 /api/health
// ---------------------------------------------------------------------------

/** 取一个空闲的本机端口（避免与正在运行的 dev:api 抢 config.json 里的端口）。 */
async function findFreePort() {
  return await new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      const p = typeof addr === 'object' && addr !== null ? addr.port : 0;
      probe.close(() => resolvePort(p));
    });
  });
}

const port = await findFreePort();
const tempConfigPath = resolve(tmpdir(), `mhp-check-server-${process.pid}.json`);
writeFileSync(
  tempConfigPath,
  `${JSON.stringify(
    {
      port,
      demo: false,
      llm: { baseUrl: '', apiKey: '', model: '' },
      search: { baseUrl: '', apiKey: '' },
      authorityDomains: [],
    },
    null,
    2
  )}\n`
);

const child = spawn('node', ['server/index.ts'], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, MHP_CONFIG_PATH: tempConfigPath },
});
let serverLog = '';
child.stdout.on('data', (chunk) => {
  serverLog += chunk.toString();
});
child.stderr.on('data', (chunk) => {
  serverLog += chunk.toString();
});

async function waitForHealth() {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) {
        return { status: res.status, response: await res.json() };
      }
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await delay(POLL_INTERVAL_MS);
  }
  return { status: null, response: null, error: lastError };
}

async function stopServer() {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const deadline = Date.now() + 3000;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
    await delay(100);
  }
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
  }
}

let health;
try {
  health = await waitForHealth();
} finally {
  await stopServer();
  rmSync(tempConfigPath, { force: true });
}

// ---------------------------------------------------------------------------
// 断言
// ---------------------------------------------------------------------------

const response = health.response;
const checks = {
  http_200: health.status === 200,
  ok_true: response?.ok === true,
  provider_ready_boolean: typeof response?.providerReady === 'boolean',
  search_ready_boolean: typeof response?.searchReady === 'boolean',
  demo_boolean: typeof response?.demo === 'boolean',
  provider_ready_false: response?.providerReady === false,
  search_ready_false: response?.searchReady === false,
  server_tsc_exit_0: serverTsc.exit === 0,
  full_typecheck_exit_0: fullTypecheck.exit === 0,
};
const passed = Object.values(checks).every((v) => v === true);

const summary = {
  passed,
  checks,
  health_status: health.status,
  health_error: health.error ?? null,
  server_log_tail: serverLog.length > 2000 ? serverLog.slice(-2000) : serverLog,
};

const artifact = {
  command: 'npx tsx scripts/check-server.mjs',
  timestamp: new Date().toISOString(),
  started_command: STARTED_COMMAND,
  port,
  health_response: response,
  server_tsc: serverTsc,
  full_typecheck: fullTypecheck,
  summary,
};

mkdirSync(dirname(healthPath), { recursive: true });
writeFileSync(healthPath, `${JSON.stringify(artifact, null, 2)}\n`);

console.log(`health HTTP status = ${health.status}`);
console.log(`health response = ${JSON.stringify(response)}`);
console.log(`server tsc exit=${serverTsc.exit}; full typecheck exit=${fullTypecheck.exit}`);
for (const [name, ok] of Object.entries(checks)) {
  console.log(`${ok ? 'PASS' : 'FAIL'} - ${name}`);
}
console.log(`wrote ${healthPath}`);
process.exit(passed ? 0 : 1);
