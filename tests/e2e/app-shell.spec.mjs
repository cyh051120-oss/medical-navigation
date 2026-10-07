// app-shell.spec.mjs — Wave C shell spec (task 12).
//
// Asserts the app window title and that every page registered in app.json is
// navigable at runtime. Evidence: artifacts/e2e/app-shell.json.
//
// This spec supersedes tests/e2e/bootstrap.spec.mjs (deleted in the gate-repair
// wave): bootstrap's assertions (app.json pages[0] === pages/home/home,
// currentPage.path === pages[0], live render with pageStack + PNG magic + >5000B)
// are all covered here, and this spec additionally checks the window title, the
// full 9-page sequence and per-route navigation. bootstrap's one unique assertion
// — that the render's top page path equals pages[0] — is merged into the render
// check below.
//
// Runtime notes (WeChat DevTools 2.01.x): the Page.* automator protocol is
// dropped, so this spec uses the App-level transport the harness already
// relies on — currentPage / navigateTo / navigateBack (App.callWxMethod),
// pageStack (App.getPageStack) and screenshot (App.captureScreenshot).
//
// The window title is not exposed over the automator, so it is read straight
// from app.json (window.navigationBarTitleText) and recorded with its source.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CONFIG,
  E2E_ARTIFACTS,
  ensureDir,
  fail,
  launchMiniProgram,
  log,
  ok,
  readExpectedFirstPage,
  section,
} from './helpers.mjs';

const EXPECTED_TITLE = '就医准备助手';
const EXPECTED_PAGES = [
  'pages/workspace/workspace',
  'pages/home/home',
  'pages/profile/profile',
  'pages/symptoms/symptoms',
  'pages/notes/notes',
  'pages/questions/questions',
  'pages/brief/brief',
  'pages/ai/ai',
  'pages/settings/settings',
];
async function main() {
  ensureDir(E2E_ARTIFACTS);
  section('APP SHELL SPEC');

  const { appJsonPath, pages } = readExpectedFirstPage();
  const appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
  const observedTitle = appJson?.window?.navigationBarTitleText;
  const titleSource = 'app.json window.navigationBarTitleText';

  log(`app.json: ${appJsonPath}`);
  log(`declared pages (${pages.length}): ${pages.join(', ')}`);
  log(`window title = ${observedTitle} (source: ${titleSource})`);

  const expectedPages = EXPECTED_PAGES.slice();
  const titleOk = observedTitle === EXPECTED_TITLE;
  const pagesMatch = JSON.stringify(pages) === JSON.stringify(expectedPages);
  if (titleOk) {
    ok(`window title === "${EXPECTED_TITLE}"`);
  } else {
    fail(`title mismatch: expected "${EXPECTED_TITLE}" but app.json has "${observedTitle}"`);
  }
  if (pagesMatch) {
    ok(`app.json pages === expected 9-page shell`);
  } else {
    fail(`pages mismatch: expected [${expectedPages.join(', ')}] but app.json has [${pages.join(', ')}]`);
  }

  const report = {
    command: 'node tests/e2e/app-shell.spec.mjs',
    timestamp: new Date().toISOString(),
    platform: `${os.platform()} ${os.release()} (${os.arch()})`,
    node_version: process.version,
    project_path: CONFIG.projectPath,
    title: {
      expected: EXPECTED_TITLE,
      observed: observedTitle ?? null,
      source: titleSource,
      ok: titleOk,
    },
    pages_declared: pages,
    pages_expected: expectedPages,
    pages_match: pagesMatch,
    routes: [],
    render: null,
    summary: null,
  };

  let miniProgram;
  let allOk = titleOk && pagesMatch;

  try {
    miniProgram = await launchMiniProgram();

    // Workspace is the launch page (pages[0]); record it without navigating.
    const home = expectedPages[0];
    const initial = await miniProgram.currentPage();
    const initialPath = initial ? initial.path : null;
    const initialOk = initialPath === home;
    report.routes.push({ route: home, method: 'launch', observed: initialPath, ok: initialOk });
    if (initialOk) ok(`launch page "${home}" registered and current`);
    else {
      fail(`launch page: expected "${home}" but observed "${initialPath}"`);
      allOk = false;
    }

    // Navigate to every other registered route, then navigate back to home.
    for (const route of expectedPages.slice(1)) {
      let observed = null;
      try {
        const page = await miniProgram.navigateTo('/' + route);
        observed = page ? page.path : null;
      } catch (err) {
        fail(`navigateTo "/${route}" threw: ${err?.message || err}`);
      }
      const routeOk = observed === route;
      report.routes.push({ route, method: 'navigateTo', observed, ok: routeOk });
      if (routeOk) ok(`route "${route}" navigable`);
      else {
        fail(`route "${route}" expected but observed "${observed}"`);
        allOk = false;
      }
      try {
        await miniProgram.navigateBack();
      } catch (err) {
        fail(`navigateBack after "/${route}" threw: ${err?.message || err}`);
        allOk = false;
      }
    }

    // Render evidence for the shell home page.
    const stack = await miniProgram.pageStack();
    const top = Array.isArray(stack) && stack.length > 0 ? stack[stack.length - 1] : null;
    const shotPath = path.join(os.tmpdir(), `mhp-e2e-appshell-${Date.now()}.png`);
    await miniProgram.screenshot({ path: shotPath });
    const shot = fs.readFileSync(shotPath);
    const pngMagic = shot
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    fs.unlinkSync(shotPath);
    const renderOk = stack.length >= 1 && top !== null && top.path === expectedPages[0] && pngMagic && shot.length > 5000;
    report.render = {
      pageStack: stack.length,
      topPath: top ? top.path : null,
      screenshotBytes: shot.length,
      pngMagic,
      ok: renderOk,
    };
    if (renderOk) {
      ok(`render evidence: pageStack=${stack.length}, top.path=${top ? top.path : null}, bytes=${shot.length}`);
    } else {
      fail(`render check failed (pageStack=${stack.length}, top.path=${top ? top.path : null}, bytes=${shot.length}, pngMagic=${pngMagic})`);
      allOk = false;
    }
  } catch (err) {
    fail(`app shell run error: ${err?.stack || err}`);
    report.error = err?.message || String(err);
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
    const passed = Boolean(titleOk && pagesMatch && allOk);
    report.summary = {
      title_ok: titleOk,
      pages_match: pagesMatch,
      routes_total: report.routes.length,
      routes_passed: report.routes.filter((r) => r.ok).length,
      render_ok: report.render ? report.render.ok : false,
      passed,
      failed: !passed,
    };
    const reportPath = path.join(E2E_ARTIFACTS, 'app-shell.json');
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
    log(`app-shell evidence: ${reportPath}`);
  }

  return report.summary.passed;
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
