#!/usr/bin/env node
/**
 * static-scan.mjs — zero-dependency static scanner v2 (capability bans + whitelist + neutral-term report).
 *
 * Run:  node scripts/static-scan.mjs [--files <glob>]... [--phase <name>] [--whitelist <path>]
 *   --files  restrict the scanned file set (repeatable). When omitted, the default scope is used:
 *              hospital-ai-miniapp/** /*.{ts,js,json,wxml,wxss,md}
 *              README.md / root *.md
 *              server/** /*.{ts,mjs,json,md}
 *              docs/** /*.md, scripts/** /*.mjs, tests/** /*.mjs, package.json
 *              (each scope matches zero files gracefully)
 *   --phase  output file name suffix; sanitized to [a-z0-9-]. Default: full
 *            -> artifacts/scan/static-scan-<phase>.json
 *   --whitelist <path>  OPTIONAL override. When omitted the embedded DEFAULT_WHITELIST is used,
 *            so the gate runs on a fresh clone with ZERO untracked inputs (no artifacts/ required).
 *            When explicitly passed and the file is missing/invalid -> exit 2.
 *   Neutral-term report is always written to artifacts/scan/neutral-terms.json.
 *
 * Exit codes: 0 = no violations; 1 = violations found; 2 = usage/internal error (bad args, malformed whitelist).
 * Neutral terms NEVER affect the exit code.
 *
 * Checks:
 *   ① capability bans, zero tolerance          -> non-whitelisted hit = violation
 *   ② neutral terms, report-only               -> counts + locations, never blocks
 *   ③ secrets / third-party domains            -> non-whitelisted hit = violation
 *   ④ app.json permission cross-check          -> declared-but-unused entry = violation
 *   ⑤ node --check on .js/.mjs; .ts via tsc    -> per-side skip when package.json/tsconfig/no .ts inputs absent
 *   ⑥ every scanned .json must parse           -> parse failure = violation
 *
 * Always-excluded directories: node_modules, .git, .omo, miniprogram_npm.
 *
 * Glob helper limits (documented intentionally):
 *   - Supports `*` (any run of non-`/` chars), `**` (any run incl. `/`), `?` (single non-`/` char),
 *     and single-level brace expansion `{a,b,c}`.
 *   - A trailing `** /` segment also matches zero path segments (so `a/** /x.js` matches `a/x.js`).
 *   - No character classes, no negation (`!`), no extglobs. Paths are matched as POSIX
 *     (forward-slash) paths relative to the current working directory.
 *
 * Whitelist: embedded DEFAULT_WHITELIST (no file required); `--whitelist <path>` overrides it.
 *   A hit is excused ONLY if BOTH `path` and `pattern` (regex, tested against the line text and the
 *   matched text) match AND the entry's `applies_to` category covers the check that produced the hit
 *   (`bans` | `secrets`; default ["bans"]). SECRET hits are NEVER excusable via the whitelist
 *   (enforced in code); `secrets_whitelisted` is asserted to be 0.
 *
 *   Synthetic secrets: `tests/**` and `scripts/**` legitimately embed placeholder credentials
 *   (e.g. `sk-demo-*`) and the scanner's own structural patterns. Secret hits restricted to those
 *   two trees are classified as `secrets_synthetic`: always printed in the report, never silent,
 *   and NOT counted as violations. The classification is path-restricted on purpose (a secret hit
 *   anywhere else is always a violation).
 *
 *   RESIDUAL RISK (deliberate): because classification is purely path-based, a REAL credential
 *   hardcoded under `tests/**` or `scripts/**` would be labeled synthetic and would NOT fail the
 *   gate. This tradeoff is accepted because those trees are test/tooling fixtures, are never
 *   shipped, and flagging every placeholder there would drown the signal; reviewers must still
 *   treat any `secrets_synthetic` hit as requiring human confirmation that it is a placeholder.
 *
 *   Malformed whitelist (embedded or --whitelist) => exit 2.
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const ROOT = process.cwd();
const SCAN_DIR = path.join(ROOT, 'artifacts', 'scan');

// --- exact ban list (plan line 49, 14 terms) — do not invent/drop terms ---
const BAN_TERMS = [
  '确诊',
  '诊断结论',
  '处方',
  '疗效保证',
  '急症拦截',
  '自动拨号',
  '预约挂号',
  '挂号成功',
  '候诊叫号',
  '推荐医生',
  '推荐医院',
  '智能分诊',
  'HIS',
  '医疗机构授权',
];
// Precision guard: purely ASCII terms (e.g. `HIS`) get a non-word boundary so that
// identifiers like `HISTORY_LOG` do NOT trigger a false positive, while a standalone
// `HIS` token (e.g. "已同步 HIS") still matches. CJK terms are matched as substrings.
const BAN_PATTERN = BAN_TERMS.map((t) =>
  /^[A-Za-z0-9]+$/.test(t) ? `(?<![A-Za-z0-9_])${t}(?![A-Za-z0-9_])` : t,
).join('|');
// Same term list as a plain regex source (no ASCII word-boundary precision guard): used by the
// whitelist entries that excuse files which legitimately embed the whole ban vocabulary.
const BAN_TERMS_RE_SRC = BAN_TERMS.join('|');

// ---------------------------------------------------------------------------
// embedded whitelist (default authority — no file under artifacts/ required)
// ---------------------------------------------------------------------------

// A hit is excused only when BOTH `path` and `pattern` match AND `applies_to` covers the check
// category. SECRET hits are never excused (enforced in `excuseReason`). Keep entries specific:
// path + the exact phrase(s), never a wildcard-for-everything shortcut.
const DEFAULT_WHITELIST = {
  version: 1,
  notes:
    'Embedded default. A capability-ban hit is excused ONLY if BOTH `path` (glob or substring) and `pattern` (regex, tested against the line text and matched text) match AND `applies_to` includes "bans". SECRET hits are NEVER excusable via the whitelist. All hospital-ai-miniapp/pages/ai/** entries are scoped to the AI page; server entries target the server-owned files; tests/** / scripts/** / docs/** entries cover legitimate ban-vocabulary fixtures, assertions and prose (never product copy).',
  entries: [
    {
      path: 'hospital-ai-miniapp/pages/ai/**',
      pattern: '固定安全提示|本工具不提供|安全提示句',
      reason: '固定安全提示：AI 页展示的固定安全提示句（含否定式能力说明）',
      applies_to: ['bans'],
    },
    {
      path: 'hospital-ai-miniapp/pages/ai/**',
      pattern: '不提供确诊|非诊断用途|不能替代医生|不能替代专业|仅供参考|不作为诊断',
      reason: '免责-否定式表述：如「不提供确诊」「非诊断用途」「不能替代医生」「仅供参考」',
      applies_to: ['bans'],
    },
    {
      path: 'hospital-ai-miniapp/pages/ai/**',
      pattern: '请向医生确认|向医生确认|请咨询医生',
      reason: '「请向医生确认」类标签',
      applies_to: ['bans'],
    },
    {
      path: 'hospital-ai-miniapp/pages/ai/**',
      pattern: '来源[:：]|来源链接|权威来源|资料来源',
      reason: '来源展示：问诊输出中的来源标签与链接展示',
      applies_to: ['bans'],
    },
    {
      path: 'hospital-ai-miniapp/pages/ai/**',
      pattern: '不推荐具体医生|无法推荐医生|不推荐具体医院|无法推荐医院',
      reason: '拒绝推荐措辞：如「不推荐具体医生」「无法推荐医生」',
      applies_to: ['bans'],
    },
    {
      path: 'server/validate.ts',
      pattern: BAN_TERMS_RE_SRC,
      reason: '服务端校验器检测模式字符串：server/validate.ts 合法包含禁令词元用于拦截检测',
      applies_to: ['bans'],
    },
    {
      path: 'server/prompts.ts',
      pattern: BAN_TERMS_RE_SRC,
      reason: '服务端提示词安全护栏检测模式字符串：server/prompts.ts 合法包含禁令词元与拒绝措辞',
      applies_to: ['bans'],
    },
    {
      path: 'server/redflags.ts',
      pattern: BAN_TERMS_RE_SRC,
      reason: '服务端红旗检测模式字符串：server/redflags.ts 合法包含禁令词元用于红旗识别',
      applies_to: ['bans'],
    },
    {
      path: 'server/mock-upstream.mjs',
      pattern: BAN_TERMS_RE_SRC,
      reason: 'mock 上游对抗样例字符串：server/mock-upstream.mjs 用于验证拦截的对抗输入',
      applies_to: ['bans'],
    },
    {
      path: 'server/**',
      pattern: '不推荐具体医生|无法推荐医生|不推荐具体医院|无法推荐医院|请向医生确认|非诊断用途',
      reason: '拒绝推荐措辞与免责声明：服务端输出的固定拒答/免责文案',
      applies_to: ['bans'],
    },
    {
      path: 'server/**/*.md',
      pattern: BAN_TERMS_RE_SRC,
      reason: '服务端文档论述受限词清单与拦截规则（README 的 P1-8/P1-10 说明），非产品文案',
      applies_to: ['bans'],
    },
    {
      path: 'hospital-ai-miniapp/config/texts.ts',
      pattern: '不提供确诊|非诊断用途|不能替代医生|不能替代专业|仅供参考|不作为诊断',
      reason:
        '免责-否定式表述：config/texts.ts 的固定免责与否定式文案（含「不提供确诊」等 mandated negation guard），仅豁免该文件',
      applies_to: ['bans'],
    },
    {
      path: 'hospital-ai-miniapp/config/texts.ts',
      pattern: '请向医生确认|向医生确认|请咨询医生',
      reason: '「请向医生确认」类标签：config/texts.ts 中引导用户线下确认的固定标签文案',
      applies_to: ['bans'],
    },
    {
      path: 'tests/**',
      pattern: BAN_TERMS_RE_SRC,
      reason:
        'E2E spec 合法内嵌禁令词元作为对抗样例、静态不变量断言与拒绝措辞校验（测试夹具，非产品文案）',
      applies_to: ['bans'],
    },
    {
      path: 'scripts/**',
      pattern: BAN_TERMS_RE_SRC,
      reason:
        'check/static-scan 实现文件合法内嵌禁令词元作为单一权威判定来源与对抗样例（门实现自身，非产品文案）',
      applies_to: ['bans'],
    },
    {
      path: 'docs/**',
      pattern: BAN_TERMS_RE_SRC,
      reason: '文档合法论述禁令词元（合规声明/审核说明；含 mandated 否定式表述）',
      applies_to: ['bans'],
    },
  ],
};

// Path trees whose secret-shaped literals are legitimate synthetic fixtures. Deliberately narrow:
// a secret hit outside these trees is always a violation.
const SYNTHETIC_SECRET_SCOPES = ['tests/**', 'scripts/**'];
const SYNTHETIC_SECRET_REASON =
  'synthetic fixture: placeholder credential / scanner structural pattern inside tests|scripts (never a real secret)';

const WHITELIST_CATEGORIES = new Set(['bans', 'secrets']);

// --- secrets / third-party domains ---
// Structural patterns only: no real credential literal is stored in this file, so the
// scanner's own source is safe to ship. To re-scan for a specific legacy leak, append its
// literal out-of-band via MHP_SECRET_PATTERN (pipe-joined regex source).
const SECRET_PATTERN_BASE = [
  String.raw`\bep-\d{14}\b`, // 推理接入点：ep-<14 位数字>
  String.raw`\bsk-[A-Za-z0-9_-]{16,}`, // 常见 API key：sk-…
  String.raw`\bAKID[A-Za-z0-9]{16,}`, // 常见云厂商 AccessKeyId
  String.raw`ark\.cn-beijing`, // 方舟默认域名
  String.raw`volces|baidubce|vop\.baidu|fanyi\.baidu`, // 相关厂商域名
].join('|');
const SECRET_PATTERN =
  typeof process.env.MHP_SECRET_PATTERN === 'string' &&
  process.env.MHP_SECRET_PATTERN.trim() !== ''
    ? `${SECRET_PATTERN_BASE}|${process.env.MHP_SECRET_PATTERN.trim()}`
    : SECRET_PATTERN_BASE;

// --- neutral terms: report only ---
const NEUTRAL_TERMS = ['科室', '医生', '医院', '就诊', '急诊'];

const EXCLUDED_DIRS = new Set(['node_modules', '.git', '.omo', 'miniprogram_npm']);

const DEFAULT_SCOPES = [
  'hospital-ai-miniapp/**/*.{ts,js,json,wxml,wxss,md}',
  'README.md',
  'server/**/*.{ts,mjs,json,md}',
  'docs/**/*.md',
  'scripts/**/*.mjs',
  'tests/**/*.mjs',
  '*.md',
  'package.json',
];

const APP_JSON_REL = 'hospital-ai-miniapp/app.json';

// declaration -> wx API usage regex (used for the "declared but unused" cross-check)
const PERMISSION_APIS = {
  'scope.userLocation':
    'wx\\.(getLocation|getFuzzyLocation|chooseLocation|onLocationChange|startLocationUpdate)',
};
const PRIVATE_INFO_APIS = {
  getLocation: 'wx\\.(getLocation|getFuzzyLocation|startLocationUpdate|onLocationChange)',
  chooseLocation: 'wx\\.chooseLocation',
  getFuzzyLocation: 'wx\\.getFuzzyLocation',
  startLocationUpdate: 'wx\\.startLocationUpdate',
  onLocationChange: 'wx\\.onLocationChange',
  chooseAddress: 'wx\\.chooseAddress',
  choosePoi: 'wx\\.choosePoi',
};
const BACKGROUND_APIS = {
  location: 'wx\\.(onLocationChange|startLocationUpdate|getLocation|getFuzzyLocation)',
};

class UsageError extends Error {}

// ---------------------------------------------------------------------------
// glob helpers
// ---------------------------------------------------------------------------

function expandBraces(glob) {
  const m = glob.match(/\{([^{}]*)\}/);
  if (!m) return [glob];
  const inner = m[1];
  const out = [];
  for (const part of inner.split(',')) {
    const next = glob.slice(0, m.index) + part + glob.slice(m.index + m[0].length);
    out.push(...expandBraces(next));
  }
  return out;
}

function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?'; // `**/` also matches zero path segments
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}

const _globCache = new Map();
function matchesGlob(file, glob) {
  let re = _globCache.get(glob);
  if (!re) {
    const patterns = expandBraces(glob).map(globToRegExp);
    re = patterns;
    _globCache.set(glob, patterns);
  }
  return re.some((r) => r.test(file));
}

function pathMatchesEntry(entryPath, file) {
  if (/[*?{\[]/.test(entryPath)) return matchesGlob(file, entryPath);
  return file.includes(entryPath);
}

// ---------------------------------------------------------------------------
// filesystem walk
// ---------------------------------------------------------------------------

function walk(dir, relBase) {
  const out = [];
  let names;
  try {
    names = readdirSync(dir).sort();
  } catch {
    return out;
  }
  for (const name of names) {
    const abs = path.join(dir, name);
    const rel = relBase ? relBase + '/' + name : name;
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (EXCLUDED_DIRS.has(name)) continue;
      out.push(...walk(abs, rel));
    } else if (st.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// whitelist
// ---------------------------------------------------------------------------

const DEFAULT_WHITELIST_SOURCE = 'embedded DEFAULT_WHITELIST (scripts/static-scan.mjs)';

function normalizeEntry(e, i, sourceLabel) {
  if (!e || typeof e.path !== 'string' || e.path.length === 0) {
    throw new UsageError(`${sourceLabel}: entry[${i}] missing non-empty "path"`);
  }
  if (typeof e.pattern !== 'string' || e.pattern.length === 0) {
    throw new UsageError(`${sourceLabel}: entry[${i}] missing non-empty "pattern"`);
  }
  if (typeof e.reason !== 'string' || e.reason.length === 0) {
    throw new UsageError(`${sourceLabel}: entry[${i}] missing non-empty "reason"`);
  }
  let appliesTo = ['bans'];
  if (e.applies_to !== undefined) {
    if (
      !Array.isArray(e.applies_to) ||
      e.applies_to.length === 0 ||
      !e.applies_to.every((c) => WHITELIST_CATEGORIES.has(c))
    ) {
      throw new UsageError(
        `${sourceLabel}: entry[${i}].applies_to must be a non-empty subset of ["bans","secrets"]`,
      );
    }
    appliesTo = [...new Set(e.applies_to)];
  }
  let re;
  try {
    re = new RegExp(e.pattern);
  } catch (err) {
    throw new UsageError(`${sourceLabel}: entry[${i}].pattern invalid regex: ${err.message}`);
  }
  return { path: e.path, pattern: e.pattern, reason: e.reason, applies_to: appliesTo, _re: re };
}

function entriesFromObject(obj, sourceLabel) {
  if (!obj || typeof obj !== 'object' || obj.version !== 1 || !Array.isArray(obj.entries)) {
    throw new UsageError(`${sourceLabel}: schema invalid: expected {"version":1,"entries":[...]}`);
  }
  return obj.entries.map((e, i) => normalizeEntry(e, i, sourceLabel));
}

// `cliPath === null` => use the embedded default (fresh-clone safe, no artifacts/ input).
function loadWhitelist(cliPath) {
  if (cliPath === null) {
    return {
      entries: entriesFromObject(DEFAULT_WHITELIST, DEFAULT_WHITELIST_SOURCE),
      source: DEFAULT_WHITELIST_SOURCE,
      path: null,
    };
  }
  if (!existsSync(cliPath)) {
    throw new UsageError(
      `whitelist not found: ${cliPath} (explicit --whitelist path); omit --whitelist to use the embedded default`,
    );
  }
  let raw;
  try {
    raw = readFileSync(cliPath, 'utf8');
  } catch (e) {
    throw new UsageError(`cannot read whitelist ${cliPath}: ${e.message}`);
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    throw new UsageError(`whitelist ${cliPath} is not valid JSON: ${e.message}`);
  }
  return { entries: entriesFromObject(obj, `--whitelist ${cliPath}`), source: cliPath, path: cliPath };
}

function excuseReason(entries, category, file, line, matchText) {
  // Hard rule: SECRET hits are never excusable via the whitelist (regardless of any entry).
  if (category === 'secrets') return null;
  for (const e of entries) {
    if (!e.applies_to.includes(category)) continue;
    if (!pathMatchesEntry(e.path, file)) continue;
    if (e._re.test(line) || e._re.test(matchText)) return e.reason;
  }
  return null;
}

function isSyntheticSecretPath(file) {
  return SYNTHETIC_SECRET_SCOPES.some((glob) => matchesGlob(file, glob));
}

// ---------------------------------------------------------------------------
// checks
// ---------------------------------------------------------------------------

function readText(rel, readErrors) {
  try {
    return readFileSync(path.join(ROOT, rel), 'utf8');
  } catch (e) {
    readErrors.push({ file: rel, error: e.message });
    return null;
  }
}

function scanRegex(files, contents, readErrors, pattern, entries, category) {
  const hits = [];
  for (const rel of files) {
    let content = contents.get(rel);
    if (content === undefined) content = readText(rel, readErrors);
    if (content == null) continue;
    contents.set(rel, content);
    const lines = content.split(/\r?\n/);
    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx];
      const r = new RegExp(pattern, 'g');
      let m;
      while ((m = r.exec(line)) !== null) {
        const rec = {
          file: rel,
          line: idx + 1,
          text: line.trim(),
          match: m[0],
          whitelisted: false,
          synthetic: false,
        };
        const reason = excuseReason(entries, category, rel, line, m[0]);
        if (reason) {
          rec.whitelisted = true;
          rec.reason = reason;
        } else if (category === 'secrets' && isSyntheticSecretPath(rel)) {
          rec.synthetic = true;
          rec.synthetic_reason = SYNTHETIC_SECRET_REASON;
        }
        hits.push(rec);
        if (m.index === r.lastIndex) r.lastIndex++;
      }
    }
  }
  return hits;
}

function scanNeutralTerms(files, contents, readErrors) {
  const terms = {};
  for (const t of NEUTRAL_TERMS) terms[t] = { count: 0, locations: [] };
  for (const rel of files) {
    let content = contents.get(rel);
    if (content === undefined) content = readText(rel, readErrors);
    if (content == null) continue;
    contents.set(rel, content);
    const lines = content.split(/\r?\n/);
    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx];
      for (const t of NEUTRAL_TERMS) {
        let from = 0;
        let c = 0;
        for (;;) {
          const at = line.indexOf(t, from);
          if (at === -1) break;
          c++;
          from = at + t.length;
        }
        if (c > 0) {
          terms[t].count += c;
          terms[t].locations.push({ file: rel, line: idx + 1, count: c });
        }
      }
    }
  }
  for (const t of NEUTRAL_TERMS) {
    terms[t].locations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  }
  const total = NEUTRAL_TERMS.reduce((s, t) => s + terms[t].count, 0);
  const totalLocations = NEUTRAL_TERMS.reduce((s, t) => s + terms[t].locations.length, 0);
  return { terms, summary: { total_occurrences: total, total_locations: totalLocations, terms: NEUTRAL_TERMS } };
}

function checkJson(files, contents, readErrors) {
  const jsonErrors = [];
  for (const rel of files) {
    if (!rel.endsWith('.json')) continue;
    let content = contents.get(rel);
    if (content === undefined) content = readText(rel, readErrors);
    if (content == null) continue;
    contents.set(rel, content);
    try {
      JSON.parse(content);
    } catch (e) {
      jsonErrors.push({ file: rel, error: e.message });
    }
  }
  return jsonErrors;
}

function checkJSyntax(files) {
  const syntaxErrors = [];
  for (const rel of files) {
    if (!(rel.endsWith('.js') || rel.endsWith('.mjs'))) continue;
    const res = spawnSync(process.execPath, ['--check', path.join(ROOT, rel)], { encoding: 'utf8' });
    if (res.status !== 0) {
      const err = (res.stderr || res.stdout || '').trim();
      syntaxErrors.push({
        file: rel,
        tool: 'node --check',
        exit: res.status,
        error: err.split('\n').slice(0, 4).join('\n'),
      });
    }
  }
  return syntaxErrors;
}

function checkPermissions(files, contents, readErrors) {
  const result = { declarations: [], violations: [], note: '' };
  if (!files.includes(APP_JSON_REL)) {
    result.note = 'app.json not in scan scope; cross-check skipped';
    return result;
  }
  let content = contents.get(APP_JSON_REL);
  if (content === undefined) content = readText(APP_JSON_REL, readErrors);
  if (content == null) {
    result.note = 'app.json unreadable; cross-check skipped';
    return result;
  }
  contents.set(APP_JSON_REL, content);
  let app;
  try {
    app = JSON.parse(content);
  } catch {
    result.note = 'app.json does not parse; cross-check skipped';
    return result;
  }

  const sourceText = files
    .filter((f) => f !== APP_JSON_REL)
    .map((f) => {
      let c = contents.get(f);
      if (c === undefined) c = readText(f, readErrors);
      if (c != null) contents.set(f, c);
      return c || '';
    })
    .join('\n');

  const decls = [];
  for (const name of Object.keys(app.permission || {})) {
    decls.push({ kind: 'permission', name, api: PERMISSION_APIS[name] || null });
  }
  for (const name of app.requiredPrivateInfos || []) {
    decls.push({ kind: 'requiredPrivateInfos', name, api: PRIVATE_INFO_APIS[name] || null });
  }
  for (const name of app.requiredBackgroundModes || []) {
    decls.push({ kind: 'requiredBackgroundModes', name, api: BACKGROUND_APIS[name] || null });
  }
  result.declarations = decls;

  for (const d of decls) {
    if (!d.api) {
      result.violations.push({
        declaration: `${d.kind}:${d.name}`,
        kind: d.kind,
        name: d.name,
        api: null,
        reason: 'declared but unused: no API mapping known for this declaration',
      });
      continue;
    }
    if (!new RegExp(d.api).test(sourceText)) {
      result.violations.push({
        declaration: `${d.kind}:${d.name}`,
        kind: d.kind,
        name: d.name,
        api: d.api,
        reason: 'declared but unused: no matching wx API usage in scanned source',
      });
    }
  }
  return result;
}

function tsCheck(files, label, tsconfigRel, scopePrefix) {
  const hasPkg = existsSync(path.join(ROOT, 'package.json'));
  const hasTsconfig = existsSync(path.join(ROOT, tsconfigRel));
  const tsInputs = files.filter((f) => f.startsWith(scopePrefix) && f.endsWith('.ts'));
  const base = { scope: scopePrefix, tsconfig: tsconfigRel, ts_inputs: tsInputs.length };
  if (!hasPkg) return { ...base, status: 'skipped', reason: 'root package.json missing' };
  if (!hasTsconfig) return { ...base, status: 'skipped', reason: `${tsconfigRel} missing` };
  if (tsInputs.length === 0) return { ...base, status: 'skipped', reason: `no ${label} .ts inputs` };
  const res = spawnSync('npx', ['tsc', '-p', tsconfigRel, '--noEmit'], {
    cwd: ROOT,
    encoding: 'utf8',
    // Windows: `npx` is `npx.cmd`; without a shell spawnSync cannot resolve it (res.error=ENOENT).
    shell: process.platform === 'win32',
  });
  if (res.error) return { ...base, status: 'error', reason: String(res.error.message) };
  const out = ((res.stdout || '') + (res.stderr || '')).trim();
  return {
    ...base,
    status: res.status === 0 ? 'passed' : 'failed',
    command: `npx tsc -p ${tsconfigRel} --noEmit`,
    exit: res.status,
    output: out.split('\n').slice(0, 20).join('\n'),
  };
}

// ---------------------------------------------------------------------------
// CLI + main
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const files = [];
  let phase = 'full';
  let whitelistPath = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--files') {
      const v = argv[++i];
      if (v === undefined) throw new UsageError('--files requires a value');
      files.push(v);
    } else if (a.startsWith('--files=')) {
      files.push(a.slice('--files='.length));
    } else if (a === '--phase') {
      const v = argv[++i];
      if (v === undefined) throw new UsageError('--phase requires a value');
      phase = v;
    } else if (a.startsWith('--phase=')) {
      phase = a.slice('--phase='.length);
    } else if (a === '--whitelist') {
      const v = argv[++i];
      if (v === undefined) throw new UsageError('--whitelist requires a path value');
      whitelistPath = v;
    } else if (a.startsWith('--whitelist=')) {
      whitelistPath = a.slice('--whitelist='.length);
    } else if (a === '--help' || a === '-h') {
      console.log(
        'usage: node scripts/static-scan.mjs [--files <glob>]... [--phase <name>] [--whitelist <path>]',
      );
      process.exit(0);
    } else {
      throw new UsageError(`unknown argument: ${a}`);
    }
  }
  const safePhase = (phase.toLowerCase().replace(/[^a-z0-9-]/g, '-') || 'full');
  return { files, phase: safePhase, whitelistPath };
}

function sortHits(a, b) {
  return a.file.localeCompare(b.file) || a.line - b.line || String(a.match).localeCompare(String(b.match));
}

function main() {
  const { files: fileGlobs, phase, whitelistPath } = parseArgs(process.argv.slice(2));
  const { entries, source: whitelistSource } = loadWhitelist(whitelistPath);
  const readErrors = [];

  const allFiles = walk(ROOT, '');
  const scopeGlobs = fileGlobs.length > 0 ? fileGlobs : DEFAULT_SCOPES;
  const files = allFiles
    .filter((f) => !f.split('/').some((seg) => EXCLUDED_DIRS.has(seg)))
    .filter((f) => scopeGlobs.some((g) => matchesGlob(f, g)))
    .sort();

  const contents = new Map();

  const banHits = scanRegex(files, contents, readErrors, BAN_PATTERN, entries, 'bans').sort(sortHits);
  const secretHits = scanRegex(files, contents, readErrors, SECRET_PATTERN, entries, 'secrets').sort(sortHits);
  const neutral = scanNeutralTerms(files, contents, readErrors);
  const jsonErrors = checkJson(files, contents, readErrors).sort((a, b) => a.file.localeCompare(b.file));
  const syntaxErrors = checkJSyntax(files).sort((a, b) => a.file.localeCompare(b.file));
  const permissions = checkPermissions(files, contents, readErrors);
  const tsCheckMiniapp = tsCheck(files, 'miniapp', 'hospital-ai-miniapp/tsconfig.json', 'hospital-ai-miniapp/');
  const tsCheckServer = tsCheck(files, 'server', 'server/tsconfig.json', 'server/');

  const banViolations = banHits.filter((h) => !h.whitelisted);
  const syntheticSecrets = secretHits.filter((h) => h.synthetic);
  const secretViolations = secretHits.filter((h) => !h.whitelisted && !h.synthetic);
  const secretsWhitelisted = secretHits.filter((h) => h.whitelisted).length;

  // Hard invariant: secret hits must never be excusable via the whitelist.
  if (secretsWhitelisted !== 0) {
    throw new Error(
      `internal invariant violated: secrets_whitelisted=${secretsWhitelisted} (secret hits are never whitelisted)`,
    );
  }

  const tsFailures =
    (tsCheckMiniapp.status === 'failed' || tsCheckMiniapp.status === 'error' ? 1 : 0) +
    (tsCheckServer.status === 'failed' || tsCheckServer.status === 'error' ? 1 : 0);

  const violationCount =
    banViolations.length +
    secretViolations.length +
    permissions.violations.length +
    jsonErrors.length +
    syntaxErrors.length +
    readErrors.length +
    tsFailures;

  const exitReason =
    violationCount === 0
      ? 'no violations'
      : `violations: bans=${banViolations.length},secrets=${secretViolations.length},permission=${permissions.violations.length},json=${jsonErrors.length},syntax=${syntaxErrors.length},read=${readErrors.length},ts=${tsFailures}`;

  const report = {
    phase,
    generatedAt: new Date().toISOString(),
    whitelist_source: whitelistSource,
    files_scanned: files,
    capability_bans: banHits,
    secrets: secretHits,
    permission_violations: permissions.violations,
    permission_declarations: permissions.declarations,
    json_errors: jsonErrors,
    syntax_errors: syntaxErrors,
    read_errors: readErrors,
    ts_check: { miniapp: tsCheckMiniapp, server: tsCheckServer },
    summary: {
      total_files: files.length,
      bans: banViolations.length,
      bans_whitelisted: banHits.length - banViolations.length,
      secrets: secretViolations.length,
      secrets_whitelisted: secretsWhitelisted,
      secrets_synthetic: syntheticSecrets.length,
      permission: permissions.violations.length,
      json_errors: jsonErrors.length,
      syntax_errors: syntaxErrors.length,
      ts_failures: tsFailures,
      violations: violationCount,
      exit_reason: exitReason,
    },
  };

  mkdirSync(SCAN_DIR, { recursive: true });
  writeFileSync(path.join(SCAN_DIR, `static-scan-${phase}.json`), JSON.stringify(report, null, 2) + '\n');

  const neutralReport = {
    phase,
    generatedAt: report.generatedAt,
    note: 'report-only; neutral terms never affect the scanner exit code',
    terms: neutral.terms,
    summary: neutral.summary,
  };
  writeFileSync(path.join(SCAN_DIR, 'neutral-terms.json'), JSON.stringify(neutralReport, null, 2) + '\n');

  const s = report.summary;
  console.log(`static-scan v2 [phase=${phase}]`);
  console.log(`  whitelist       : ${whitelistSource}`);
  console.log(`  files scanned : ${s.total_files}`);
  console.log(`  capability bans : ${s.bans} violation(s)${s.bans_whitelisted ? ` (+${s.bans_whitelisted} whitelisted)` : ''}`);
  console.log(`  secrets/domains : ${s.secrets} violation(s)${s.secrets_whitelisted ? ` (+${s.secrets_whitelisted} whitelisted)` : ''}`);
  console.log(`  secrets_synthetic : ${s.secrets_synthetic} (tests/** + scripts/** fixtures; report-only, never violations)`);
  console.log(`  permission      : ${s.permission} violation(s)`);
  console.log(`  json errors     : ${s.json_errors}`);
  console.log(`  syntax errors   : ${s.syntax_errors}`);
  console.log(`  read errors     : ${readErrors.length}`);
  console.log(`  ts check        : miniapp=${tsCheckMiniapp.status}, server=${tsCheckServer.status}`);
  console.log(`  neutral terms   : ${neutral.summary.total_occurrences} occurrence(s) (report-only, artifacts/scan/neutral-terms.json)`);
  console.log(`  => ${s.exit_reason}`);
  console.log(`  report: artifacts/scan/static-scan-${phase}.json`);

  process.exit(violationCount === 0 ? 0 : 1);
}

try {
  main();
} catch (e) {
  if (e instanceof UsageError) {
    console.error(`static-scan: ${e.message}`);
    process.exit(2);
  }
  console.error(`static-scan: internal error: ${e && e.stack ? e.stack : e}`);
  process.exit(2);
}
