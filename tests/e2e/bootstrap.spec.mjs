// Bootstrap smoke spec: launch the miniprogram and assert the first page
// (app.json pages[0]) renders. Wave C (task 12) reordered pages so home is
// first; the observed path is still read from app.json at runtime, and we
// additionally pin pages[0] to `pages/home/home` as the shell entry guard.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CONFIG,
  launchMiniProgram,
  log,
  ok,
  readExpectedFirstPage,
  section,
} from './helpers.mjs';

// Wave C shell: app.json must register the workbench as the first page.
const EXPECTED_HOME_PAGE = 'pages/home/home';

async function main() {
  section('BOOTSTRAP SPEC');
  const { appJsonPath, expected, pages } = readExpectedFirstPage();
  log(`app.json: ${appJsonPath}`);
  log(`EXPECTED first page (pages[0]) = ${expected} (declared pages: ${pages.join(', ')})`);
  if (expected !== EXPECTED_HOME_PAGE) {
    throw new Error(
      `app.json pages[0] expected "${EXPECTED_HOME_PAGE}" (Wave C shell) but found "${expected}"`
    );
  }
  ok(`app.json pages[0] === "${EXPECTED_HOME_PAGE}"`);
  log(
    `launch params: cliPath=${CONFIG.cliPath} projectPath=${CONFIG.projectPath} port=${CONFIG.port} timeout=${CONFIG.timeout}`
  );

  // Shared backgrounding-aware launch (task 44): runs the devtools-background
  // ladder (rung ① `open -g -j`; rung ② minimize when Accessibility is granted
  // and E2E_DEVTOOLS_MINIMIZE=1). Retry semantics (2 attempts, 1.5s) live in
  // the wrapper.
  // trustProject: the devtools only returns the mini-program SDKVersion
  // (Tool.getInfo.SDKVersion) once the project is trusted/opened; an
  // untrusted project returns only {version}, which makes automator
  // 0.12.1's checkVersion crash on `undefined.split`.
  const miniProgram = await launchMiniProgram();

  try {
    const page = await miniProgram.currentPage();
    if (!page) throw new Error('miniProgram.currentPage() returned no page');

    const observedPath = page.path;
    log(`observed currentPage.path = ${observedPath}`);
    log(`observed currentPage.id = ${page.id}, query = ${JSON.stringify(page.query)}`);

    if (observedPath !== expected) {
      throw new Error(
        `first page mismatch: expected "${expected}" (app.json pages[0]) but observed "${observedPath}"`
      );
    }
    ok(`page.path === pages[0] ("${expected}")`);

    // Render evidence via APIs this devtools build actually implements.
    // NOTE: the Page.* automator protocol (page.$ / page.data) is dropped in
    // WeChat DevTools 2.01.x — those requests never get a response and hang.
    // We therefore use App.getPageStack + App.captureScreenshot, which do
    // respond, to prove the page really rendered.
    const stack = await miniProgram.pageStack();
    const top = Array.isArray(stack) && stack.length > 0 ? stack[stack.length - 1] : null;
    log(
      `observed pageStack length=${stack.length}, top.path=${top?.path}, top.query=${JSON.stringify(top?.query ?? {})}`
    );

    // Screenshot of the live page (temp file, not committed).
    const shotPath = path.join(os.tmpdir(), `mhp-e2e-bootstrap-${Date.now()}.png`);
    await miniProgram.screenshot({ path: shotPath });
    const shot = fs.readFileSync(shotPath);
    const pngMagic = shot
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    fs.unlinkSync(shotPath);
    log(
      `render evidence: pageStack=${stack.length}, top.path=${top?.path}, screenshotBytes=${shot.length}, pngMagic=${pngMagic}`
    );

    const rendered =
      stack.length >= 1 &&
      top?.path === expected &&
      pngMagic &&
      shot.length > 5000;
    if (!rendered) {
      throw new Error(
        `page "${observedPath}" render check failed (pageStack=${stack.length}, top.path=${top?.path}, screenshotBytes=${shot.length}, pngMagic=${pngMagic})`
      );
    }
    ok(
      `page "${observedPath}" rendered content (pageStack=${stack.length}, screenshotBytes=${shot.length}, pngMagic=${pngMagic})`
    );

    log('bootstrap smoke: PASS');
  } finally {
    if (miniProgram) {
      try {
        await miniProgram.close();
        log('miniProgram.close() done (no dangling devtools instance)');
      } catch (err) {
        log(`warning: miniProgram.close() failed: ${err?.message || err}`);
      }
    }
  }
}

main().then(
  () => {
    // Force exit: miniprogram-automator keeps handles open; without this the
    // process can hang after a failure and the parent's spawnSync times out.
    process.exit(0);
  },
  (err) => {
    console.error(`[e2e] FAIL ${err?.stack || err}`);
    process.exit(1);
  }
);
