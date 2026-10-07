// tests/e2e/screenshots-soft.mjs — deterministic software-copyright screenshot set (task 38).
//
// Run (cold, hidden), TWICE with distinct manifests, then compare SHA256:
//   E2E_DEVTOOLS_MINIMIZE=1 MHP_SHOT_MANIFEST=/tmp/mhp-run1.json node tests/e2e/screenshots-soft.mjs
//   E2E_DEVTOOLS_MINIMIZE=1 MHP_SHOT_MANIFEST=/tmp/mhp-run2.json node tests/e2e/screenshots-soft.mjs
//
// Out (PNG set):  artifacts/screenshots/soft-copyright/   (env MHP_SHOT_OUT)
// Manifest:       $MHP_SHOT_MANIFEST (default: os tmpdir — NOT in the repo)
//
// Determinism tactics (task 38 MUST DO #3):
//   - no loading/spinner states captured at all (`.mhp-loading` never rendered);
//   - inputs are driven via page methods (onInput) so no native caret exists;
//   - home greeting (hour-based in home.ts:89-93,210) is pinned via setData;
//   - fixed capture order + fixed seed content + fixed settle delays;
//   - AI shots run in demo mode (preferences {aiEnabled:true, demoMode:true}) => zero network.
//
// Cross-run convergence (task 38 fix, in place of the failed "one capture, two runs" check):
//   The home page's 健康档案 bar (`.wb-status__fill`, `home.wxss`) rasterizes its
//   rounded end caps with a latent ±1/255 anti-aliasing flip that is independent of settle
//   time (observed even at settle 0) and of a fresh process: it is a rare, *isolated*
//   per-render flip (measured 2/40 renders), while two screenshots of the SAME render are
//   always byte-identical. So a bigger constant delay cannot fix it. Instead the home shot
//   is accepted only after HOME_STABLE_K *consecutive* independent re-renders are byte-equal
//   (each sample is preceded by a fresh reLaunch + greeting re-pin). Isolated flips can never
//   form a run, so every cold run converges to the canonical frame.
//
// Import-safe (F2-B4): importing this module has ZERO side effects — every execution sits behind
// the `import.meta` main-guard at the bottom. Shared capture infrastructure (launch/seed/settle
// helpers + storage KEYS) lives in ./helpers.mjs and is used by both this engine and the
// style-refactor engine (task 41); each engine keeps its own main() and shot plan.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  CONFIG,
  KEYS,
  ROOT,
  clearAll,
  delay,
  ensureDir,
  evaluateSafe,
  goto,
  launchMiniProgram,
  log,
  section,
  seedMemory,
  seedNotes,
  seedProfile,
  seedQuestions,
  seedSymptoms,
  setKey,
  sha256,
} from './helpers.mjs';

const OUT_DIR = process.env.MHP_SHOT_OUT || path.join(ROOT, 'artifacts', 'screenshots', 'soft-copyright');
const MANIFEST =
  process.env.MHP_SHOT_MANIFEST || path.join(os.tmpdir(), 'mhp-soft-shots-manifest.json');
const FONT_SIZES = (process.env.MHP_SHOT_FONTS || '14,32')
  .split(',')
  .map((v) => Number(v.trim()))
  .filter((v) => Number.isFinite(v));
// Optional comma list of shot names to capture (iteration / failure-probe only).
const ONLY = (process.env.MHP_SHOT_ONLY || '')
  .split(',')
  .map((v) => v.trim())
  .filter(Boolean);
const onlySet = ONLY.length > 0 ? new Set(ONLY) : null;

// Home capture convergence (see the header note). `K` = number of consecutive byte-equal
// independent re-renders required before the frame is accepted; `MAX` caps the work.
const HOME_STABLE_K = Number(process.env.MHP_SHOT_SETTLE_K || 3);
const HOME_STABLE_MAX = Number(process.env.MHP_SHOT_SETTLE_MAX || 10);
const SCRATCH_DIR = path.join(os.tmpdir(), `mhp-soft-scratch-${process.pid}`);

const PAGES = [
  { name: 'home', route: 'pages/home/home' },
  { name: 'profile', route: 'pages/profile/profile' },
  { name: 'symptoms', route: 'pages/symptoms/symptoms' },
  { name: 'notes', route: 'pages/notes/notes' },
  { name: 'questions', route: 'pages/questions/questions' },
  { name: 'brief', route: 'pages/brief/brief' },
  { name: 'ai', route: 'pages/ai/ai' },
  { name: 'settings', route: 'pages/settings/settings' },
  { name: 'workspace', route: 'pages/workspace/workspace' },
  { name: 'workspace-settings', route: 'pages/workspace/workspace?section=settings' },
];

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PINNED_GREETING = '早上好';
const ORGANIZE_TEXT = '最近一周晚上睡不好，白天没有精神';
const CONSULT_TEXT = '最近胃不太舒服，想问问看什么方向';

function gitHead() {
  const res = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  return (res.stdout || '').trim() || 'unknown';
}

function prefsFor(fontSize) {
  return {
    aiEnabled: true,
    demoMode: true,
    consentVersion: 1,
    fontSize,
    highContrast: false,
    autoMemory: true,
    updatedAt: '2026-09-01T00:00:00.000Z',
  };
}

async function resetAndSeed(mp, fontSize) {
  await clearAll(mp);
  await setKey(mp, KEYS.profile, seedProfile());
  await setKey(mp, KEYS.symptoms, seedSymptoms());
  await setKey(mp, KEYS.notes, seedNotes());
  await setKey(mp, KEYS.questions, seedQuestions());
  await setKey(mp, KEYS.memory, seedMemory());
  await setKey(mp, KEYS.preferences, prefsFor(fontSize));
}

async function scrollToBottom(mp) {
  try {
    await mp.callWxMethod('pageScrollTo', { scrollTop: 100000, duration: 0 });
    await delay(350);
  } catch {
    /* best-effort; a non-scrollable page is a no-op */
  }
}

async function pinGreeting(mp) {
  return evaluateSafe(
    mp,
    (greeting) => {
      const pages = getCurrentPages();
      const page = pages[pages.length - 1];
      page.setData({ greeting });
      // workspace hosts home as a child component (#sec-home) with its own data, so the
      // host-page patch above does NOT reach it; pin the component too so the workspace
      // capture matches the wrapper-home capture.
      const secHome =
        typeof page.selectComponent === 'function' ? page.selectComponent('#sec-home') : null;
      if (secHome && typeof secHome.setData === 'function') secHome.setData({ greeting });
      return greeting;
    },
    8000,
    PINNED_GREETING
  );
}

/** Snapshot of the AI page's settled-relevant data (synchronous, side-effect free). */
async function aiSnapshot(mp) {
  return evaluateSafe(
    mp,
    () => {
      const pages = getCurrentPages();
      const page = pages[pages.length - 1];
      return {
        mode: page.data.mode,
        sending: page.data.sending,
        previewOpen: page.data.previewOpen,
        hasMessages: page.data.hasMessages,
        count: page.data.messages.length,
        autoMemoryHint: page.data.autoMemoryHint,
      };
    },
    8000
  );
}

/**
 * Poll until the send has fully settled: sending=false, no open preview and the expected
 * number of turns present (async mp.evaluate may resolve before the in-page promise chain
 * finishes, so we never trust the drive call alone). Then a fixed settle delay absorbs any
 * trailing async work (auto-extract writes).
 */
async function waitSettled(mp, expectMode, expectTurns, timeoutMs = 25000) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    const snap = await aiSnapshot(mp);
    if (snap.ok && snap.value) {
      last = snap.value;
      if (
        snap.value.sending === false &&
        snap.value.previewOpen === false &&
        snap.value.mode === expectMode &&
        snap.value.count >= expectTurns
      ) {
        await delay(700);
        return { ok: true, state: last };
      }
    }
    await delay(150);
  }
  return { ok: false, state: last };
}

async function driveOrganize(mp) {
  await evaluateSafe(
    mp,
    async (text) => {
      const pages = getCurrentPages();
      const page = pages[pages.length - 1];
      page.onInput({ detail: { value: text } });
      await page.onSend();
      await page.onConfirmSend();
      return true;
    },
    30000,
    ORGANIZE_TEXT
  );
  return waitSettled(mp, 'organize', 2);
}

async function driveConsult(mp) {
  await evaluateSafe(
    mp,
    async (text) => {
      const pages = getCurrentPages();
      const page = pages[pages.length - 1];
      const originalModal = wx.showModal;
      wx.showModal = function (options) {
        if (options && typeof options.success === 'function')
          options.success({ confirm: true, cancel: false });
      };
      let switched = false;
      try {
        switched = await page.setMode('consult');
      } finally {
        wx.showModal = originalModal;
      }
      if (typeof page.onToggleProfile === 'function') page.onToggleProfile();
      page.onInput({ detail: { value: text } });
      await page.onSend();
      await page.onConfirmSend();
      return switched;
    },
    30000,
    CONSULT_TEXT
  );
  return waitSettled(mp, 'consult', 2);
}

/** One screenshot into an explicit path; returns bytes + sha256 (no interpretation). */
async function screenshotTo(mp, file) {
  await mp.screenshot({ path: file });
  const buf = fs.readFileSync(file);
  return { bytes: buf.length, sha256: sha256(buf) };
}

/**
 * Home-section-bearing convergence capture (see the header note). Accepts the frame only
 * after HOME_STABLE_K consecutive byte-equal samples, each taken after an independent fresh
 * re-render (reLaunch + greeting re-pin re-runs onShow/refresh). An isolated raster flip
 * cannot form a run, so this converges to the canonical frame; the accepted PNG is written
 * to `file`. The render is already in its canonical state when this is first called — the
 * caller does goto(route) + pinGreeting() beforehand. `route` (default the wrapper home page)
 * lets the same convergence guard run for the workspace SPA's home section.
 */
async function captureHomeStable(mp, file, name, route = 'pages/home/home') {
  ensureDir(SCRATCH_DIR);
  const scratch = path.join(SCRATCH_DIR, `${name}.png`);
  let prev = null;
  let run = 0;
  for (let attempt = 1; attempt <= HOME_STABLE_MAX; attempt += 1) {
    const { bytes, sha256: hash } = await screenshotTo(mp, scratch);
    if (hash === prev) run += 1;
    else {
      run = 1;
      prev = hash;
    }
    log(
      `settle ${name}: sample ${attempt} (${bytes}B, sha256 ${hash}) run=${run}/${HOME_STABLE_K}`
    );
    if (run >= HOME_STABLE_K) {
      fs.copyFileSync(scratch, file);
      return;
    }
    // Independent render for the next sample; reLaunch re-runs onShow -> refresh.
    await goto(mp, route, 1000);
    await pinGreeting(mp);
  }
  throw new Error(
    `home capture ${name} did not converge: no ${HOME_STABLE_K} consecutive byte-equal renders in ${HOME_STABLE_MAX} samples`
  );
}

async function capture(mp, name, meta) {
  const file = path.join(OUT_DIR, `${name}.png`);
  ensureDir(OUT_DIR);
  if (meta && (meta.page === 'home' || meta.page === 'workspace')) {
    await captureHomeStable(mp, file, name, meta.route);
  } else {
    await mp.screenshot({ path: file });
  }
  const buf = fs.readFileSync(file);
  return {
    name,
    ...meta,
    file: path.relative(ROOT, file),
    bytes: buf.length,
    sha256: sha256(buf),
    png_magic: buf.subarray(0, 8).equals(PNG_SIGNATURE),
    ok: buf.length > 5000 && buf.subarray(0, 8).equals(PNG_SIGNATURE),
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  ensureDir(OUT_DIR);
  section('SOFT-COPYRIGHT SCREENSHOTS (deterministic)');
  log(`out: ${OUT_DIR}`);
  log(`manifest: ${MANIFEST}`);
  log(`font sizes: ${FONT_SIZES.join(', ')}`);
  if (onlySet) log(`only: ${[...onlySet].join(', ')}`);

  const shots = [];
  const drivers = {};

  const take = async (name, meta) => {
    if (onlySet && !onlySet.has(name)) return null;
    const shot = await capture(mp, name, meta);
    shots.push(shot);
    log(`shot ${shot.file} (${shot.bytes}B, sha256 ${shot.sha256})`);
    return shot;
  };

  let mp = await launchMiniProgram();
  try {
    // warm-up
    await goto(mp, 'pages/home/home', 1000);

    // 1. seeded pages at each font size (14 vs 32 = the 大字对比)
    for (const fontSize of FONT_SIZES) {
      await resetAndSeed(mp, fontSize);
      for (const page of PAGES) {
        await goto(mp, page.route, 1000);
        if (page.name === 'home' || page.name === 'workspace') await pinGreeting(mp);
        if (page.name === 'ai') {
          drivers[`organize_${fontSize}`] = await driveOrganize(mp);
          await scrollToBottom(mp);
        }
        await take(`${page.name}-${fontSize}`, {
          page: page.name,
          route: page.route,
          font_size: fontSize,
          state: page.name === 'ai' ? 'organize' : 'seeded',
        });
      }
    }

    // 2. AI dual-mode: consult conversation (fresh namespace per font size)
    for (const fontSize of FONT_SIZES) {
      await resetAndSeed(mp, fontSize);
      await goto(mp, 'pages/ai/ai', 1000);
      drivers[`consult_${fontSize}`] = await driveConsult(mp);
      await scrollToBottom(mp);
      await take(`ai-consult-${fontSize}`, {
        page: 'ai',
        route: 'pages/ai/ai',
        font_size: fontSize,
        state: 'consult',
      });
    }

    const head = gitHead();
    const manifest = {
      command:
        'E2E_DEVTOOLS_MINIMIZE=1 MHP_SHOT_MANIFEST=<path> node tests/e2e/screenshots-soft.mjs (cold)',
      tool: 'tests/e2e/screenshots-soft.mjs',
      timestamp: new Date().toISOString(),
      head,
      platform: `${os.platform()} ${os.release()} (${os.arch()})`,
      node_version: process.version,
      project_path: CONFIG.projectPath,
      out_dir: path.relative(ROOT, OUT_DIR),
      font_sizes: FONT_SIZES,
      pages: PAGES.map((p) => p.name),
      demo_mode: true,
      shot_count: shots.length,
      shots,
      drivers,
      summary: {
        all_shots_ok: shots.length > 0 && shots.every((s) => s.ok),
      },
    };

    ensureDir(path.dirname(MANIFEST));
    fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
    log(`manifest: ${MANIFEST}`);
    log(`shots ok: ${manifest.summary.all_shots_ok} (${shots.length} shots)`);
    return manifest.summary.all_shots_ok;
  } finally {
    if (mp) {
      try {
        await mp.close();
        log('miniProgram.close() done');
      } catch (err) {
        log(`warning: close failed: ${err?.message || err}`);
      }
    }
    fs.rmSync(SCRATCH_DIR, { recursive: true, force: true });
  }
}

// Run only when executed as a script (`node tests/e2e/screenshots-soft.mjs`); importing
// the module is side-effect free so other harnesses can reuse its definitions.
const isDirectRun =
  !!process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  main().then(
    (passed) => process.exit(passed ? 0 : 1),
    (err) => {
      console.error(`[screenshots-soft] FAIL ${err?.stack || err}`);
      process.exit(1);
    }
  );
}
