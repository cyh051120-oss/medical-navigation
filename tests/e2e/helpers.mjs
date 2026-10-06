// E2E harness shared helpers for the personal-medical-prep-assistant project.
// Zero runtime deps beyond Node built-ins; loaded by run.mjs and app-shell.spec.mjs.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import automator from 'miniprogram-automator';
import {
  ANTI_THROTTLE_SWITCHES,
  DEVTOOLS,
  applyDevtoolsHide,
  delayMs,
  devtoolsLog,
  prepareDevtoolsBackground,
  truncate,
} from './devtools-background.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Preserve the Task-44 public surface (moved to ./devtools-background.mjs).
export { ANTI_THROTTLE_SWITCHES, DEVTOOLS, prepareDevtoolsBackground, truncate };
// `delay` remains importable from helpers (Task-44 surface); its one definition
// lives in the leaf devtools-background.mjs, so this is a pure re-export.
export { delayMs as delay };

/** Repository root (…/医疗导诊). */
export const ROOT = path.resolve(__dirname, '..', '..');

/** Artifacts directory for E2E evidence. */
export const E2E_ARTIFACTS = path.join(ROOT, 'artifacts', 'e2e');

/** True on Windows: DevTools automation needs a different launch path there (see launchViaCmd). */
export const IS_WINDOWS = process.platform === 'win32';

/**
 * DevTools CLI candidates when AUTOMATOR_CLI is not set.
 * Windows ships a `cli.bat` (the macOS build ships a `cli` binary).
 */
const WINDOWS_CLI_CANDIDATES = [
  'C:\\Program Files (x86)\\Tencent\\微信web开发者工具\\cli.bat',
  'C:\\Program Files\\Tencent\\微信web开发者工具\\cli.bat',
  'C:\\Program Files\\Tencent\\微信开发者工具\\cli.bat',
];

function defaultCliPath() {
  if (!IS_WINDOWS) return '/Applications/wechatwebdevtools.app/Contents/MacOS/cli';
  for (const candidate of WINDOWS_CLI_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return WINDOWS_CLI_CANDIDATES[0];
}

/** Resolved harness defaults; every value can be overridden by env. */
export const CONFIG = {
  cliPath: process.env.AUTOMATOR_CLI || defaultCliPath(),
  projectPath: path.join(ROOT, 'hospital-ai-miniapp'),
  port: Number(process.env.AUTOMATOR_PORT || 9420),
  timeout: Number(process.env.AUTOMATOR_TIMEOUT || 30000),
};

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function log(msg) {
  console.log(`[e2e] ${msg}`);
}

export function section(title) {
  console.log(`\n===== ${title} =====`);
}

export function ok(msg) {
  console.log(`[e2e] PASS ${msg}`);
}

export function fail(msg) {
  console.log(`[e2e] FAIL ${msg}`);
}

/** 500ms TCP reachability probe (used for the automation port). */
export function tcpProbe(port, host = '127.0.0.1', timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    try {
      socket.connect(port, host);
    } catch {
      done(false);
    }
  });
}

/**
 * Best-effort cleanup of devtools CLI "auto" processes spawned by a failed
 * launch (they linger and hold the automator port). Scoped to this project
 * path so unrelated devtools sessions are untouched.
 */
export function cleanupDevtools(projectPath = CONFIG.projectPath) {
  // `pkill` is macOS-only; on Windows the devtools CLI `close` command owns cleanup.
  if (IS_WINDOWS) return false;
  // Match both wrapper (`cli auto --project …`) and helper (`cli.js auto …`)
  // processes; the project path keeps it scoped to this repo.
  const res = spawnSync('pkill', ['-f', projectPath], { encoding: 'utf8' });
  return res.status === 0;
}

/** Best-effort frontmost application name (observable without Accessibility). */
function frontAppName() {
  // `lsappinfo` is macOS-only; the name is only used for observability logging.
  if (IS_WINDOWS) return 'unknown';
  try {
    const asn = (spawnSync('lsappinfo', ['front'], { encoding: 'utf8' }).stdout || '').trim();
    if (!asn) return 'unknown';
    const out =
      spawnSync('lsappinfo', ['info', '-only', 'name', asn], { encoding: 'utf8' }).stdout || '';
    const match = out.match(/"([^"]+)"/);
    return match ? match[1] : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Windows launch path.
 *
 * `miniprogram-automator` starts the DevTools CLI with `spawn(cliPath, args)` and **no shell**;
 * on Windows that CLI is a `.bat`, which Node >= 20 refuses to spawn without a shell (EINVAL),
 * and automator reports it as the unhelpful "please make sure cliPath is correctly specified".
 * It also runs the CLI with `stdio: 'ignore'`, so the CLI's own diagnostics (such as
 * 「工具的服务端口已关闭 / IDE service port disabled」) never reach the caller.
 *
 * So on Windows we start the CLI ourselves via `cmd.exe /c` (capturing its output for diagnosis)
 * and then attach to the very endpoint automator would have used: `ws://127.0.0.1:<auto-port>`.
 */
async function launchViaCmd({ cliPath, projectPath, port, timeout }) {
  const args = ['auto', '--project', projectPath, '--auto-port', String(port)];
  // NOTE (verified): the CLI's "please enter y to confirm enabling CLI capability" prompt
  // cannot be answered from here. Piping `y` to stdin was tried and the CLI still reported
  // 「工具的服务端口已关闭」, i.e. it needs a real console/TTY. So the IDE-side setting
  // (设置 -> 安全设置 -> 服务端口) genuinely requires the operator; we surface the CLI's own
  // message instead of pretending we can flip it.
  const child = spawn('cmd.exe', ['/c', cliPath, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  let spawnError = null;
  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    output += chunk.toString();
  });
  child.on('error', (err) => {
    spawnError = err;
  });

  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (spawnError !== null) throw new Error(`devtools CLI spawn failed: ${spawnError.message}`);
    try {
      return await automator.connect({ wsEndpoint: `ws://127.0.0.1:${port}` });
    } catch {
      await delayMs(1000);
    }
  }
  throw new Error(
    `devtools automation endpoint ws://127.0.0.1:${port} never came up within ${timeout}ms\n` +
      `  cliPath: ${cliPath}\n` +
      `  CLI output (tail):\n${truncate(output.trim() === '' ? '(no output)' : output.trim(), 1500)}`
  );
}

/**
 * Shared launch wrapper: run the backgrounding ladder (./devtools-background.mjs),
 * then launch the miniprogram with the house retry semantics (default: 2
 * attempts, 1.5s delay). Throws the same error message as the old per-spec
 * `launchWithRetry`.
 *
 * The macOS backgrounding ladder (open/lsappinfo/osascript) and `applyDevtoolsHide` are
 * macOS-only; on Windows they are skipped and the CLI is started by `launchViaCmd` instead.
 */
export async function launchMiniProgram(options = {}) {
  const { retries = 2, delayMs: retryDelayMs = 1500, ...launchOptions } = options;
  const bg = IS_WINDOWS ? null : await prepareDevtoolsBackground();
  devtoolsLog(`frontmost before launch: ${JSON.stringify(frontAppName())}`);

  const launchArgs = {
    cliPath: CONFIG.cliPath,
    projectPath: CONFIG.projectPath,
    port: CONFIG.port,
    timeout: CONFIG.timeout,
    trustProject: true,
    ...launchOptions,
  };

  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const miniProgram = IS_WINDOWS
        ? await launchViaCmd(launchArgs)
        : await automator.launch(launchArgs);
      log(`launch OK (attempt ${attempt}/${retries})`);
      if (bg !== null) applyDevtoolsHide(bg);
      devtoolsLog(`frontmost after launch: ${JSON.stringify(frontAppName())}`);
      return miniProgram;
    } catch (err) {
      lastError = err;
      fail(`launch attempt ${attempt}/${retries} failed: ${err?.message || err}`);
      if (attempt < retries) await delayMs(retryDelayMs);
    }
  }
  throw new Error(`launch failed after ${retries} attempts: ${lastError?.message || lastError}`);
}

/** Read project app.json and return the declared first page path. */
export function readExpectedFirstPage(projectPath = CONFIG.projectPath) {
  const appJsonPath = path.join(projectPath, 'app.json');
  const appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
  const pages = Array.isArray(appJson.pages) ? appJson.pages : [];
  if (pages.length === 0) {
    throw new Error(`app.json at ${appJsonPath} declares no pages`);
  }
  return { appJsonPath, expected: pages[0], pages };
}

/**
 * Print a readable failure banner plus the standard retry guidance.
 * Never writes "pass" anywhere — callers decide the exit code.
 */
export function failWithGuidance(message, extra = '') {
  const bar = '='.repeat(64);
  console.error(`\n${bar}`);
  console.error('E2E BOOTSTRAP FAILED');
  console.error(bar);
  console.error(`cause: ${message}`);
  if (extra) {
    console.error('');
    console.error(truncate(extra, 2000));
  }
  console.error('\n重试指引 (RETRY GUIDANCE):');
  console.error(
    '  1. 安装微信开发者工具 / 确认 CLI 路径存在（默认 /Applications/wechatwebdevtools.app/Contents/MacOS/cli，可用 AUTOMATOR_CLI 覆盖）'
  );
  console.error(
    '  2. 打开微信开发者工具 → 设置 → 安全设置 → 开启「服务端口」'
  );
  console.error(
    '  3. 端口被占用时用 AUTOMATOR_PORT=<port> 覆盖（确认端口未被其它进程占用）'
  );
  console.error('  4. 重跑 npm run test:e2e');
  console.error(bar);
}

/** Recovery document written when the happy path cannot run. */
export function writeBlockedDoc(cause, prereq) {
  ensureDir(E2E_ARTIFACTS);
  const md = `# E2E BLOCKED — T5 bootstrap harness

- timestamp: ${new Date().toISOString()}
- cause: ${cause}
- cli_path_checked: ${prereq?.cli_path_checked ?? 'n/a'}
- cli_exists: ${prereq?.cli_exists ?? 'n/a'}
- automation_port: ${prereq?.automation_port ?? 'n/a'}
- port_reachable: ${prereq?.port_reachable ?? 'n/a'}

状态：**BLOCKED（未通过）**。由用户决定是否继续；禁止写成通过。

## 恢复步骤 (recovery)

1. 安装微信开发者工具（macOS），确认 CLI 可执行文件存在：
   \`ls -la /Applications/wechatwebdevtools.app/Contents/MacOS/cli\`
2. 打开微信开发者工具 → 设置 → 安全设置 → 开启「服务端口」。
3. 若自动化端口被占用，用 \`AUTOMATOR_PORT=<port>\` 覆盖后重跑。
4. 若 CLI 路径不同，用 \`AUTOMATOR_CLI=<path>\` 覆盖。
5. 重跑：\`npm run test:e2e\`。

## 替代证据路径 (alternative evidence)

自动化不可用时，以下人工/静态证据可替代 E2E 冒烟：

### A. 开发者工具人工截图清单
- 打开项目 \`hospital-ai-miniapp\`（导入 \`project.config.json\`）。
- 首屏（应等于 \`app.json\` 的 \`pages[0]\`，当前为 \`pages/home/home\`）截图。
- 逐页打开 \`app.json.pages\` 每一页并截图，确认可渲染、无白屏/报错。
- 截图保存至 \`artifacts/screenshots/manual/\` 并附 \`index.json\`（文件名 + 页面路径 + 时间）。

### B. static / node 检查
- \`npm run test:scan\` —— 能力禁令/密钥/权限静态扫描（基线退出 1 属预期，见 artifacts/scan）。
- \`npx tsc -p hospital-ai-miniapp/tsconfig.json --noEmit\` 与 \`npx tsc -p server/tsconfig.json --noEmit\` —— 类型检查（Wave A 无 \`.ts\` 输入时 TS18003 被容忍）。
- \`node --check\` 覆盖的 \`.js\`/\`.mjs\` 文件（由 static-scan 执行）。
`;
  fs.writeFileSync(path.join(E2E_ARTIFACTS, 'blocked.md'), md);
  return path.join(E2E_ARTIFACTS, 'blocked.md');
}

// ---------------------------------------------------------------------------
// Shared screenshot-capture infrastructure (style task 41 / soft task 38).
//
// Both tests/e2e/screenshots.mjs (style-refactor) and
// tests/e2e/screenshots-soft.mjs (soft-copyright) drive a mini-program through
// the same launch/seed/settle primitives. Those primitives are defined here so
// each engine keeps a single, importable definition (F2-B4 dedup). Both engines
// are import-safe: importing either module has no top-level side effects, while
// `node <engine>.mjs` still runs its own main().
//
// Module-private (not exported because no consumer outside this module): NS,
// T0, TEXTS_TS, PNG_SIGNATURE. The byte-identical engine constant PAGES stays in
// each engine because only that engine's own main()/capture() consume it (not
// needed by any moved code). withTimeout is now exported (F2-B5a) so the specs
// and the embedded logic harness share one definition; see the "spec/harness
// shared helpers" section at the end of this file for the rest of the surface.
// ---------------------------------------------------------------------------

const NS = 'mhp_';

/** Storage-key suffixes shared by both screenshot engines. */
export const KEYS = {
  profile: 'records_profile',
  symptoms: 'records_symptoms',
  notes: 'records_notes',
  questions: 'records_questions',
  briefs: 'records_briefs',
  memory: 'records_memory',
  preferences: 'records_preferences',
  aiMessages: 'ai_messages',
  aiAck: 'ai_consult_ack',
};

// deterministic seed timestamp shared by the screenshot fixtures
const T0 = '2026-08-01T01:00:00.000Z';

// ---------------------------------------------------------------------------
// deterministic seed data (fictional persona only; no secrets, no real PII)
// ---------------------------------------------------------------------------
export function seedProfile() {
  return [
    {
      id: 'prof_shot_1',
      createdAt: T0,
      updatedAt: '2026-08-10T01:00:00.000Z',
      name: '李阿姨',
      ageRange: '60-69',
      gender: '',
      allergies: '青霉素',
      medications: '氯沙坦',
      history: '高血压（2019 年起长期随访）',
    },
  ];
}

export function seedSymptoms() {
  return [
    {
      id: 'sym_shot_1',
      createdAt: '2026-09-01T01:00:00.000Z',
      updatedAt: '2026-09-01T01:00:00.000Z',
      occurredAt: '2026-09-10T02:00:00.000Z',
      duration: '3 天',
      text: '最近一周夜里反复咳嗽，平躺时更明显，白天有所缓解。',
      impact: '影响睡眠',
      tags: ['咳嗽', '夜间'],
      attachment: null,
    },
    {
      id: 'sym_shot_2',
      createdAt: '2026-09-05T01:00:00.000Z',
      updatedAt: '2026-09-05T01:00:00.000Z',
      occurredAt: '2026-09-12T09:30:00.000Z',
      duration: '20 分钟',
      text: '饭后有点腹胀，走动后好转。',
      impact: '没影响睡眠',
      tags: ['饭后', '腹胀'],
      attachment: null,
    },
  ];
}

export function seedNotes() {
  return [
    {
      id: 'note_shot_1',
      createdAt: '2026-09-03T01:00:00.000Z',
      updatedAt: '2026-09-03T01:00:00.000Z',
      name: '社区体检报告',
      excerpt: '血压偏高，建议复查；甘油三酯 2.1 mmol/L。',
      sourceDate: '2026-08-20',
      attachment: null,
      remark: '',
    },
    {
      id: 'note_shot_2',
      createdAt: '2026-09-06T01:00:00.000Z',
      updatedAt: '2026-09-06T01:00:00.000Z',
      name: '门诊病历摘录',
      excerpt: '主诉咳嗽两周，医生建议观察。',
      sourceDate: '2026-09-02',
      attachment: null,
      remark: '带上原件',
    },
  ];
}

export function seedQuestions() {
  return [
    {
      id: 'ques_shot_1',
      createdAt: '2026-09-04T01:00:00.000Z',
      updatedAt: '2026-09-04T01:00:00.000Z',
      text: '咳嗽是否需要进一步检查',
      done: false,
      group: '呼吸',
      source: 'manual',
    },
    {
      id: 'ques_shot_2',
      createdAt: '2026-09-04T02:00:00.000Z',
      updatedAt: '2026-09-04T02:00:00.000Z',
      text: '现在的降压药需要调整吗',
      done: true,
      group: '用药',
      source: 'manual',
    },
    {
      id: 'ques_shot_3',
      createdAt: '2026-09-04T03:00:00.000Z',
      updatedAt: '2026-09-04T03:00:00.000Z',
      text: '复查时间怎么安排',
      done: false,
      group: '复查',
      source: 'manual',
    },
  ];
}

export function seedMemory() {
  return [
    {
      id: 'mem_shot_1',
      createdAt: '2026-09-05T01:00:00.000Z',
      updatedAt: '2026-09-05T01:00:00.000Z',
      text: '希望回复简短一些',
      source: 'manual',
      enabled: true,
    },
    {
      id: 'mem_shot_2',
      createdAt: '2026-09-05T02:00:00.000Z',
      updatedAt: '2026-09-05T02:00:00.000Z',
      text: '更关注用药与复查安排',
      source: 'ai',
      enabled: true,
    },
  ];
}

// ---------------------------------------------------------------------------
// storage helpers (over the automator callWxMethod transport)
// ---------------------------------------------------------------------------
export async function setKey(mp, raw, value) {
  await mp.callWxMethod('setStorageSync', NS + raw, value);
}
export async function delKey(mp, raw) {
  await mp.callWxMethod('removeStorageSync', NS + raw);
}
export async function clearAll(mp) {
  for (const raw of Object.values(KEYS)) await delKey(mp, raw);
}

// ---------------------------------------------------------------------------
// automator helpers
// ---------------------------------------------------------------------------
export function withTimeout(promise, ms, label) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ timedOut: true, label });
    }, ms);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ timedOut: false, value });
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ timedOut: false, error: error?.message || String(error) });
      }
    );
  });
}

export async function evaluateSafe(mp, fn, ms = 15000, ...args) {
  const raced = await withTimeout(mp.evaluate(fn, ...args), ms, 'evaluate');
  if (raced.timedOut || raced.error !== undefined) {
    return { ok: false, error: raced.timedOut ? 'timed out' : raced.error };
  }
  return { ok: true, value: raced.value };
}

/** reLaunch to a route then settle; default 900ms matches the style engine. */
export async function goto(mp, route, settle = 900) {
  await mp.reLaunch('/' + route);
  await delayMs(settle);
}

// ---------------------------------------------------------------------------
// spec/harness shared helpers (F2-B5a — one definition per same-body family).
//
// Every spec and every embedded logic harness (HARNESS_SOURCE) that used to
// carry a local byte-identical copy imports from here instead. Pure helpers are
// direct exports; helpers that close over per-spec module state are factories so
// the call sites stay unchanged (`const X = makeX(state);` at the old def site).
// ---------------------------------------------------------------------------

/** Safe read: returns '' when the file is missing/unreadable (never throws). */
export function readSafe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

export function md5(buffer) {
  return crypto.createHash('md5').update(buffer).digest('hex');
}

export function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export function clone(v) { return JSON.parse(JSON.stringify(v)); }

export function blockTitles(msg) { return msg.blocks.map(function (b) { return b.title; }); }

// Superset of the two former bodies: the extra `title === undefined ||` branch is
// unreachable for every current call site (all pass a title), so it is
// behaviour-preserving while unifying ai-page's variant with the others.
export function hasBlock(msg, type, title) {
  return msg.blocks.some(function (b) { return b.type === type && (title === undefined || b.title === title); });
}

export function lastMsg(inst) { return inst.data.messages[inst.data.messages.length - 1]; }

const TEXTS_TS = path.join(CONFIG.projectPath, 'config', 'texts.ts');

export function aiCopyBlock() {
  const src = readSafe(TEXTS_TS);
  const start = src.indexOf('export const AI');
  if (start === -1) return '';
  const end = src.indexOf('} as const;', start);
  return end === -1 ? src.slice(start) : src.slice(start, end);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function hasPngMagic(buffer) {
  return buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE);
}

/** Poll an HTTP health URL until it answers or the deadline passes. */
export async function waitForHealth(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    let res = null;
    try {
      res = await fetch(url);
      if (res.ok) return { status: res.status, response: await res.json() };
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    } finally {
      // Non-2xx/aborted responses must release their body, or undici keeps the socket out of the
      // pool. A poll loop would otherwise strand one connection per attempt.
      if (res !== null) {
        try {
          await res.body?.cancel();
        } catch {
          // Body already consumed (2xx) or closed; nothing left to release.
        }
      }
    }
    await delayMs(250);
  }
  return { status: null, response: null, error: lastError };
}

/** `check(id, name, pass, details)` pushed into the spec's `cases` array. */
export function makeCheck(cases) {
  return function check(id, name, pass, details) { cases.push({ id: id, name: name, pass: pass === true, details: details }); };
}

/** `flog(line)` appended to the spec's failure-lines array. */
export function makeFlog(failureLines) {
  return function flog(line) { failureLines.push(line); };
}

/**
 * Page-instance builder over a captured Page config. `capturedRef` may be the
 * config itself or a getter (`() => captured`) for specs that reassign `captured`.
 * `cloneExtras` mirrors the former two variants: false binds functions only
 * (the default), true also clones non-function, non-data keys.
 */
export function makeInstanceFactory(capturedRef, options = {}) {
  const cloneExtras = options.cloneExtras === true;
  const getCaptured = typeof capturedRef === 'function' ? capturedRef : () => capturedRef;
  return function makeInstance() {
    const captured = getCaptured();
    const inst = { data: clone(captured.data), setData: function (patch) { Object.assign(this.data, patch); } };
    for (const key of Object.keys(captured)) {
      if (key === 'data') continue;
      const val = captured[key];
      if (typeof val === 'function') {
        inst[key] = val.bind(inst);
      } else if (cloneExtras) {
        inst[key] = clone(val);
      }
    }
    return inst;
  };
}

/** `seedRecords()` for the two harnesses that seeded identical fixtures. */
export function makeSeedRecords(records) {
  return function seedRecords() {
    records.profile.add({ name: '张三', ageRange: '60-69', gender: '', allergies: '', medications: '', history: '' });
    records.symptoms.add({ occurredAt: '2026-09-10T02:00:00.000Z', duration: '3 天', text: '饭后有点胀', impact: '', tags: [], attachment: null });
  };
}

/** `clearAiKeys(mp)` removing every `mhp_<raw>` key for the given raw list. */
export function makeClearAiKeys(storageKeys) {
  return async function clearAiKeys(miniProgram) {
    for (const raw of storageKeys) {
      await miniProgram.callWxMethod('removeStorageSync', 'mhp_' + raw);
    }
  };
}

/** `lastToast()` → last toast title string or null, over the spec's `calls`. */
export function makeLastToast(calls) {
  return function lastToast() { const t = calls.toast[calls.toast.length - 1]; return t && typeof t.title === 'string' ? t.title : null; };
}

export function makeStoreKeys(store) {
  return function storeKeys() { return Array.from(store.keys()).sort(); };
}

export function makeSnapshot(store, storeKeys) {
  return function snapshot() { return JSON.stringify(storeKeys().map(function (k) { return [k, store.get(k)]; })); };
}

/** `rawList(key = defaultKey)` over the spec's `store` (Map). */
export function makeRawList(store, defaultKey) {
  return function rawList(key = defaultKey) { const v = store.get(key); return Array.isArray(v) ? v : []; };
}

export function makeLastToastIsSuccess(calls) {
  return function lastToastIsSuccess() { const t = calls.toast[calls.toast.length - 1]; return !!(t && t.icon === 'success'); };
}

export function makeAttachFiles(files, attachDir) {
  return function attachFiles() { return Array.from(files.keys()).filter(function (k) { return k.indexOf(attachDir) === 0; }); };
}

/**
 * Screenshot capture for a spec; `name` is the spec token used in the temp path
 * template (`mhp-e2e-<name>-<tag>-<ms>.png`). Returns `{ bytes, md5, pngMagic }`.
 */
export function makeCaptureScreenshot(name) {
  return async function captureScreenshot(miniProgram, tag) {
    const shotPath = path.join(os.tmpdir(), `mhp-e2e-${name}-${tag}-${Date.now()}.png`);
    await miniProgram.screenshot({ path: shotPath });
    const shot = fs.readFileSync(shotPath);
    fs.unlinkSync(shotPath);
    return { bytes: shot.length, md5: md5(shot), pngMagic: hasPngMagic(shot) };
  };
}

/** `renderEvidence` over a bound capture fn + the spec's expected route path. */
export function makeRenderEvidence(captureScreenshot, route) {
  return async function renderEvidence(miniProgram, tag) {
    const stack = await miniProgram.pageStack();
    const top = Array.isArray(stack) && stack.length > 0 ? stack[stack.length - 1] : null;
    const shot = await captureScreenshot(miniProgram, tag);
    return {
      pageStack: stack.length,
      topPath: top ? top.path : null,
      screenshotBytes: shot.bytes,
      screenshotMd5: shot.md5,
      pngMagic: shot.pngMagic,
      ok: stack.length >= 1 && top !== null && top.path === route && shot.pngMagic && shot.bytes > 5000,
    };
  };
}
