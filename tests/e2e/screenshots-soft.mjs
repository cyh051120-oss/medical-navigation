#!/usr/bin/env node
// 软著截图引擎（2026-10-18 视觉改版）。截图只取真正的手机工作台，绝不退回旧侧栏路由。
//
// Run once into a staging directory:
//   AUTOMATOR_PORT=9791 MHP_SHOT_OUT=artifacts/screenshots/.soft-run1 \
//     MHP_SHOT_MANIFEST=artifacts/screenshots/.soft-run1.json node tests/e2e/screenshots-soft.mjs
//
// `MHP_SHOT_ONLY=home-14,ai-consult-14` performs a non-destructive probe.
// Source data is deliberately fictional and local. All existing mhp_* keys touched by
// the engine are snapshotted before seeding and restored even if capture fails.
// The two extra workspace-* names are retained for compatibility with the historic
// 22-shot index: workspace-XX is the default home entry; workspace-settings-XX is
// the settings deep link. Both now use the new mobile workspace, not the legacy sidebar.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  CONFIG,
  KEYS,
  ROOT,
  delay,
  ensureDir,
  launchMiniProgram,
  log,
  section,
  seedMemory,
  seedNotes,
  seedProfile,
  seedQuestions,
  seedSymptoms,
  sha256,
} from './helpers.mjs';

const OUT_DIR = path.resolve(process.env.MHP_SHOT_OUT || path.join(ROOT, 'artifacts', 'screenshots', 'soft-copyright'));
const MANIFEST = path.resolve(process.env.MHP_SHOT_MANIFEST || path.join(os.tmpdir(), 'mhp-soft-shots-manifest.json'));
const FONTS = (process.env.MHP_SHOT_FONTS || '14,32').split(',').map((t) => Number(t.trim()));
const ONLY = new Set((process.env.MHP_SHOT_ONLY || '').split(',').map((t) => t.trim()).filter(Boolean));
const RESUME_REFERENCE = process.env.MHP_SHOT_RESUME_REFERENCE || '';
const NAMESPACE = 'mhp_';
const TIMEOUT_MS = Number(process.env.MHP_SHOT_OPERATION_TIMEOUT || 18000);
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PAGES = [
  'home', 'profile', 'symptoms', 'notes', 'questions', 'brief', 'ai', 'settings',
  'workspace', 'workspace-settings',
];
const TOUCH_KEYS = [...new Set([...Object.values(KEYS), 'ai_interview_ack'])];
const SEED_TIME = '2026-09-12T09:00:00.000Z';

function routeFor(name) {
  if (name === 'workspace') return 'pages/workspace/workspace';
  if (name === 'workspace-settings') return 'pages/workspace/workspace?section=settings';
  if (name === 'ai-consult') return 'pages/workspace/workspace?section=ai&mode=consult';
  return `pages/workspace/workspace?section=${name}`;
}
function runHead() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git HEAD not available: ${result.stderr}`);
  return result.stdout.trim();
}
function withDeadline(promise, label, ms = TIMEOUT_MS) {
  let handle;
  return Promise.race([
    promise,
    new Promise((_, reject) => { handle = setTimeout(() => reject(new Error(`${label}: timeout after ${ms}ms`)), ms); }),
  ]).finally(() => clearTimeout(handle));
}
async function wxCall(mp, method, ...args) {
  return withDeadline(mp.callWxMethod(method, ...args), `wx.${method}`);
}
async function snapshot(mp) {
  const current = new Map();
  // Failure before completing the snapshot MUST NOT mutate any persisted data.
  for (const key of TOUCH_KEYS) {
    const value = await wxCall(mp, 'getStorageSync', NAMESPACE + key);
    current.set(key, { present: value !== '' && value !== undefined && value !== null, value });
  }
  return current;
}
async function restore(mp, current) {
  const failures = [];
  for (const [key, saved] of current) {
    try {
      if (saved.present) await wxCall(mp, 'setStorageSync', NAMESPACE + key, saved.value);
      else await wxCall(mp, 'removeStorageSync', NAMESPACE + key);
    } catch (error) {
      failures.push(`${key}: ${error?.message || error}`);
    }
  }
  return failures;
}
function seedMessages() {
  // Screenshots show fictional *demo content*, never present fabricated answers as a real model result.
  return [
    { id: 'aimsg_soft_user_01', role: 'user', mode: 'organize', kind: 'text', content: '最近一周夜里睡不好，白天容易疲惫。', memoryDraft: '', blocks: [], disclaimer: '', errorText: '', canLocalOrganize: false, localText: '', createdAt: SEED_TIME },
    { id: 'aimsg_soft_assistant_01', role: 'assistant', mode: 'organize', kind: 'organize', content: '演示整理：夜间睡眠不佳约一周，白天感到疲惫。就诊时可补充睡眠时长与发生频率。', memoryDraft: '', blocks: [], disclaimer: '演示内容仅用于整理表达，不能替代医生判断。', errorText: '', canLocalOrganize: false, localText: '', createdAt: SEED_TIME },
    { id: 'aimsg_soft_user_02', role: 'user', mode: 'consult', kind: 'text', content: '饭后腹胀，复查时该向医生问些什么？', memoryDraft: '', blocks: [], disclaimer: '', errorText: '', canLocalOrganize: false, localText: '', createdAt: SEED_TIME },
    { id: 'aimsg_soft_assistant_02', role: 'assistant', mode: 'consult', kind: 'consult', content: '演示提示：请把症状发生时间与已有报告带给医生，并当面确认是否需要复查。', memoryDraft: '', blocks: [], disclaimer: '仅用于展示问诊沟通流程，不构成诊疗意见。', errorText: '', canLocalOrganize: false, localText: '', createdAt: SEED_TIME },
  ];
}
async function seed(mp, fontSize) {
  const values = {
    [KEYS.profile]: seedProfile(),
    [KEYS.symptoms]: seedSymptoms(),
    [KEYS.notes]: seedNotes(),
    [KEYS.questions]: seedQuestions(),
    [KEYS.briefs]: [],
    [KEYS.memory]: seedMemory(),
    [KEYS.preferences]: { aiEnabled: true, demoMode: true, consentVersion: 1, fontSize, highContrast: false, autoMemory: false, updatedAt: SEED_TIME },
    [KEYS.aiMessages]: seedMessages(),
    [KEYS.aiAck]: true,
    ai_interview_ack: true,
  };
  for (const [key, value] of Object.entries(values)) {
    await wxCall(mp, 'setStorageSync', NAMESPACE + key, value);
  }
}
function inspectPng(file) {
  const buf = fs.readFileSync(file);
  if (!buf.subarray(0, 8).equals(SIGNATURE) || buf.length < 15000) throw new Error(`invalid screenshot PNG: ${file}`);
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (width < 300 || height < 400) throw new Error(`invalid screenshot dimensions: ${width}x${height}`);
  return { bytes: buf.length, sha256: sha256(buf), width, height, ok: true };
}
async function capture(mp, name, fontSize) {
  const route = routeFor(name);
  await withDeadline(mp.reLaunch('/' + route), `reLaunch(${route})`);
  await delay(650);
  const file = path.join(OUT_DIR, `${name}-${fontSize}.png`);
  await withDeadline(mp.screenshot({ path: file }), `screenshot(${name}-${fontSize})`);
  return {
    name: `${name}-${fontSize}`,
    page: name,
    route,
    file: path.relative(ROOT, file),
    font_size: fontSize,
    state: name === 'ai-consult' ? 'consult-demo' : name === 'ai' ? 'organize-demo' : 'seeded',
    ...inspectPng(file),
  };
}
async function main() {
  if (FONTS.length === 0 || FONTS.some((size) => !Number.isInteger(size) || size < 14 || size > 32)) {
    throw new Error(`invalid MHP_SHOT_FONTS: ${FONTS.join(',')}`);
  }
  const plan = FONTS.flatMap((font) => [...PAGES, 'ai-consult'].map((name) => ({ name, font })));
  const selection = ONLY.size === 0 ? plan : plan.filter((p) => ONLY.has(`${p.name}-${p.font}`));
  const unknown = [...ONLY].filter((name) => !plan.some((p) => `${p.name}-${p.font}` === name));
  if (unknown.length) throw new Error(`unknown MHP_SHOT_ONLY names: ${unknown.join(', ')}`);
  if (path.resolve(OUT_DIR) === path.resolve(ROOT)) throw new Error('output directory must not be repository root');
  let reference = null;
  if (RESUME_REFERENCE) {
    reference = JSON.parse(fs.readFileSync(RESUME_REFERENCE, 'utf8'));
    if (reference.head !== runHead() || reference.shot_count !== plan.length || !reference.summary?.all_shots_ok)
      throw new Error('resume reference has a different HEAD or incomplete screenshot plan');
    reference = new Map(reference.shots.map((shot) => [shot.name, shot]));
  }
  ensureDir(OUT_DIR);
  section('SOFT-COPYRIGHT MOBILE WORKSPACE SCREENSHOTS');
  log(`head=${runHead()} out=${OUT_DIR} selected=${selection.length}/${plan.length}`);
  let mp;
  let saved;
  let restored = false;
  let complete = false;
  const shots = [];
  let firstDimensions;
  try {
    mp = await launchMiniProgram();
    saved = await snapshot(mp);
    log(`snapshotted ${saved.size} existing storage keys before any test writes`);
    for (const fontSize of FONTS) {
      if (!selection.some((p) => p.font === fontSize)) continue;
      await seed(mp, fontSize);
      for (const item of selection.filter((p) => p.font === fontSize)) {
        const id = `${item.name}-${fontSize}`;
        const existing = path.join(OUT_DIR, `${id}.png`);
        let shot;
        if (reference && fs.existsSync(existing)) {
          const meta = inspectPng(existing);
          if (meta.sha256 !== reference.get(id)?.sha256) throw new Error(`existing resume image differs from trusted first run: ${id}`);
          shot = {
            name: id, page: item.name, route: routeFor(item.name), file: path.relative(ROOT, existing),
            font_size: fontSize, state: item.name === 'ai-consult' ? 'consult-demo' : item.name === 'ai' ? 'organize-demo' : 'seeded',
            ...meta,
          };
          log(`reused checked ${id}: ${meta.sha256.slice(0, 12)}`);
        } else {
          shot = await capture(mp, item.name, fontSize);
          log(`shot ${shot.name}: ${shot.bytes} bytes ${shot.sha256.slice(0, 12)}`);
        }
        if (!firstDimensions) firstDimensions = `${shot.width}x${shot.height}`;
        if (`${shot.width}x${shot.height}` !== firstDimensions) throw new Error(`screen dimensions drifted for ${shot.name}`);
        shots.push(shot);
      }
    }
    complete = true;
  } finally {
    if (mp && saved) {
      const errors = await restore(mp, saved);
      restored = errors.length === 0;
      if (!restored) console.error(`STORAGE RESTORE FAILED: ${errors.join('; ')}`);
    }
    if (mp) {
      try { await withDeadline(mp.close(), 'close', 7000); } catch (error) { log(`close warning: ${error?.message || error}`); }
    }
  }
  if (!complete || !restored) throw new Error('capture or exact storage restoration failed: refusing completed manifest');
  const manifest = {
    tool: 'tests/e2e/screenshots-soft.mjs',
    command: 'AUTOMATOR_PORT=<port> MHP_SHOT_OUT=<stage-dir> MHP_SHOT_MANIFEST=<manifest-path> npm run screenshots:soft',
    timestamp: new Date().toISOString(),
    head: runHead(),
    platform: `${os.platform()} ${os.release()} (${os.arch()})`,
    node_version: process.version,
    project_path: CONFIG.projectPath,
    out_dir: path.relative(ROOT, OUT_DIR),
    font_sizes: FONTS,
    pages: PAGES.concat('ai-consult'),
    demo_mode: true,
    data_fixtures: 'fictional only; AI example responses labelled as demo',
    storage_restored: true,
    shot_count: shots.length,
    shots,
    summary: { all_shots_ok: shots.length === selection.length && shots.every((shot) => shot.ok) },
  };
  ensureDir(path.dirname(MANIFEST));
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
  log(`SUCCESS ${shots.length} screenshots; storage restored; manifest=${MANIFEST}`);
  return true;
}
const isDirectRun = !!process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectRun) main().then(() => process.exit(0), (error) => {
  console.error(`[screenshots-soft] FAIL ${error?.stack || error}`);
  process.exit(1);
});
