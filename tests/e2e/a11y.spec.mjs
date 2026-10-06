// a11y.spec.mjs — Task 16 global font-scaling + high-contrast + voice-hint spec.
//
// Run (cold, hidden): E2E_DEVTOOLS_MINIMIZE=1 node tests/e2e/a11y.spec.mjs
// Evidence:
//   artifacts/screenshots/a11y-14.png   (fontSize=14 render, same page)
//   artifacts/screenshots/a11y-32.png   (fontSize=32 render, same page)
//   artifacts/e2e/a11y.json             (static scan + runtime render facts)
//   artifacts/qa/16-failure.txt         (failure path: large font OFF => complete, no overflow)
//
// Two independent layers, never conflated:
//   (1) STATIC: scan the scaling surface (app.wxss + the 8 app.json pages) for bare px
//       and for the uniform scale hook (root inline --mhp-scale: {{scale}} + is-hc,
//       onShow -> syncA11y, every font-size calc(… * var(--mhp-scale))). Source-level only.
//   (2) RUNTIME (automator): launch, write AppPreferences.fontSize and reLaunch the SAME
//       page (home) at 14 and 32, capture both screenshots, and assert md5 differs,
//       bytes>0 and PNG magic. Also assert highContrast changes the render. DevTools
//       cannot measure per-element text overflow, so "no overflow" uses the static
//       scaling-surface scan + a clean runtime render as an honest proxy (documented).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CONFIG,
  E2E_ARTIFACTS,
  ROOT,
  ensureDir,
  fail,
  launchMiniProgram,
  log,
  ok,
  section,
  delay,
  md5,
  readSafe,
} from './helpers.mjs';

const MINIAPP_ROOT = CONFIG.projectPath;
const APP_WXSS = path.join(MINIAPP_ROOT, 'app.wxss');
const TEXTS_TS = path.join(MINIAPP_ROOT, 'config', 'texts.ts');
const SETTINGS_DIR = path.join(MINIAPP_ROOT, 'pages', 'settings');

// The 8 pages registered in app.json (the scaling surface).
const PAGES = [
  'home',
  'profile',
  'symptoms',
  'notes',
  'questions',
  'brief',
  'ai',
  'settings',
];

const HOME_ROUTE = 'pages/home/home';
const PREF_RAW = 'records_preferences';
const APP_NAMESPACES = ['mhp_', 'hza_'];

const SCREENSHOT_DIR = path.join(ROOT, 'artifacts', 'screenshots');
const QA_FAILURE_PATH = path.join(ROOT, 'artifacts', 'qa', '16-failure.txt');
const SHOT_14 = path.join(SCREENSHOT_DIR, 'a11y-14.png');
const SHOT_32 = path.join(SCREENSHOT_DIR, 'a11y-32.png');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Bare px = `12px` not part of `rpx` and not preceded by a hex digit.
 *  No `g` flag: the regex is reused with `.test()` across lines (stateful lastIndex). */
const BARE_PX = /(?<![\dr])\d+px/;
const SCALED_FONT = /calc\([^)]*var\(--mhp-scale\)\)/;
const SCALE_INLINE = /--mhp-scale:\s*\{\{scale\}\}/;
// Final mechanism (A13 sweep): all 8 page roots also bind the capped layout scale, and every
// interactive view exposes a role/label; questions + ai decision points carry checkbox state.
const LAYOUT_SCALE_INLINE = /--mhp-layout-scale:\s*\{\{layoutScale\}\}/;
const ARIA_ROLE = /aria-role=/;
const CHECKBOX_SEMANTICS = /aria-role="checkbox"/;
const ARIA_CHECKED = /aria-checked=/;
const HC_CLASS_BIND = /is-hc/;

/**
 * STATIC scan of the scaling surface. No runtime claim. Returns per-page facts plus
 * aggregate booleans the spec asserts on.
 */
function staticScan() {
  const pages = PAGES.map((name) => {
    const dir = path.join(MINIAPP_ROOT, 'pages', name);
    const wxss = readSafe(path.join(dir, `${name}.wxss`));
    const wxml = readSafe(path.join(dir, `${name}.wxml`));
    const ts = readSafe(path.join(dir, `${name}.ts`));
    const fontLines = wxss.split(/\r?\n/).filter((line) => line.includes('font-size'));
    const fontAllScaled =
      fontLines.length > 0 && fontLines.every((line) => SCALED_FONT.test(line));
    const barePxLines = wxss
      .split(/\r?\n/)
      .filter((line) => BARE_PX.test(line))
      .map((line) => line.trim());
    return {
      name,
      font_size_lines: fontLines.length,
      font_size_all_scaled: fontAllScaled,
      wxml_scale_inline: SCALE_INLINE.test(wxml),
      wxml_layout_scale_inline: LAYOUT_SCALE_INLINE.test(wxml),
      wxml_hc_class: HC_CLASS_BIND.test(wxml),
      wxml_aria_role: ARIA_ROLE.test(wxml),
      wxml_checkbox_semantics: CHECKBOX_SEMANTICS.test(wxml) && ARIA_CHECKED.test(wxml),
      uses_sync_a11y: /syncA11y\s*\(/.test(ts),
      // settings owns its inline scale; the other 7 pages get it via the shared helper.
      ts_scale_mechanism:
        name === 'settings' ? /scale/.test(ts) : /A11Y_DATA/.test(ts) && /syncA11y\s*\(/.test(ts),
      bare_px_lines: barePxLines,
    };
  });

  const appWxss = readSafe(APP_WXSS);
  const textsSrc = readSafe(TEXTS_TS);
  const settingsWxml = readSafe(path.join(SETTINGS_DIR, 'settings.wxml'));

  return {
    pages,
    app_wxss: {
      has_scale_default: /--mhp-scale:\s*1/.test(appWxss),
      has_hc_tokens: appWxss.includes('--mhp-hc-bg') && appWxss.includes('--mhp-hc-text'),
      has_global_hc_mapping:
        /\.is-hc\s*\{[^}]*--bg-main:\s*var\(--mhp-hc-bg\)/.test(appWxss) &&
        /\.is-hc\s*\{[^}]*--text-title:\s*var\(--mhp-hc-text\)/.test(appWxss),
      bare_px_lines: appWxss
        .split(/\r?\n/)
        .filter((line) => BARE_PX.test(line))
        .map((line) => line.trim()),
    },
    voice_hint: {
      texts_has_copy: textsSrc.includes('可使用键盘话筒输入'),
      settings_uses_copy: settingsWxml.includes('a11y.keyboardMic'),
    },
  };
}

function summarizeStatics(scan) {
  const allPagesScaled = scan.pages.every((p) => p.font_size_all_scaled === true);
  const allScaleInline = scan.pages.every((p) => p.wxml_scale_inline === true);
  const allLayoutScaleInline = scan.pages.every((p) => p.wxml_layout_scale_inline === true);
  const allHcClass = scan.pages.every((p) => p.wxml_hc_class === true);
  const allAria = scan.pages.every((p) => p.wxml_aria_role === true);
  const checkboxSemantics = ['questions', 'ai'].every(
    (name) => scan.pages.find((p) => p.name === name)?.wxml_checkbox_semantics === true,
  );
  const allMechanism = scan.pages.every((p) => p.ts_scale_mechanism === true);
  const helperPagesUseSync = scan.pages
    .filter((p) => p.name !== 'settings')
    .every((p) => p.uses_sync_a11y === true);
  const barePxTotal =
    scan.app_wxss.bare_px_lines.length +
    scan.pages.reduce((sum, p) => sum + p.bare_px_lines.length, 0);
  return {
    all_pages_scaled: allPagesScaled,
    all_pages_scale_inline: allScaleInline,
    all_pages_layout_scale_inline: allLayoutScaleInline,
    all_pages_hc_class: allHcClass,
    all_pages_aria: allAria,
    checkbox_semantics: checkboxSemantics,
    all_pages_mechanism: allMechanism,
    helper_pages_use_sync: helperPagesUseSync,
    zero_bare_px: barePxTotal === 0,
    app_hc_ok:
      scan.app_wxss.has_scale_default === true &&
      scan.app_wxss.has_hc_tokens === true &&
      scan.app_wxss.has_global_hc_mapping === true,
    voice_hint_ok:
      scan.voice_hint.texts_has_copy === true && scan.voice_hint.settings_uses_copy === true,
  };
}

// ---------------------------------------------------------------------------
// Automator helpers
// ---------------------------------------------------------------------------

async function clearPrefs(miniProgram) {
  for (const ns of APP_NAMESPACES) {
    await miniProgram.callWxMethod('removeStorageSync', ns + PREF_RAW);
  }
}

function prefs(fontSize, highContrast) {
  return {
    aiEnabled: false,
    consentVersion: 1,
    fontSize,
    highContrast,
    autoMemory: true,
    updatedAt: '2026-02-01T00:00:00.000Z',
  };
}

async function writePrefs(miniProgram, value) {
  await miniProgram.callWxMethod('setStorageSync', 'mhp_' + PREF_RAW, value);
}

async function shotTo(miniProgram, filePath) {
  ensureDir(path.dirname(filePath));
  await miniProgram.screenshot({ path: filePath });
  const buf = fs.readFileSync(filePath);
  return {
    path: filePath,
    bytes: buf.length,
    md5: md5(buf),
    pngMagic: buf.subarray(0, 8).equals(PNG_SIGNATURE),
  };
}

async function topPage(miniProgram) {
  const stack = await miniProgram.pageStack();
  const top = Array.isArray(stack) && stack.length > 0 ? stack[stack.length - 1] : null;
  return { pageStack: stack.length, topPath: top ? top.path : null };
}

async function renderAt(miniProgram, fontSize, filePath) {
  await writePrefs(miniProgram, prefs(fontSize, false));
  await miniProgram.reLaunch('/' + HOME_ROUTE);
  await delay(900);
  const top = await topPage(miniProgram);
  const shot = await shotTo(miniProgram, filePath);
  return {
    fontSize,
    pageStack: top.pageStack,
    topPath: top.topPath,
    screenshotBytes: shot.bytes,
    screenshotMd5: shot.md5,
    pngMagic: shot.pngMagic,
    ok:
      top.pageStack >= 1 &&
      top.topPath === HOME_ROUTE &&
      shot.pngMagic === true &&
      shot.bytes > 5000,
  };
}

function buildFailureTranscript(data) {
  const bar = '='.repeat(72);
  const lines = [];
  const push = (line) => lines.push(line);

  push(bar);
  push('# artifacts/qa/16-failure.txt — task 16 failure-path evidence');
  push('# command: E2E_DEVTOOLS_MINIMIZE=1 node tests/e2e/a11y.spec.mjs (cold)');
  push(`# timestamp: ${new Date().toISOString()}`);
  push(`# project: ${CONFIG.projectPath}`);
  push('# method: static scaling-surface scan + real runtime render (default 14) as proxy');
  push(bar);
  push('');
  push('## (a) 关闭大字（默认 fontSize=14）后页面完整渲染 — 运行时');
  push('');
  const r14 = data.render14 || null;
  if (r14) {
    push(`reLaunch "/${HOME_ROUTE}" with mhp_${PREF_RAW}.fontSize=14`);
    push(`  pageStack=${r14.pageStack}, topPath=${r14.topPath}`);
    push(`  screenshot: bytes=${r14.screenshotBytes}, pngMagic=${r14.pngMagic}, md5=${r14.screenshotMd5}`);
    push(`  render ok: ${r14.ok}`);
  } else {
    push('  MISSING: default-14 render evidence not captured');
  }
  push('');
  push('assertion: 默认字号下页面可渲染、无异常（reLaunch + pageStack + 截图均成功）。');
  push('');
  push('## (b) 无溢出 — 静态扫描（缩放面）');
  push('');
  push(`scaling surface: app.wxss + 8 页 (${PAGES.join(', ')})`);
  push(`  zero_bare_px (字号与任意属性): ${data.summary.zero_bare_px}`);
  push(`  all_pages_scaled (font-size 均 calc(… * var(--mhp-scale))): ${data.summary.all_pages_scaled}`);
  push(`  all_pages_scale_inline (根节点 --mhp-scale: {{scale}}): ${data.summary.all_pages_scale_inline}`);
  push(
    `  all_pages_layout_scale_inline (根节点 --mhp-layout-scale: {{layoutScale}}): ${data.summary.all_pages_layout_scale_inline}`
  );
  push(`  all_pages_aria (根节点 aria-role 语义): ${data.summary.all_pages_aria}`);
  push(`  checkbox_semantics (questions + ai 勾选决策点): ${data.summary.checkbox_semantics}`);
  push(`  all_pages_hc_class (根节点 is-hc): ${data.summary.all_pages_hc_class}`);
  push(`  all_pages_mechanism (onShow -> syncA11y + A11Y_DATA): ${data.summary.all_pages_mechanism}`);
  push('');
  for (const page of data.scan.pages) {
    push(
      `  [${page.name}] font-size lines=${page.font_size_lines}, all_scaled=${page.font_size_all_scaled}, ` +
        `scale_inline=${page.wxml_scale_inline}, layout_scale=${page.wxml_layout_scale_inline}, ` +
        `aria=${page.wxml_aria_role}, hc_class=${page.wxml_hc_class}, ` +
        `syncA11y=${page.uses_sync_a11y}, mechanism=${page.ts_scale_mechanism}, bare_px=[${page.bare_px_lines.join(' | ')}]`
    );
  }
  push(
    `  [app.wxss] scale_default=${data.scan.app_wxss.has_scale_default}, ` +
      `hc_tokens=${data.scan.app_wxss.has_hc_tokens}, global_hc_mapping=${data.scan.app_wxss.has_global_hc_mapping}, ` +
      `bare_px=[${data.scan.app_wxss.bare_px_lines.join(' | ')}]`
  );
  push('');
  push('assertion: 缩放面内字号全部来自 --mhp-scale，且无写死 px（无固定字号/宽度导致溢出）。');
  push('');
  push('## (c) 大字模式（fontSize=32）差异 — 运行时');
  push('');
  const r32 = data.render32 || null;
  if (r14 && r32) {
    push(`  fontSize=14 md5=${r14.screenshotMd5} (${r14.screenshotBytes} bytes)`);
    push(`  fontSize=32 md5=${r32.screenshotMd5} (${r32.screenshotBytes} bytes)`);
    push(`  md5 differ: ${r14.screenshotMd5 !== r32.screenshotMd5}`);
    push(`  artifacts: ${path.relative(ROOT, SHOT_14)}, ${path.relative(ROOT, SHOT_32)}`);
  } else {
    push('  MISSING: 14/32 render evidence not both captured');
  }
  push('');
  push('## (d) 高对比可开 — 运行时');
  push('');
  if (data.renderHc) {
    push(`  highContrast=false md5=${data.render14 ? data.render14.screenshotMd5 : 'n/a'}`);
    push(`  highContrast=true  md5=${data.renderHc.screenshotMd5}`);
    push(`  md5 differ: ${data.renderHc.changed === true}`);
  } else {
    push('  MISSING: high-contrast render evidence not captured');
  }
  push('');
  push('## method limitation (honest coverage gap)');
  push('');
  push('WeChat DevTools automation exposes no per-element text-overflow measurement and');
  push('the Page.* protocol is dropped on this build, so a pixel-level "text not clipped"');
  push('assertion is NOT possible here. The "no overflow" claim therefore rests on:');
  push('  (i) static: the scaling surface has zero bare px and every font-size is derived');
  push('      from --mhp-scale (no fixed-height text containers added by this task), and');
  push('  (ii) runtime: the default-14 page re-renders cleanly (no exception surfaced).');
  push('This is a proxy, not a measurement — recorded as such, not claimed as verified.');
  push('');
  push('## verdict');
  push('');
  const verdict =
    data.summary.zero_bare_px === true &&
    data.summary.all_pages_scaled === true &&
    data.summary.all_pages_scale_inline === true &&
    data.summary.all_pages_layout_scale_inline === true &&
    data.summary.all_pages_aria === true &&
    data.summary.checkbox_semantics === true &&
    data.summary.all_pages_mechanism === true &&
    data.summary.helper_pages_use_sync === true &&
    data.summary.app_hc_ok === true &&
    Boolean(r14 && r14.ok) &&
    Boolean(r32 && r14 && r32.screenshotMd5 !== r14.screenshotMd5);
  push(
    `PASS=${verdict} (default-14 renders; scaling surface scaled & px-free; 32/14 differ; HC toggles)`
  );
  push(bar);
  push('');
  return lines.join('\n');
}

async function main() {
  ensureDir(E2E_ARTIFACTS);
  ensureDir(SCREENSHOT_DIR);
  ensureDir(path.dirname(QA_FAILURE_PATH));
  section('A11Y SPEC');

  const scan = staticScan();
  const summary = summarizeStatics(scan);

  let allOk = true;
  const checkStatic = (label, value) => {
    if (value === true) ok(`static: ${label}`);
    else {
      fail(`static: ${label}`);
      allOk = false;
    }
  };
  checkStatic('all 8 pages font-size scaled via --mhp-scale', summary.all_pages_scaled);
  checkStatic('all 8 pages root inline --mhp-scale: {{scale}}', summary.all_pages_scale_inline);
  checkStatic(
    'all 8 pages root inline --mhp-layout-scale: {{layoutScale}}',
    summary.all_pages_layout_scale_inline
  );
  checkStatic('all 8 pages expose aria-role semantics', summary.all_pages_aria);
  checkStatic(
    'questions + ai checkbox decision points carry checkbox semantics',
    summary.checkbox_semantics
  );
  checkStatic('all 8 pages root bind is-hc', summary.all_pages_hc_class);
  checkStatic('all 8 pages wire the uniform scale mechanism', summary.all_pages_mechanism);
  checkStatic(
    '7 non-settings pages call syncA11y via the shared helper',
    summary.helper_pages_use_sync
  );
  checkStatic('scaling surface has zero bare px', summary.zero_bare_px);
  checkStatic('app.wxss has scale default + global HC token mapping', summary.app_hc_ok);
  checkStatic('voice hint from texts.ts is shown in settings', summary.voice_hint_ok);

  let miniProgram;
  let render14 = null;
  let render32 = null;
  let renderHc = null;
  const runtimeErrors = [];

  try {
    miniProgram = await launchMiniProgram();
    await clearPrefs(miniProgram);

    // warm-up + settle: first reLaunch can race onShow.
    await miniProgram.reLaunch('/' + HOME_ROUTE);
    await delay(800);
    await miniProgram.reLaunch('/' + HOME_ROUTE);
    await delay(800);

    render14 = await renderAt(miniProgram, 14, SHOT_14);
    if (render14.ok) {
      ok(
        `fontSize=14 render: top=${render14.topPath}, bytes=${render14.screenshotBytes}, md5=${render14.screenshotMd5}`
      );
    } else {
      fail(`fontSize=14 render failed: ${JSON.stringify(render14)}`);
      allOk = false;
    }

    render32 = await renderAt(miniProgram, 32, SHOT_32);
    if (render32.ok) {
      ok(
        `fontSize=32 render: top=${render32.topPath}, bytes=${render32.screenshotBytes}, md5=${render32.screenshotMd5}`
      );
    } else {
      fail(`fontSize=32 render failed: ${JSON.stringify(render32)}`);
      allOk = false;
    }

    if (render14.screenshotMd5 !== render32.screenshotMd5) {
      ok(`fontSize 14 vs 32 render differ (md5 ${render14.screenshotMd5} -> ${render32.screenshotMd5})`);
    } else {
      fail('fontSize 14 and 32 produced identical renders (scaling not applied)');
      allOk = false;
    }

    // high contrast: same page, same fontSize, HC on -> different render
    await writePrefs(miniProgram, prefs(14, true));
    await miniProgram.reLaunch('/' + HOME_ROUTE);
    await delay(900);
    const hcShot = await shotTo(miniProgram, path.join(os.tmpdir(), `mhp-a11y-hc-${Date.now()}.png`));
    renderHc = { screenshotMd5: hcShot.md5, changed: hcShot.md5 !== render14.screenshotMd5 };
    if (renderHc.changed) {
      ok(`high contrast render differs (md5 ${render14.screenshotMd5} -> ${hcShot.md5})`);
    } else {
      fail('high contrast did not change the render');
      allOk = false;
    }

    // failure-path runtime: large font OFF (default) still renders cleanly.
    await clearPrefs(miniProgram);
    await miniProgram.reLaunch('/' + HOME_ROUTE);
    await delay(900);
    const cleanTop = await topPage(miniProgram);
    if (cleanTop.pageStack >= 1 && cleanTop.topPath === HOME_ROUTE) {
      ok('large font OFF (default): page re-renders cleanly, no runtime error');
    } else {
      fail(`large font OFF render abnormal: ${JSON.stringify(cleanTop)}`);
      allOk = false;
    }
  } catch (err) {
    runtimeErrors.push(err?.stack || String(err));
    fail(`a11y spec run error: ${err?.stack || err}`);
    allOk = false;
  } finally {
    if (miniProgram) {
      try {
        await miniProgram.close();
        log('miniProgram.close() done');
      } catch (err) {
        log(`warning: miniProgram.close() failed: ${err?.message || err}`);
      }
    }
  }

  const report = {
    command: 'E2E_DEVTOOLS_MINIMIZE=1 node tests/e2e/a11y.spec.mjs (cold)',
    timestamp: new Date().toISOString(),
    platform: `${os.platform()} ${os.release()} (${os.arch()})`,
    node_version: process.version,
    project_path: CONFIG.projectPath,
    scaling_surface: {
      app_wxss: 'app.wxss',
      pages: PAGES,
    },
    static_scan: scan,
    static_summary: summary,
    render_14: render14,
    render_32: render32,
    render_high_contrast: renderHc,
    screenshots: {
      a11y_14: { path: path.relative(ROOT, SHOT_14), md5: render14 ? render14.screenshotMd5 : null },
      a11y_32: { path: path.relative(ROOT, SHOT_32), md5: render32 ? render32.screenshotMd5 : null },
    },
    runtime_errors: runtimeErrors,
    summary: {
      passed: false,
      failed: true,
    },
  };

  fs.writeFileSync(QA_FAILURE_PATH, buildFailureTranscript({
    scan,
    summary,
    render14,
    render32,
    renderHc,
  }));
  log(`failure evidence: ${QA_FAILURE_PATH}`);

  const passed = allOk === true;
  report.summary = { passed, failed: !passed };
  const reportPath = path.join(E2E_ARTIFACTS, 'a11y.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  log(`a11y evidence: ${reportPath}`);

  return passed;
}

main().then(
  (passed) => {
    process.exit(passed ? 0 : 1);
  },
  (err) => {
    console.error(`[e2e] FAIL ${err?.stack || err}`);
    process.exit(1);
  }
);
