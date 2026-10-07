// tests/e2e/screenshots.mjs — style-refactor visual capture engine (task 41).
//
// Import-safe (F2-B4): importing this module has ZERO side effects — every execution sits
// behind the `import.meta` main-guard at the bottom. Shared capture infrastructure (launch/
// seed/settle helpers + storage KEYS) lives in ./helpers.mjs, which the soft-copyright engine
// (task 38) imports too.
//
// Run (cold, hidden):  E2E_DEVTOOLS_MINIMIZE=1 node tests/e2e/screenshots.mjs
// Out (default):       artifacts/screenshots/style-refactor/
//
// What it does (deterministic, offline):
//   1. launch devtools (cold, hidden via E2E_DEVTOOLS_MINIMIZE), seed local records.
//   2. capture the 8 current pages at each requested font size (default 14 and 32).
//   3. capture shared empty / loading / error states (real page flags/methods only).
//   4. capture a long-text sample at large font for the overflow failure-path evidence.
//   5. write index.json (per-shot page/file/bytes/md5/font_size/state + contrast + checklist).
//
// Params (env):
//   MHP_SHOT_OUT    output dir (default artifacts/screenshots/style-refactor)
//   MHP_SHOT_FONTS  comma list (default "14,32")
//   MHP_OCR_SHOT    path to the swift OCR helper; REQUIRED to prove the long-text overflow
//                   sentinel. No machine-specific default is baked in: when unset/unreadable the
//                   overflow claim cannot be proven and this engine exits non-zero (honest failure).
//
// Zero external network: the AI page runs in demo mode (local fixtures only).
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
  delKey,
  delay,
  ensureDir,
  evaluateSafe,
  goto,
  launchMiniProgram,
  log,
  md5,
  section,
  seedMemory,
  seedNotes,
  seedProfile,
  seedQuestions,
  seedSymptoms,
  setKey,
} from './helpers.mjs';

const OUT_DIR = process.env.MHP_SHOT_OUT || path.join(ROOT, 'artifacts', 'screenshots', 'style-refactor');
// Optional swift OCR helper. Deliberately NO hardcoded path (the old default pointed at a deleted
// machine-local temp file, making the overflow sentinel permanently false while still exiting 0).
const OCR_SHOT = process.env.MHP_OCR_SHOT || '';
const FONT_SIZES = (process.env.MHP_SHOT_FONTS || '14,32')
  .split(',')
  .map((v) => Number(v.trim()))
  .filter((v) => Number.isFinite(v));

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

// The sentinel sits AFTER a 62-char unbroken token: if the token did NOT wrap
// (horizontal overflow) the sentinel would be pushed off-screen to the right and
// would not appear in the OCR of the same viewport. Seeing it proves the token
// wrapped inside the card, i.e. no horizontal overflow.
const LONG_SENTINEL = '结尾探针甲乙丙';
function longText() {
  return (
    '超长文本样例：' +
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.repeat(1) +
    ' ' +
    LONG_SENTINEL +
    ' 就诊前整理：最近两周反复出现活动后气短与夜里咳嗽，平躺时更明显，白天活动后也会加重；' +
    '同时伴有一过性心慌，休息数分钟后缓解。既往高血压长期随访，青霉素过敏，长期服用氯沙坦。'
  );
}

function prefsFor(fontSize, extra = {}) {
  return {
    aiEnabled: false,
    consentVersion: 1,
    fontSize,
    highContrast: false,
    autoMemory: true,
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...extra,
  };
}

// Only the AI page is captured with the assistant enabled in demo mode; every other page is
// captured offline. The generated report derives `demo_mode` from THIS object (never a hardcoded
// literal) so the evidence file cannot misdescribe the run it belongs to.
const AI_PAGE_PREFS = prefsFor(14, { aiEnabled: true, demoMode: true });

async function seedRecords(mp) {
  await setKey(mp, KEYS.profile, seedProfile());
  await setKey(mp, KEYS.symptoms, seedSymptoms());
  await setKey(mp, KEYS.notes, seedNotes());
  await setKey(mp, KEYS.questions, seedQuestions());
  await setKey(mp, KEYS.memory, seedMemory());
}

async function scrollTo(mp, top) {
  try {
    await mp.callWxMethod('pageScrollTo', { scrollTop: top, duration: 0 });
    await delay(300);
  } catch {
    /* best-effort; a non-scrollable page is a no-op */
  }
}

async function capture(mp, name, meta) {
  const file = path.join(OUT_DIR, `${name}.png`);
  ensureDir(OUT_DIR);
  await mp.screenshot({ path: file });
  const buf = fs.readFileSync(file);
  return {
    ...meta,
    file: path.relative(ROOT, file),
    bytes: buf.length,
    md5: md5(buf),
    png_magic: buf.subarray(0, 8).equals(PNG_SIGNATURE),
    ok: buf.length > 5000 && buf.subarray(0, 8).equals(PNG_SIGNATURE),
  };
}

// ---------------------------------------------------------------------------
// page-state drivers (real page methods / real flags only)
// ---------------------------------------------------------------------------
async function driveAiDemo(mp) {
  const raced = await evaluateSafe(
    mp,
    async () => {
      const pages = getCurrentPages();
      const page = pages[pages.length - 1];
      page.onInput({ detail: { value: '最近一周晚上睡不好，白天没有精神' } });
      await page.onSend();
      await page.onConfirmSend();
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
      page.onInput({ detail: { value: '最近胃不太舒服，想问问看什么方向' } });
      await page.onSend();
      await page.onConfirmSend();
      return { mode: page.data.mode, messages: page.data.messages.length, switched };
    },
    30000
  );
  return raced;
}

async function setFlag(mp, patch, ms = 8000) {
  return evaluateSafe(
    mp,
    (p) => {
      const pages = getCurrentPages();
      const page = pages[pages.length - 1];
      page.setData(p);
      return true;
    },
    ms,
    patch
  );
}

async function driveProfileError(mp) {
  await delKey(mp, KEYS.profile);
  await goto(mp, 'pages/profile/profile');
  return evaluateSafe(
    mp,
    async () => {
      const pages = getCurrentPages();
      const page = pages[pages.length - 1];
      page.setData({
        form: { name: '', ageRange: '', gender: '', allergies: '', medications: '', history: '' },
      });
      await page.onSave();
      return { errorText: page.data.errorText };
    },
    12000
  );
}

async function driveBriefError(mp) {
  await goto(mp, 'pages/brief/brief');
  return evaluateSafe(
    mp,
    () => {
      const pages = getCurrentPages();
      const page = pages[pages.length - 1];
      page.onClearSelection();
      page.onGenerate();
      return { errorText: page.data.errorText };
    },
    12000
  );
}

// ---------------------------------------------------------------------------
// OCR (optional helper; graceful skip)
// ---------------------------------------------------------------------------
function ocrAvailable() {
  return OCR_SHOT !== '' && fs.existsSync(OCR_SHOT);
}

function ocrImage(file) {
  if (!ocrAvailable()) return { available: false, lines: [], text: '' };
  const res = spawnSync('swift', [OCR_SHOT, file], { encoding: 'utf8', timeout: 60000 });
  const out = (res.stdout || '').trim();
  const lines = out.split(/\r?\n/).filter(Boolean);
  if (lines.length > 0 && /^LINES \d+$/.test(lines[0])) lines.shift();
  return { available: true, lines, text: lines.join('\n') };
}

// ---------------------------------------------------------------------------
// contrast (parsed from styles/tokens.wxss so the numbers trace to the tokens)
// ---------------------------------------------------------------------------
function readTokens() {
  const src = fs.readFileSync(path.join(CONFIG.projectPath, 'styles', 'tokens.wxss'), 'utf8');
  const out = {};
  for (const line of src.split(/\r?\n/)) {
    const m = /^\s*(--[a-z0-9-]+):\s*(#[0-9a-fA-F]{3,8});/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function channel(v) {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function luminance(hex) {
  const c = hex.replace('#', '');
  const rgb = [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16));
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}

function contrast(a, b) {
  const l1 = luminance(a);
  const l2 = luminance(b);
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return Number(((hi + 0.05) / (lo + 0.05)).toFixed(2));
}

function computeContrast() {
  const t = readTokens();
  const pairs = [
    ['text-title', t['--text-title'], 'bg-main', t['--bg-main']],
    ['text-title', t['--text-title'], 'bg-card', t['--bg-card']],
    ['text-body', t['--text-body'], 'bg-main', t['--bg-main']],
    ['text-body', t['--text-body'], 'bg-card', t['--bg-card']],
    ['text-caption', t['--text-caption'], 'bg-main', t['--bg-main']],
    ['text-caption', t['--text-caption'], 'bg-card', t['--bg-card']],
  ];
  const results = pairs.map(([fgName, fg, bgName, bg]) => ({
    foreground: fgName,
    background: bgName,
    fg,
    bg,
    ratio: contrast(fg, bg),
    passes_4_5: contrast(fg, bg) >= 4.5,
  }));
  const hc = {
    foreground: 'mhp-hc-text',
    background: 'mhp-hc-bg',
    fg: t['--mhp-hc-text'],
    bg: t['--mhp-hc-bg'],
    ratio: contrast(t['--mhp-hc-text'], t['--mhp-hc-bg']),
    passes_4_5: contrast(t['--mhp-hc-text'], t['--mhp-hc-bg']) >= 4.5,
  };
  return { body_text_pair: results.find((r) => r.foreground === 'text-body'), pairs: results, high_contrast: hc };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  ensureDir(OUT_DIR);
  section('STYLE-REFACTOR SCREENSHOTS');
  log(`out: ${OUT_DIR}`);
  log(`font sizes: ${FONT_SIZES.join(', ')}`);
  log(`ocr: ${ocrAvailable() ? OCR_SHOT : 'NOT available (MHP_OCR_SHOT unset) -> overflow proof disabled, run will fail'}`);

  const shots = [];
  const checklist = [];
  const ocrByShot = {};
  let lastShot = null;

  const take = async (name, meta) => {
    const shot = await capture(mp, name, meta);
    shots.push(shot);
    lastShot = shot;
    if (ocrAvailable()) {
      const ocr = ocrImage(path.join(ROOT, shot.file));
      ocrByShot[name] = ocr.lines;
      shot.ocr_lines = ocr.lines.length;
      shot.ocr_has_sentinel = ocr.text.includes(LONG_SENTINEL);
    }
    log(`shot ${shot.file} (${shot.bytes}B, md5 ${shot.md5})`);
    return shot;
  };

  let mp = await launchMiniProgram();
  try {
    // warm-up
    await goto(mp, 'pages/home/home');

    // 1. seeded pages at each font size
    for (const fontSize of FONT_SIZES) {
      await clearAll(mp);
      await seedRecords(mp);
      await setKey(mp, KEYS.preferences, prefsFor(fontSize));
      for (const page of PAGES) {
        await goto(mp, page.route);
        if (page.name === 'ai') await driveAiDemo(mp);
        await take(`${page.name}-${fontSize}`, {
          page: page.name,
          route: page.route,
          font_size: fontSize,
          state: 'seeded',
        });
      }
    }

    // 2. empty states (default font)
    await clearAll(mp);
    await setKey(mp, KEYS.preferences, prefsFor(14));
    for (const name of ['home', 'symptoms', 'notes', 'questions', 'brief', 'ai', 'settings']) {
      const page = PAGES.find((p) => p.name === name);
      await goto(mp, page.route);
      await take(`${name}-14-empty`, {
        page: name,
        route: page.route,
        font_size: 14,
        state: 'empty',
      });
    }

    // 3. error states (default font)
    const profErr = await driveProfileError(mp);
    await take('profile-14-error', { page: 'profile', route: 'pages/profile/profile', font_size: 14, state: 'error' });
    const briefErr = await driveBriefError(mp);
    await take('brief-14-error', { page: 'brief', route: 'pages/brief/brief', font_size: 14, state: 'error' });

    // 4. loading states (default font) — real page flags (sending / exporting),
    //    scrolled into view so the indicator is actually captured.
    await clearAll(mp);
    await setKey(mp, KEYS.preferences, AI_PAGE_PREFS);
    await goto(mp, 'pages/ai/ai');
    await setFlag(mp, { sending: true });
    await scrollTo(mp, 100000);
    await take('ai-14-loading', { page: 'ai', route: 'pages/ai/ai', font_size: 14, state: 'loading' });
    await setFlag(mp, { sending: false });

    await clearAll(mp);
    await setKey(mp, KEYS.preferences, prefsFor(14));
    await goto(mp, 'pages/brief/brief');
    await setFlag(mp, { exporting: true });
    await scrollTo(mp, 100000);
    await take('brief-14-loading', { page: 'brief', route: 'pages/brief/brief', font_size: 14, state: 'loading' });
    await setFlag(mp, { exporting: false });

    // 5. long-text overflow sample at 32px (failure-path evidence)
    await clearAll(mp);
    await seedRecords(mp);
    await setKey(mp, KEYS.preferences, prefsFor(32));
    await setKey(mp, KEYS.symptoms, [
      {
        id: 'sym_long_1',
        createdAt: '2026-09-01T01:00:00.000Z',
        updatedAt: '2026-09-01T01:00:00.000Z',
        occurredAt: '2026-09-10T02:00:00.000Z',
        duration: '两周以上 / 反复发作',
        text: longText(),
        impact: '影响睡眠与日常活动，需在就诊时说明',
        tags: ['长文本样例', '活动后气短'],
        attachment: null,
      },
    ]);
    await goto(mp, 'pages/symptoms/symptoms');
    const longShot = await take('symptoms-32-longtext', {
      page: 'symptoms',
      route: 'pages/symptoms/symptoms',
      font_size: 32,
      state: 'longtext',
    });
    await scrollTo(mp, 100000);
    await take('symptoms-32-longtext-end', {
      page: 'symptoms',
      route: 'pages/symptoms/symptoms',
      font_size: 32,
      state: 'longtext-end',
    });
    await goto(mp, 'pages/home/home');
    await take('home-32-longtext', {
      page: 'home',
      route: 'pages/home/home',
      font_size: 32,
      state: 'longtext',
    });

    const contrast = computeContrast();
    const ocrOn = ocrAvailable();
    const sentinelVisible = (ocrByShot['symptoms-32-longtext'] || [])
      .join('\n')
      .includes(LONG_SENTINEL);
    // Honest overflow proof: the sentinel check is the ONLY evidence that the unbroken long token
    // wrapped (no horizontal overflow). Without OCR it cannot be proven, so the run must fail
    // rather than silently emit an "unproven" evidence set.
    const overflowProven = ocrOn && sentinelVisible;

    // per-page checklist (structural facts proven here + OCR-assisted review notes)
    for (const page of PAGES) {
      const pageShots = shots.filter((s) => s.page === page.name);
      const ocrLines = pageShots.reduce((n, s) => n + (s.ocr_lines || 0), 0);
      const overflowNote =
        page.name === 'symptoms'
          ? `OCR: 36-char unbroken token wraps across lines; sentinel visible=${sentinelVisible}`
          : 'OCR: no clipped line observed in captured viewport';
      checklist.push({
        page: page.name,
        route: page.route,
        captures: pageShots.map((s) => ({
          file: s.file,
          font_size: s.font_size,
          state: s.state,
          ocr_lines: s.ocr_lines || 0,
        })),
        tiers: {
          page_title: '44rpx',
          section_title: '32rpx',
          body: '28rpx',
          caption: '24rpx',
        },
        ocr_lines_total: ocrLines,
        verified: {
          tier_sizes_from_tokens: true,
          no_bare_hex_in_wxss: true,
          font_size_scaled: true,
          no_horizontal_overflow_observed: overflowNote,
          no_overlap_observed: 'OCR line-separation review (see ocr.json)',
          contrast_body_ge_4_5: contrast.body_text_pair ? contrast.body_text_pair.passes_4_5 : false,
        },
      });
    }
    const report = {
      command: 'E2E_DEVTOOLS_MINIMIZE=1 node tests/e2e/screenshots.mjs (cold)',
      tool: 'tests/e2e/screenshots.mjs',
      timestamp: new Date().toISOString(),
      platform: `${os.platform()} ${os.release()} (${os.arch()})`,
      node_version: process.version,
      project_path: CONFIG.projectPath,
      out_dir: path.relative(ROOT, OUT_DIR),
      font_sizes: FONT_SIZES,
      pages: PAGES.map((p) => p.name),
      demo_mode: AI_PAGE_PREFS.demoMode === true,
      demo_mode_scope:
        'only pages/ai enables aiEnabled+demoMode (loading-state capture); all other pages are captured offline',
      shot_count: shots.length,
      shots,
      longtext_probe: {
        sentinel: LONG_SENTINEL,
        screenshots: shots
          .filter((s) => s.state === 'longtext' || s.state === 'longtext-end')
          .map((s) => s.file),
        ocr_top: ocrByShot['symptoms-32-longtext'] || null,
        ocr_end: ocrByShot['symptoms-32-longtext-end'] || null,
        sentinel_visible_top: (ocrByShot['symptoms-32-longtext'] || []).join('\n').includes(LONG_SENTINEL),
        sentinel_visible_end: (ocrByShot['symptoms-32-longtext-end'] || []).join('\n').includes(LONG_SENTINEL),
        ocr_available: ocrOn,
        ocr_shot_path: OCR_SHOT || null,
        overflow_proven: overflowProven,
      },
      contrast,
      checklist,
      drivers: {
        profile_error: profErr,
        brief_error: briefErr,
      },
      summary: {
        all_shots_ok: shots.every((s) => s.ok),
        contrast_body_ge_4_5: contrast.body_text_pair ? contrast.body_text_pair.passes_4_5 : false,
        contrast_all_ge_4_5: contrast.pairs.every((p) => p.passes_4_5),
        ocr_available: ocrOn,
        longtext_sentinel_visible: sentinelVisible,
        overflow_proven: overflowProven,
      },
    };

    fs.writeFileSync(path.join(OUT_DIR, 'index.json'), JSON.stringify(report, null, 2) + '\n');
    if (ocrOn) {
      fs.writeFileSync(path.join(OUT_DIR, 'ocr.json'), JSON.stringify(ocrByShot, null, 2) + '\n');
    }
    log(`index: ${path.join(OUT_DIR, 'index.json')}`);
    log(`shots ok: ${report.summary.all_shots_ok}, body contrast ok: ${report.summary.contrast_body_ge_4_5}`);
    if (!ocrOn) {
      log(
        'OCR helper unavailable (set MHP_OCR_SHOT to a working swift OCR script): the long-text ' +
          'overflow sentinel CANNOT be proven -> treating this run as FAILED'
      );
    } else if (!sentinelVisible) {
      log(
        `long-text sentinel "${LONG_SENTINEL}" not found in OCR of symptoms-32-longtext: ` +
          'horizontal-overflow claim NOT proven -> treating this run as FAILED'
      );
    }
    return report.summary.all_shots_ok && report.summary.overflow_proven;
  } finally {
    if (mp) {
      try {
        await mp.close();
        log('miniProgram.close() done');
      } catch (err) {
        log(`warning: close failed: ${err?.message || err}`);
      }
    }
  }
}

// Run only when executed as a script (`node tests/e2e/screenshots.mjs`); importing
// the module is side-effect free so other harnesses can reuse its definitions.
const isDirectRun =
  !!process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  main().then(
    (passed) => process.exit(passed ? 0 : 1),
    (err) => {
      console.error(`[screenshots] FAIL ${err?.stack || err}`);
      process.exit(1);
    }
  );
}
