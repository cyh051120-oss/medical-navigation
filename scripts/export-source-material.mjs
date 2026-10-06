#!/usr/bin/env node
// scripts/export-source-material.mjs
// Export the product-source listing required for software-copyright (软著) submission.
//
// Zero-dependency (Node built-ins only). Deterministic: identical inputs -> identical output.
//
// Scope — matches the source-size definition in docs/PROJECT-PLAN.md §1 (13,758 lines):
//   hospital-ai-miniapp/**   .ts .wxml .wxss  +  app.json / sitemap.json / pages/*/*.json
//   server/**                .ts .mjs
// Excluded (developer-tool / local config; listed verbatim in the generated index):
//   hospital-ai-miniapp/project.config.json
//   hospital-ai-miniapp/project.private.config.json
//   hospital-ai-miniapp/tsconfig.json
//   server/config.json          (local only, gitignored)
//   server/config.example.json
//   server/demo-fixtures.json
//   server/tsconfig.json
//
// Output (artifacts/soft-copyright/):
//   source-listing.txt            continuous listing over every included file
//   source-listing-60pages.txt    first 30 pages + last 30 pages (1 page = 50 lines)
//   source-material.json          index: file/line/page counts, exclusions, method
//
// Run: node scripts/export-source-material.mjs

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, 'artifacts', 'soft-copyright');

/** Lines per submitted page (软著 convention: 50 lines/page). */
const LINES_PER_PAGE = 50;
/** Pages taken from the head and the tail of the listing. */
const HEAD_PAGES = 30;
const TAIL_PAGES = 30;

/** Product roots, in listing order. */
const GROUPS = [
  { label: '微信小程序', root: 'hospital-ai-miniapp' },
  { label: '本地 AI 代理', root: 'server' },
];

/** Exact repo-relative paths excluded from the listing (tooling / local config). */
const EXCLUDED_PATHS = new Set([
  'hospital-ai-miniapp/project.config.json',
  'hospital-ai-miniapp/project.private.config.json',
  'hospital-ai-miniapp/tsconfig.json',
  'server/config.json',
  'server/config.example.json',
  'server/demo-fixtures.json',
  'server/tsconfig.json',
]);

/** Extensions kept per group (relative to that group's root). */
const GROUP_EXTENSIONS = {
  'hospital-ai-miniapp': new Set(['.ts', '.wxml', '.wxss', '.json']),
  server: new Set(['.ts', '.mjs']),
};

const SKIP_DIRS = new Set(['node_modules', '.git', '.omo', 'miniprogram_npm']);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function toPosix(p) {
  return p.split(path.sep).join('/');
}

/** Recursively collect repo-relative POSIX paths under `dir`, skipping SKIP_DIRS. */
function walk(absDir, relDir, out) {
  for (const name of readdirSync(absDir).sort()) {
    const abs = path.join(absDir, name);
    const rel = relDir === '' ? name : `${relDir}/${name}`;
    const st = statSync(abs);
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      walk(abs, rel, out);
    } else if (st.isFile()) {
      out.push(rel);
    }
  }
}

/** `wc -l` semantics: number of newline-terminated lines. */
function countLines(text) {
  if (text === '') return 0;
  const parts = text.split('\n');
  return text.endsWith('\n') ? parts.length - 1 : parts.length;
}

/** Split into the same line set `countLines` counts. */
function splitLines(text) {
  if (text === '') return [];
  const parts = text.split('\n');
  return text.endsWith('\n') ? parts.slice(0, -1) : parts;
}

// ---------------------------------------------------------------------------
// collect
// ---------------------------------------------------------------------------

const files = [];
const skipped = [];
const perGroup = [];

for (const group of GROUPS) {
  const absRoot = path.join(ROOT, group.root);
  if (!existsSync(absRoot)) {
    throw new Error(`missing product root: ${group.root}`);
  }
  const all = [];
  walk(absRoot, group.root, all);
  const allowed = GROUP_EXTENSIONS[group.root];

  const kept = [];
  for (const rel of all) {
    if (EXCLUDED_PATHS.has(rel)) {
      skipped.push(rel);
      continue;
    }
    // Nested-extension check: use the final extension only.
    const ext = path.extname(rel).toLowerCase();
    if (!allowed.has(ext)) {
      skipped.push(rel);
      continue;
    }
    kept.push(rel);
  }
  // `all` is already lexicographically ordered by the sorted walk; keep that order.
  perGroup.push({ label: group.label, root: group.root, files: kept });
  for (const rel of kept) files.push(rel);
}

// ---------------------------------------------------------------------------
// build the listing
// ---------------------------------------------------------------------------

const listingLines = [];
const fileStats = [];

for (const rel of files) {
  const text = readFileSync(path.join(ROOT, rel), 'utf8');
  const lines = splitLines(text);
  fileStats.push({ path: rel, lines: lines.length });
  listingLines.push(`// ===== ${rel} =====`);
  for (const line of lines) listingLines.push(line);
  listingLines.push('');
}

// Drop the single trailing blank added after the last file (keeps the listing tight).
if (listingLines.length > 0 && listingLines[listingLines.length - 1] === '') listingLines.pop();

const totalSourceLines = fileStats.reduce((sum, f) => sum + f.lines, 0);
const totalListingLines = listingLines.length;
const totalPages = Math.max(1, Math.ceil(totalListingLines / LINES_PER_PAGE));

function pageSlice(pageNumber) {
  const start = (pageNumber - 1) * LINES_PER_PAGE;
  return listingLines.slice(start, start + LINES_PER_PAGE);
}

function renderPages(pageNumbers) {
  const chunks = [];
  for (const n of pageNumbers) {
    if (n < 1 || n > totalPages) continue;
    chunks.push(`==================== 第 ${n} 页 / 共 ${totalPages} 页 ====================`);
    chunks.push(...pageSlice(n));
    chunks.push('');
  }
  return chunks.join('\n').replace(/\n+$/, '\n');
}

const headPages = [];
for (let i = 1; i <= Math.min(HEAD_PAGES, totalPages); i += 1) headPages.push(i);
const tailPages = [];
for (let i = Math.max(1, totalPages - TAIL_PAGES + 1); i <= totalPages; i += 1) {
  if (!headPages.includes(i)) tailPages.push(i);
}

const selectedPages = [...headPages, ...tailPages];
const selectedAll = headPages.length + tailPages.length >= totalPages;

// ---------------------------------------------------------------------------
// write
// ---------------------------------------------------------------------------

mkdirSync(OUT_DIR, { recursive: true });

const listingPath = path.join(OUT_DIR, 'source-listing.txt');
const pagesPath = path.join(OUT_DIR, 'source-listing-60pages.txt');
const indexPath = path.join(OUT_DIR, 'source-material.json');

writeFileSync(listingPath, `${listingLines.join('\n')}\n`, 'utf8');
writeFileSync(pagesPath, renderPages(selectedPages), 'utf8');

const index = {
  generated_by: 'scripts/export-source-material.mjs',
  software: '就医准备助手',
  version: 'V1.0',
  lines_per_page: LINES_PER_PAGE,
  selection: selectedAll
    ? `listing shorter than ${HEAD_PAGES + TAIL_PAGES} pages — every page included`
    : `first ${headPages.length} pages + last ${tailPages.length} pages`,
  totals: {
    files: files.length,
    source_lines: totalSourceLines,
    listing_lines: totalListingLines,
    pages: totalPages,
    selected_pages: selectedPages.length,
  },
  groups: perGroup.map((g) => ({
    label: g.label,
    root: g.root,
    files: g.files.length,
    lines: fileStats
      .filter((f) => f.path === g.root || f.path.startsWith(`${g.root}/`))
      .reduce((sum, f) => sum + f.lines, 0),
  })),
  files: fileStats,
  excluded_paths: Array.from(EXCLUDED_PATHS).sort(),
  skipped_non_source: skipped.sort(),
  outputs: {
    listing: toPosix(path.relative(ROOT, listingPath)),
    pages: toPosix(path.relative(ROOT, pagesPath)),
    index: toPosix(path.relative(ROOT, indexPath)),
  },
};

writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`, 'utf8');

console.log('[source-material] 就医准备助手 V1.0');
console.log(`[source-material] files           : ${files.length}`);
console.log(`[source-material] source lines    : ${totalSourceLines}`);
console.log(`[source-material] listing lines   : ${totalListingLines}`);
console.log(`[source-material] pages (${LINES_PER_PAGE}/page)   : ${totalPages}`);
console.log(`[source-material] page selection  : ${index.selection}`);
console.log(`[source-material] -> ${index.outputs.listing}`);
console.log(`[source-material] -> ${index.outputs.pages}`);
console.log(`[source-material] -> ${index.outputs.index}`);
