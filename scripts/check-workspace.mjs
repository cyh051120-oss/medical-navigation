#!/usr/bin/env node
// scripts/check-workspace.mjs
// Zero-dependency, read-only consistency gate for the Workspace SPA architecture.
// Run via tsx (the nav registry is a TS module): `npx tsx scripts/check-workspace.mjs`.
//
// Single sources of truth this gate keeps aligned:
//   1. hospital-ai-miniapp/shared/ui/nav.ts        `NAV_ITEMS` (8 sections)
//   2. hospital-ai-miniapp/app.json                `pages[0]` + page set
//   3. hospital-ai-miniapp/pages/<route>.json      `navigationBarTitleText`
//   4. .../pages/workspace/workspace.ts            `MIGRATED_SECTIONS` / `DEFAULT_SECTION`
//   5. .../pages/workspace/workspace.json          `usingComponents` `<key>-view`
//   6. .../pages/workspace/workspace.wxml          `id="sec-<key>"` panes
//
// Phase-3 contract guard: the token `navigateTo` must not appear in ANY file under
// hospital-ai-miniapp/pages/workspace/ (section switching is in-memory only).
//
// READ-ONLY: this script writes no artifacts and mutates no repo state.
// Exit 0 iff every group (a-f) passes; non-zero otherwise.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const appDir = resolve(root, 'hospital-ai-miniapp');
const workspaceDir = resolve(appDir, 'pages/workspace');
const WORKSPACE_ROUTE = 'pages/workspace/workspace';

const failures = [];

function record(letter, pass, message, detail) {
  if (pass) {
    console.log(`PASS - (${letter}) ${message}`);
    return;
  }
  console.log(`FAIL - (${letter}) ${message}${detail ? ` :: ${detail}` : ''}`);
  failures.push(letter);
}

// Run one group; a thrown error becomes a FAIL line instead of a stack trace.
function group(letter, fn) {
  try {
    const { pass, message, detail } = fn();
    record(letter, pass, message, detail);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    record(letter, false, `check threw: ${msg}`, '');
  }
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

// --- Load NAV_ITEMS: the registry the 8 sections derive from (TS module via tsx) ---
const navUrl = pathToFileURL(resolve(appDir, 'shared/ui/nav.ts')).href;
const { NAV_ITEMS } = await import(navUrl);

const items = Array.from(NAV_ITEMS);
const navKeys = items.map((item) => item.key);
const navRoutes = items.map((item) => item.route);
const nameForRoute = (route) => route.split('/')[1];

// (a) NAV_ITEMS: exactly 8; unique keys; unique routes; non-empty titles.
group('a', () => {
  const uniqueKeys = new Set(navKeys);
  const uniqueRoutes = new Set(navRoutes);
  const dupKeys = navKeys.filter((key, i) => navKeys.indexOf(key) !== i);
  const dupRoutes = navRoutes.filter((route, i) => navRoutes.indexOf(route) !== i);
  const emptyTitles = items
    .filter((item) => typeof item.title !== 'string' || item.title.trim() === '')
    .map((item) => item.key);
  const pass =
    items.length === 8 && dupKeys.length === 0 && dupRoutes.length === 0 && emptyTitles.length === 0;
  return {
    pass,
    message: `NAV_ITEMS: ${items.length} items, ${uniqueKeys.size} unique keys, ${uniqueRoutes.size} unique routes, ${
      items.length - emptyTitles.length
    } non-empty titles`,
    detail: pass
      ? ''
      : `want 8 items / unique keys+routes / non-empty titles (dupKeys=[${dupKeys}] dupRoutes=[${dupRoutes}] emptyTitles=[${emptyTitles}])`,
  };
});

// (b) app.json: pages[0] === workspace; page set === {workspace} ∪ nav routes; no duplicates.
group('b', () => {
  const appJson = readJson(resolve(appDir, 'app.json'));
  const pages = Array.isArray(appJson.pages) ? appJson.pages : [];
  const actualSet = new Set(pages);
  const expectedSet = new Set([WORKSPACE_ROUTE, ...navRoutes]);
  const dupPages = pages.filter((page, i) => pages.indexOf(page) !== i);
  const firstOk = pages[0] === WORKSPACE_ROUTE;
  const setEqual =
    actualSet.size === expectedSet.size && [...expectedSet].every((route) => actualSet.has(route));
  const missing = [...expectedSet].filter((route) => !actualSet.has(route));
  const extra = [...actualSet].filter((route) => !expectedSet.has(route));
  const pass = firstOk && setEqual && dupPages.length === 0;
  return {
    pass,
    message: `app.json: pages[0]=${pages[0] || '(none)'} (want ${WORKSPACE_ROUTE}); ${pages.length} pages == {workspace} + ${navRoutes.length} nav routes; ${dupPages.length} duplicates`,
    detail: pass
      ? ''
      : `missing=[${missing}] extra=[${extra}] duplicates=[${dupPages}] pages[0]=${pages[0] || '(none)'}`,
  };
});

// (c) Title single-source: pages/<route>.json navigationBarTitleText === nav item.title.
group('c', () => {
  const mismatches = [];
  for (const item of items) {
    const jsonPath = resolve(appDir, `${item.route}.json`);
    let actual = undefined;
    if (existsSync(jsonPath)) {
      actual = readJson(jsonPath).navigationBarTitleText;
    }
    if (actual !== item.title) {
      mismatches.push(
        `${item.route}: nav=${JSON.stringify(item.title)} json=${actual === undefined ? 'MISSING' : JSON.stringify(actual)}`
      );
    }
  }
  const pass = mismatches.length === 0;
  return {
    pass,
    message: `titles: ${items.length - mismatches.length}/${items.length} nav titles match pages/<route>.json navigationBarTitleText`,
    detail: pass ? '' : mismatches.join('; '),
  };
});

// (d) workspace.ts registry: MIGRATED_SECTIONS === nav keys; DEFAULT_SECTION === 'home' and registered.
group('d', () => {
  const src = readFileSync(resolve(workspaceDir, 'workspace.ts'), 'utf8');
  const migratedMatch = src.match(/const\s+MIGRATED_SECTIONS[^=]*=\s*\[([\s\S]*?)\]/);
  const migrated = migratedMatch
    ? [...migratedMatch[1].matchAll(/['"]([^'"]+)['"]/g)].map((match) => match[1])
    : null;
  const migratedSet = new Set(migrated || []);
  const navKeySet = new Set(navKeys);
  const defaultMatch = src.match(/const\s+DEFAULT_SECTION\s*=\s*(['"])([^'"]+)\1/);
  const defaultValue = defaultMatch ? defaultMatch[2] : null;
  const registryEqual =
    migrated !== null &&
    migratedSet.size === navKeySet.size &&
    [...navKeySet].every((key) => migratedSet.has(key));
  const defaultOk = defaultValue === 'home';
  const defaultRegistered = defaultValue !== null && migratedSet.has(defaultValue);
  const pass = registryEqual && defaultOk && defaultRegistered;
  return {
    pass,
    message: `registry: MIGRATED_SECTIONS ${migratedSet.size} keys == ${navKeySet.size} nav keys; DEFAULT_SECTION=${JSON.stringify(defaultValue)} (want "home", registered=${defaultRegistered})`,
    detail: pass
      ? ''
      : `migrated=[${[...migratedSet]}] navKeys=[${navKeys}] missingFromRegistry=[${navKeys.filter(
          (key) => !migratedSet.has(key)
        )}] extraInRegistry=[${[...migratedSet].filter((key) => !navKeySet.has(key))}] default=${JSON.stringify(defaultValue)}`,
  };
});

// (e) Section wiring: workspace.json <key>-view -> existing view files; wxml has id="sec-<key>".
group('e', () => {
  const wsJson = readJson(resolve(workspaceDir, 'workspace.json'));
  const using = wsJson.usingComponents || {};
  const wxml = readFileSync(resolve(workspaceDir, 'workspace.wxml'), 'utf8');
  const problems = [];
  let mappingOk = 0;
  let filesOk = 0;
  let idsOk = 0;
  for (const item of items) {
    const key = item.key;
    const name = nameForRoute(item.route);
    const compName = `${key}-view`;
    const expectedTarget = `/pages/${name}/view/view`;
    const actualTarget = using[compName];
    if (actualTarget === expectedTarget) mappingOk += 1;
    else
      problems.push(`usingComponents[${JSON.stringify(compName)}]=${JSON.stringify(actualTarget)} want ${JSON.stringify(expectedTarget)}`);

    const jsonExported = `pages/${name}/view/view.json`;
    const wxmlExported = `pages/${name}/view/view.wxml`;
    const hasJson = existsSync(resolve(appDir, jsonExported));
    const hasWxml = existsSync(resolve(appDir, wxmlExported));
    if (hasJson && hasWxml) filesOk += 1;
    else problems.push(`${name}: missing ${[!hasJson ? jsonExported : '', !hasWxml ? wxmlExported : ''].filter(Boolean).join(', ')}`);

    if (wxml.includes(`id="sec-${key}"`)) idsOk += 1;
    else problems.push(`workspace.wxml missing id="sec-${key}"`);
  }
  const pass = problems.length === 0;
  return {
    pass,
    message: `wiring: ${mappingOk}/${items.length} <key>-view mappings, ${filesOk}/${items.length} view.json+view.wxml files, ${idsOk}/${items.length} id="sec-<key>" panes`,
    detail: pass ? '' : problems.join('; '),
  };
});

// (f) Contract guard: no `navigateTo` token in any file under pages/workspace/ (recursive).
group('f', () => {
  const hits = [];
  let scanned = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        scanned += 1;
        const text = readFileSync(full, 'utf8');
        if (text.includes('navigateTo')) {
          const lines = text
            .split('\n')
            .map((line, i) => (line.includes('navigateTo') ? i + 1 : 0))
            .filter(Boolean);
          hits.push(`${full.slice(root.length + 1)}:L${lines.join(',L')}`);
        }
      }
    }
  };
  walk(workspaceDir);
  const pass = hits.length === 0;
  return {
    pass,
    message: `contract: "navigateTo" absent from all ${scanned} files under pages/workspace/`,
    detail: pass ? '' : `found in: ${hits.join('; ')}`,
  };
});

// --- Summary ---
const groups = ['a', 'b', 'c', 'd', 'e', 'f'];
if (failures.length === 0) {
  console.log(`workspace: ${groups.length}/${groups.length} groups passed`);
  process.exit(0);
}
console.log(`workspace: ${groups.length - failures.length}/${groups.length} groups passed; failed=[${failures.join(', ')}]`);
process.exit(1);
