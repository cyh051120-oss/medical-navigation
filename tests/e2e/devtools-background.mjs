// Task 44 — WeChat DevTools backgrounding for E2E.
//
// What `automator.launch` actually runs (miniprogram-automator 0.12.1
// `out/Launcher.js`): it spawns
//   <cliPath> auto --project <projectPath> --auto-port <port> --trust-project
// with `stdio: 'ignore'`. The `cli auto` subcommand starts (or reuses) the IDE
// and opens the project; the automator then polls a WebSocket on
// `ws://127.0.0.1:<port>`, calls `checkVersion()`, and sleeps 5s before it
// resolves. The IDE process is `wechatdevtools` (bundle id
// `com.tencent.webplusdevtools`); it is NOT the spawned child, so killing the
// child does not quit the IDE.
//
// Acceptance ladder + what we MEASURED on this machine (2026-09-27):
//   ① `open` pre-launch: the nwjs IDE ignores -j (a shown window means a
//      pre-launch alone hides nothing). `open --args` DOES inject launch args on
//      a COLD launch.
//   ② System Events window minimize (`AXMinimized`) needs Accessibility, DENIED
//      here (`count windows` → -25211, `set AXMinimized` → -1719).
//
// ROOT CAUSE + FIX (final round, 2026-09-27): `App.captureScreenshot` only
// returns a frame while the IDE renderer keeps producing compositor frames.
// Backgrounding the window (process `visible` hide, minimize, occlusion) makes
// the first screenshot after a `reLaunch`/`navigateTo` hang forever (the
// automator connection has NO reply timeout) and makes repeated captures
// non-deterministic (different md5 for an unchanged page), breaking the md5
// render assertions in home/profile/settings. The root cause is Chromium
// renderer/window backgrounding, and it is FIXABLE by injecting the standard
// anti-throttle switches into the NW.js process command line at launch:
//     --disable-background-timer-throttling
//     --disable-renderer-backgrounding
//     --disable-backgrounding-occluded-windows
// MEASURED with the IDE process hidden (`set visible false`, permission-free):
//   without switches → every screenshot after reLaunch/navigateTo hangs (20s
//                      timeout) and navigateTo errors; md5 assertions unusable.
//   with switches    → first screenshot 55–86ms, repeated md5 identical
//                      (home ff27744e…, settings c8bc54e4…), navigateTo ok.
//   `NSAppSleepDisabled` alone does NOT help (identical hangs to control).
// Raw proof: artifacts/e2e/devtools-background.txt ("final round" section).
//
// Therefore this module INJECTS the switches on cold pre-launch via
// `open -g -a wechatwebdevtools --args <switches>`, and records whether the
// running IDE actually carries them. Hiding stays OPT-IN
// (`E2E_DEVTOOLS_MINIMIZE=1`) and is applied only when the switches are
// confirmed present; by default the IDE stays VISIBLE (existing semantics
// unchanged). It NEVER throws and NEVER fails a run. Hiding uses a
// permission-free process hide (`set visible false`).
import { spawnSync } from 'node:child_process';

/** Public identifiers for the WeChat DevTools app/process (macOS). */
export const DEVTOOLS = {
  app_name: 'wechatwebdevtools',
  bundle_id: 'com.tencent.webplusdevtools',
  process_name: 'wechatdevtools',
  app_path: '/Applications/wechatwebdevtools.app',
};

/**
 * Chromium/NW.js switches that stop the renderer from being backgrounded/
 * throttled when the IDE window is hidden. Injected at launch via
 * `open -g -a wechatwebdevtools --args …`. MEASURED effective (task 44 final
 * round): with these present, `App.captureScreenshot` returns while the process
 * is hidden (`visible=false`) and repeated captures are md5-stable; without
 * them every screenshot after reLaunch/navigateTo hangs.
 */
export const ANTI_THROTTLE_SWITCHES = [
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
];

const BG_PREFIX = '[e2e][devtools-bg]';
const GET_VISIBLE_SCRIPT = `tell application "System Events" to get visible of process "${DEVTOOLS.process_name}"`;
// `UI elements enabled` is a System Events global that reports whether
// Accessibility is granted; unlike window queries it never errors and does not
// need a live target window (process-independent, so it cannot race startup).
const UI_ELEMENTS_SCRIPT = 'tell application "System Events" to get UI elements enabled';
// Permission-free process hide — MEASURED to work WITHOUT Accessibility.
// Combined with ANTI_THROTTLE_SWITCHES it keeps App.captureScreenshot valid, so
// this is the hide mechanism used (opt-in via E2E_DEVTOOLS_MINIMIZE).
const HIDE_PROCESS_SCRIPT = `tell application "System Events" to set visible of process "${DEVTOOLS.process_name}" to false`;
const ACCESSIBILITY_GRANT_PATH = '系统设置 → 隐私与安全性 → 辅助功能 → 勾选 OpenCode';
// Pre-launching a COLD IDE with `open` makes an immediately-following
// `cli auto` race the IDE startup and time out its first attempt. Measured:
// with 0s settle attempt 1 fails at 30s; with ≥4s it succeeds on attempt 1.
// Hold for this long from `open` before letting the launch proceed; warm runs
// (IDE already running) skip it entirely.
const COLD_SETTLE_MS = 5000;

/** Truncate long text so evidence files stay readable (shared by helpers.mjs). */
export function truncate(value, max = 600) {
  const str = typeof value === 'string' ? value : String(value ?? '');
  if (str.length <= max) return str;
  return `${str.slice(0, max)}\n…[truncated ${str.length - max} chars]`;
}

function bgLog(msg) {
  console.log(`${BG_PREFIX} ${msg}`);
}

/** Public logger so callers (helpers.launchMiniProgram) share the same prefix. */
export function devtoolsLog(msg) {
  bgLog(msg);
}

function bgWarn(msg) {
  console.error(`${BG_PREFIX} ${msg}`);
}

export function delayMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function devtoolsProcessRunning() {
  const res = spawnSync('pgrep', ['-x', DEVTOOLS.process_name], { encoding: 'utf8' });
  return res.status === 0;
}

function osaSync(script) {
  const res = spawnSync('osascript', ['-e', script], { encoding: 'utf8' });
  return {
    exit_code: res.status,
    stdout: (res.stdout || '').trim(),
    stderr: (res.stderr || '').trim(),
  };
}

/** PID + full command line of the running devtools main process (or null). */
function devtoolsMainProcess() {
  const pid = (spawnSync('pgrep', ['-x', DEVTOOLS.process_name], { encoding: 'utf8' }).stdout || '')
    .trim()
    .split('\n')
    .filter(Boolean)
    .pop();
  if (!pid) return { pid: null, command: '' };
  const res = spawnSync('ps', ['-ww', '-o', 'command=', '-p', pid], { encoding: 'utf8' });
  return { pid, command: (res.stdout || '').trim() };
}

/**
 * Whether the running IDE carries the anti-throttle switches. Hiding the IDE is
 * only screenshot-safe when this is true, so the opt-in hide path gates on it.
 * `open --args` applies only on a COLD launch: a warm IDE started outside the
 * wrapper will not carry them, and hiding is then skipped (never breaks E2E).
 */
function devtoolsAntiThrottleState() {
  const { pid, command } = devtoolsMainProcess();
  const switches = ANTI_THROTTLE_SWITCHES.map((flag) => ({
    switch: flag,
    present: command.includes(flag),
  }));
  return {
    pid,
    all_present: pid !== null && switches.every((s) => s.present),
    switches,
    command: truncate(command, 600),
  };
}

async function detectDevtoolsBackground() {
  const startedAt = Date.now();
  const alreadyRunning = devtoolsProcessRunning();

  // Rung ① — inject anti-throttle switches + pre-launch (permission-free, never throws).
  const openAt = Date.now();
  const openRes = spawnSync(
    'open',
    ['-g', '-a', DEVTOOLS.app_name, '--args', ...ANTI_THROTTLE_SWITCHES],
    { encoding: 'utf8' }
  );
  const rung1 = {
    attempted: true,
    command: `open -g -a ${DEVTOOLS.app_name} --args ${ANTI_THROTTLE_SWITCHES.join(' ')}`,
    already_running: alreadyRunning,
    exit_code: openRes.status,
    stderr: (openRes.stderr || '').trim(),
  };
  bgLog(`rung1 \`${rung1.command}\`: exit=${rung1.exit_code} already_running=${alreadyRunning}`);

  // Let the app appear before probing (open returns immediately). `--args` only
  // takes effect on a COLD launch; hold so `cli auto` does not race startup.
  if (!alreadyRunning) {
    const deadline = Date.now() + 4000;
    while (!devtoolsProcessRunning() && Date.now() < deadline) await delayMs(150);
    const remaining = COLD_SETTLE_MS - (Date.now() - openAt);
    if (remaining > 0) await delayMs(remaining);
    bgLog(`cold pre-launch: held ${COLD_SETTLE_MS}ms from open before launch (avoids cli auto race)`);
  }
  rung1.process_present_after_open = devtoolsProcessRunning();
  rung1.anti_throttle = devtoolsAntiThrottleState();
  const vis = rung1.process_present_after_open
    ? osaSync(GET_VISIBLE_SCRIPT)
    : { exit_code: null, stdout: '', stderr: '' };
  rung1.post_open_visible = vis.exit_code === 0 ? vis.stdout : null;
  bgLog(
    `rung1 observed: process_present=${rung1.process_present_after_open} post_open_visible=${rung1.post_open_visible} ` +
      `anti_throttle_all_present=${rung1.anti_throttle.all_present}`
  );

  // Rung ② — hide capability. The AX window minimize needs Accessibility (probe
  // with a read-only query); the process hide (`set visible false`) is
  // permission-free and is the preferred mechanism.
  const probe = osaSync(UI_ELEMENTS_SCRIPT);
  const rung2 = {
    attempted: true,
    command: `osascript -e '${UI_ELEMENTS_SCRIPT}'`,
    exit_code: probe.exit_code,
    stdout: probe.stdout,
    stderr: probe.stderr,
    accessibility_available: probe.exit_code === 0 && probe.stdout === 'true',
    hide_mechanism: null,
    enabled: false,
    reason: null,
  };

  const optIn = process.env.E2E_DEVTOOLS_MINIMIZE === '1';
  const antiThrottle = rung1.anti_throttle;
  let chosen = 'none';
  let notice = null;
  if (!optIn) {
    // Default: no hide (existing semantics). Injection still runs so a later
    // opt-in is safe.
    rung2.reason = 'hide is opt-in (E2E_DEVTOOLS_MINIMIZE=1 not set); IDE stays visible';
    chosen = 'none-visible';
    notice = buildDevtoolsNotice(rung1, rung2, optIn);
  } else if (!antiThrottle.all_present) {
    rung2.reason =
      'E2E_DEVTOOLS_MINIMIZE=1 but the running IDE does NOT carry the anti-throttle switches ' +
      '(open --args applies only on a cold launch); skipping hide to avoid hanging screenshots';
    chosen = 'none-unsafe';
    notice = buildDevtoolsNotice(rung1, rung2, optIn);
  } else {
    rung2.enabled = true;
    rung2.hide_mechanism = 'process-visible-false (permission-free)';
    chosen = 'process-hide';
    bgLog('chosen hide=process-visible-false (anti-throttle present, E2E_DEVTOOLS_MINIMIZE=1)');
  }

  if (notice) {
    const bar = '='.repeat(64);
    bgWarn('');
    bgWarn(bar);
    bgWarn('[e2e] 后台化提示（task 44）');
    bgWarn(notice);
    bgWarn(bar);
    bgWarn('');
  }

  return {
    rung1,
    rung2,
    anti_throttle: antiThrottle,
    chosen,
    notice_printed: notice !== null,
    detected_in_ms: Date.now() - startedAt,
  };
}

/** One-time readable notice describing the current hide state + how to enable it. */
function buildDevtoolsNotice(rung1, rung2, optIn) {
  const at = rung1.anti_throttle?.all_present ? '在位' : '未在位(仅冷启动注入)';
  return (
    `微信开发者工具默认保持可见（anti-throttle 开关:${at}）。\n` +
    '  实测：开关在位时即使隐藏 IDE 进程，reLaunch/navigateTo 后截图 <100ms 且 md5 稳定。\n' +
    '  不抢屏(opt-in): 设 E2E_DEVTOOLS_MINIMIZE=1 → 免权限隐藏进程(set visible false)，截图仍有效。\n' +
    `  当前: E2E_DEVTOOLS_MINIMIZE=${optIn ? '1' : '未设置'}；${rung2.reason}\n` +
    `  可选 AX 最小化授权: ${ACCESSIBILITY_GRANT_PATH}（本机未授权，非必须）。`
  );
}

let devtoolsBgPromise = null;

/**
 * Detect devtools backgrounding capability once per process. Safe to call
 * from any spec; `launchMiniProgram` invokes it internally.
 */
export function prepareDevtoolsBackground() {
  if (!devtoolsBgPromise) devtoolsBgPromise = detectDevtoolsBackground();
  return devtoolsBgPromise;
}

/**
 * Apply the chosen hide after the launch (opt-in, permission-free). Returns the
 * osascript result, or null when no hide is configured. Never throws.
 */
export function applyDevtoolsHide(bg) {
  if (!bg || bg.chosen !== 'process-hide') return null;
  const hide = osaSync(HIDE_PROCESS_SCRIPT);
  bgLog(
    `process-hide after launch: exit=${hide.exit_code}${hide.stderr ? ` (${hide.stderr})` : ''}`
  );
  return hide;
}
