#!/usr/bin/env node
// Validate two independent captures then publish the latest soft-copyright screenshot set.
// Usage: node scripts/publish-soft-copyright.mjs <run1.json> <run2.json>
// This never reruns WeChat, touches local storage, or claims determinism without matching SHA256.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
const ROOT = process.cwd();
const TARGET_DIR = path.join(ROOT, 'artifacts', 'screenshots', 'soft-copyright');
const INDEX = path.join(ROOT, 'artifacts', 'screenshots', 'index.json');
const names = [
  ...[14,32].flatMap((font) => [
    'home', 'profile', 'symptoms', 'notes', 'questions', 'brief', 'ai',
    'settings', 'workspace', 'workspace-settings', 'ai-consult',
  ].map((name) => `${name}-${font}`)),
];
function sha256(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
function fail(message) { throw new Error(message); }
function ensureInside(root, target) {
  const rel = path.relative(root, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) fail(`out-of-bounds file: ${target}`);
}
function load(file) {
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (m.tool !== 'tests/e2e/screenshots-soft.mjs' || m.storage_restored !== true || !m.summary?.all_shots_ok) fail(`incomplete capture: ${file}`);
  if (m.shot_count !== 22 || m.shots?.length !== 22) fail(`wrong screenshot count: ${file}`);
  const ids = m.shots.map((s) => s.name);
  if (new Set(ids).size !== 22 || names.some((name) => !ids.includes(name))) fail(`missing/duplicate screenshot: ${file}`);
  const byName = new Map();
  for (const shot of m.shots) {
    if (!shot.route?.startsWith('pages/workspace/workspace')) fail(`not a mobile workspace screenshot: ${shot.name}`);
    if (!shot.ok || shot.width < 300 || shot.height < 400) fail(`bad screenshot: ${shot.name}`);
    const imagePath = path.resolve(ROOT, shot.file);
    ensureInside(path.resolve(ROOT, m.out_dir), imagePath);
    const bytes = fs.readFileSync(imagePath);
    if (bytes.length !== shot.bytes || sha256(bytes) !== shot.sha256) fail(`checksum mismatch: ${imagePath}`);
    byName.set(shot.name, { ...shot, bytes: bytes.length, imagePath });
  }
  return { file, manifest: m, byName };
}
const args = process.argv.slice(2);
if (args.length !== 2) fail('provide run1.json and run2.json');
const [first, second] = args.map((x) => load(path.resolve(x)));
if (first.manifest.head !== second.manifest.head) fail('capture runs have different Git HEAD');
const currentHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
if (currentHead.status !== 0 || currentHead.stdout.trim() !== first.manifest.head) fail('repository HEAD changed since capture');
const hashPairs = names.map((name) => {
  const a = first.byName.get(name);
  const b = second.byName.get(name);
  return { name, file: `artifacts/screenshots/soft-copyright/${name}.png`, page: a.page, route: a.route, font_size: a.font_size,
    state: a.state, bytes: a.bytes, run1_sha256: a.sha256, run2_sha256: b.sha256, equal: a.sha256 === b.sha256 };
});
const mismatches = hashPairs.filter((pair) => !pair.equal).map((pair) => pair.name);
const selected = second;
fs.mkdirSync(TARGET_DIR, { recursive: true });
// Back up the old material so a publish never irreversibly destroys the previous screenshots.
const backup = path.join(ROOT, 'artifacts', 'screenshots', `.soft-archive-${new Date().toISOString().replace(/[:.]/g,'-')}`);
fs.mkdirSync(backup, { recursive: true });
for (const name of names) {
  const target = path.join(TARGET_DIR, `${name}.png`);
  if (fs.existsSync(target)) fs.copyFileSync(target, path.join(backup, `${name}.png`));
}
if (fs.existsSync(INDEX)) fs.copyFileSync(INDEX, path.join(backup, 'index.json'));
for (const name of names) {
  const from = selected.byName.get(name).imagePath;
  const to = path.join(TARGET_DIR, `${name}.png`);
  const tmp = `${to}.new`;
  fs.copyFileSync(from, tmp);
  fs.renameSync(tmp, to);
}
const shots = names.map((name) => {
  const item = selected.byName.get(name);
  const { imagePath, ...meta } = item;
  return { ...meta, file: `artifacts/screenshots/soft-copyright/${name}.png` };
});
const index = {
  command: 'AUTOMATOR_PORT=<unique port> MHP_SHOT_OUT=<stage> MHP_SHOT_MANIFEST=<json> npm run screenshots:soft (two independent runs); node scripts/publish-soft-copyright.mjs <run1.json> <run2.json>',
  tool: 'tests/e2e/screenshots-soft.mjs',
  timestamp: selected.manifest.timestamp,
  head: selected.manifest.head,
  platform: selected.manifest.platform,
  node_version: selected.manifest.node_version,
  project_path: selected.manifest.project_path,
  out_dir: 'artifacts/screenshots/soft-copyright',
  font_sizes: selected.manifest.font_sizes,
  pages: selected.manifest.pages,
  demo_mode: true,
  source_data: 'local fictional seed only; AI example history is labeled demo',
  shot_count: shots.length,
  shots,
  determinism: {
    runs: 2, all_sha256_equal: mismatches.length === 0,
    mismatches,
    run1: { timestamp: first.manifest.timestamp, head: first.manifest.head, manifest: path.relative(ROOT, first.file) },
    run2: { timestamp: second.manifest.timestamp, head: second.manifest.head, manifest: path.relative(ROOT, second.file) },
    hash_pairs: hashPairs,
  },
  summary: { all_shots_ok: true, all_sha256_equal: mismatches.length === 0, mismatch_count: mismatches.length },
};
const tmpIndex = INDEX + '.new';
fs.writeFileSync(tmpIndex, JSON.stringify(index, null, 2) + '\n');
fs.renameSync(tmpIndex, INDEX);
console.log(`PUBLISHED 22/22 PNGs to ${TARGET_DIR}`);
console.log(`INDEX ${INDEX}`);
console.log(`OLD MATERIAL BACKUP ${backup}`);
console.log(`COLD-RUN SHA256 MATCHES ${22 - mismatches.length}/22`);
if (mismatches.length) console.log('NONDETERMINISTIC SHOTS:', mismatches.join(', '));
