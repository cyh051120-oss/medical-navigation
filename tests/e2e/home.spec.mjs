// home.spec.mjs — task 13 personal-workbench E2E (standalone).
//
// Run: node tests/e2e/home.spec.mjs
// Evidence: artifacts/e2e/home.json (happy + consent + empty + populated)
//           artifacts/qa/13-failure.txt (failure-path transcript)
//
// Transport notes (WeChat DevTools 2.01.x): the Page.* automator protocol
// (page.$ / page.data / evaluate) is dropped — those calls hang. This spec only
// uses the App-level surface the T12 shell proved works: currentPage, pageStack,
// screenshot, navigateTo/navigateBack/reLaunch and callWxMethod.
//
// Namespace note (RESOLVED): records.ts imports `../utils/storage` WITHOUT an
// extension; T13 found devtools resolved it to the legacy storage.js (`hza_`),
// shadowing storage.ts (`mhp_`). This fix deleted storage.js, so the runtime now
// resolves to storage.ts (`mhp_`). The dynamic render-diff detection below is
// retained as a REGRESSION GUARD: Phase 4 asserts the runtime namespace is
// exactly `mhp_`, so a re-added shadowing module fails loudly.
//
// Consent honesty: the privacy modal does NOT appear under devtools automation
// (T12 verified there is no pending privacy authorization), so the modal cannot
// be driven here. Consent state is simulated the way the app really reads it —
// writing the AppPreferences record via callWxMethod — and the storage-level
// invariant "no consent => no data written" is asserted directly, never a
// fabricated modal interaction.
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
  section,
  delay,
  md5,
  readSafe,
  makeCaptureScreenshot,
} from './helpers.mjs';

const HOME_ROUTE = 'pages/home/home';
const CONSENT_VERSION = 1;

// Declared namespace from storage.ts (mhp_) plus the legacy shadow namespace
// (hza_) probed by the regression guard. Detection picks which one the app reads
// at runtime; Phase 4 REQUIRES mhp_.
const APP_NAMESPACES = ['mhp_', 'hza_'];
const RAW_KEYS = {
  preferences: 'records_preferences',
  profile: 'records_profile',
  symptoms: 'records_symptoms',
  notes: 'records_notes',
  questions: 'records_questions',
  briefs: 'records_briefs',
};
const RECORD_RAW_KEYS = ['profile', 'symptoms', 'notes', 'questions', 'briefs'];

// 入口改为分组列表（记录 / 整理与带走 / 设置），AI 双模式合并为一个「AI 助手」入口。
const EXPECTED_ENTRIES = [
  { label: '个人档案', route: '/pages/profile/profile', query: {} },
  { label: '症状记录', route: '/pages/symptoms/symptoms', query: {} },
  { label: '资料摘录', route: '/pages/notes/notes', query: {} },
  { label: '待问清单', route: '/pages/questions/questions', query: {} },
  { label: '就医摘要', route: '/pages/brief/brief', query: {} },
  { label: 'AI 助手', route: '/pages/ai/ai', query: {} },
  { label: '设置', route: '/pages/settings/settings', query: {} },
];

const QA_FAILURE_PATH = path.join(path.resolve(E2E_ARTIFACTS, '..'), 'qa', '13-failure.txt');

const SAMPLE_SYMPTOM = (id) => ({
  id,
  createdAt: '2026-02-01T00:00:00.000Z',
  updatedAt: '2026-02-01T00:00:00.000Z',
  occurredAt: '2026-02-01T00:00:00.000Z',
  duration: '3 天',
  text: '最近一周夜里反复咳嗽，平躺时更明显',
  impact: '影响睡眠',
  tags: ['咳嗽'],
  attachment: null,
});

const fullKey = (raw) => APP_NAMESPACES.map((ns) => ns + raw);

async function removeRaw(miniProgram, raw) {
  for (const key of fullKey(raw)) {
    await miniProgram.callWxMethod('removeStorageSync', key);
  }
}

async function removeAllRecords(miniProgram) {
  for (const name of RECORD_RAW_KEYS) {
    await removeRaw(miniProgram, RAW_KEYS[name]);
  }
  await removeRaw(miniProgram, RAW_KEYS.preferences);
}

async function writeRaw(miniProgram, namespace, raw, value) {
  await miniProgram.callWxMethod('setStorageSync', namespace + raw, value);
}

async function writeAllNamespaces(miniProgram, raw, value) {
  for (const ns of APP_NAMESPACES) {
    await writeRaw(miniProgram, ns, raw, value);
  }
}

async function readConsent(miniProgram) {
  const out = {};
  for (const ns of APP_NAMESPACES) {
    const value = await miniProgram.callWxMethod('getStorageSync', ns + RAW_KEYS.preferences);
    out[ns] = value && typeof value === 'object' ? value.consentVersion ?? null : null;
  }
  return out;
}

async function recordState(miniProgram) {
  const byNamespace = {};
  const anyPresent = [];
  for (const ns of APP_NAMESPACES) {
    byNamespace[ns] = { present: [], absent: [] };
  }
  for (const raw of RECORD_RAW_KEYS) {
    for (const ns of APP_NAMESPACES) {
      const value = await miniProgram.callWxMethod('getStorageSync', ns + RAW_KEYS[raw]);
      if (Array.isArray(value) && value.length > 0) {
        byNamespace[ns].present.push({ name: raw, count: value.length });
        anyPresent.push(`${ns}${raw}`);
      } else {
        byNamespace[ns].absent.push(raw);
      }
    }
  }
  return { by_namespace: byNamespace, any_present: anyPresent };
}

const captureScreenshot = makeCaptureScreenshot('home');

async function renderEvidence(miniProgram, tag) {
  const stack = await miniProgram.pageStack();
  const top = Array.isArray(stack) && stack.length > 0 ? stack[stack.length - 1] : null;
  const shot = await captureScreenshot(miniProgram, tag);
  return {
    pageStack: stack.length,
    topPath: top ? top.path : null,
    topQuery: top ? top.query : null,
    screenshotBytes: shot.bytes,
    screenshotMd5: shot.md5,
    pngMagic: shot.pngMagic,
    ok: stack.length >= 1 && top !== null && top.path === HOME_ROUTE && shot.pngMagic && shot.bytes > 5000,
  };
}


function staticInvariantChecks() {
  const appSrc = readSafe(path.join(CONFIG.projectPath, 'app.ts'));
  const homeSrc = readSafe(path.join(CONFIG.projectPath, 'pages', 'home', 'home.ts'));
  const storageJsSrc = readSafe(path.join(CONFIG.projectPath, 'shared', 'utils', 'storage.js'));
  const storageTsSrc = readSafe(path.join(CONFIG.projectPath, 'shared', 'utils', 'storage.ts'));

  const confirmIdx = appSrc.indexOf('if (res.confirm)');
  const consentWriteIdx = appSrc.indexOf('consentVersion: PRIVACY_NOTICE_VERSION');
  const exitIdx = appSrc.indexOf('exitMiniProgramIfAvailable();', Math.max(confirmIdx, 0));
  const consentOnlyOnAgree =
    confirmIdx !== -1 && consentWriteIdx > confirmIdx && exitIdx > consentWriteIdx;

  const writesRecords = /records\.[a-zA-Z]+\.(add|update|remove|importMany)\s*\(/.test(homeSrc);
  const writesStorage = /setStorage(Sync)?\s*\(/.test(homeSrc);
  const homeReadOnly = !writesRecords && !writesStorage;

  const shadowJsNs = /const NS = '([^']+)'/.exec(storageJsSrc);
  const shadowTsNs = /export const NS = '([^']+)'/.exec(storageTsSrc);

  return {
    consentOnlyOnAgree,
    homeReadOnly,
    writesRecords,
    writesStorage,
    shadowing: {
      legacy_js_exists: shadowJsNs !== null,
      declared_ts_exists: shadowTsNs !== null,
      legacy_js_ns: shadowJsNs ? shadowJsNs[1] : null,
      declared_ts_ns: shadowTsNs ? shadowTsNs[1] : null,
    },
  };
}

/**
 * Detect which namespace the workbench reads: write the sample symptom to ONE
 * namespace, relaunch, and see if the rendered screenshot changes from the empty
 * baseline. The namespace that changes the render is the runtime namespace.
 */
async function detectRuntimeNamespace(miniProgram, emptyMd5Value) {
  const observations = {};
  for (let i = 0; i < APP_NAMESPACES.length; i += 1) {
    const ns = APP_NAMESPACES[i];
    await removeAllRecords(miniProgram);
    await writeRaw(miniProgram, ns, RAW_KEYS.symptoms, [SAMPLE_SYMPTOM(`sym_detect_${i}`)]);
    await miniProgram.reLaunch('/' + HOME_ROUTE);
    const shot = await captureScreenshot(miniProgram, `detect-${ns}`);
    observations[ns] = {
      md5: shot.md5,
      bytes: shot.bytes,
      changed_vs_empty: shot.md5 !== emptyMd5Value,
    };
  }
  await removeAllRecords(miniProgram);
  const runtime = APP_NAMESPACES.find((ns) => observations[ns].changed_vs_empty) || null;
  return { runtime, observations };
}

function buildFailureTranscript(data) {
  const bar = '='.repeat(72);
  const lines = [];
  lines.push(bar);
  lines.push('# artifacts/qa/13-failure.txt — task 13 failure-path evidence');
  lines.push('# command: node tests/e2e/home.spec.mjs');
  lines.push(`# timestamp: ${new Date().toISOString()}`);
  lines.push(`# project: ${CONFIG.projectPath}`);
  lines.push(bar);
  lines.push('');
  lines.push('## (a) 记录为 0 (fresh storage) → 空态，不伪造记录');
  lines.push('');
  lines.push(`cleared both namespaces (declared mhp_, legacy hza_) for: ${RECORD_RAW_KEYS.concat(['preferences']).join(', ')}`);
  lines.push(`preferences after clear (consentVersion per ns): ${JSON.stringify(data.consentBaseline)}`);
  lines.push(`record keys with data (per ns): ${JSON.stringify(data.recordsFresh.by_namespace)}`);
  lines.push(`any record present: ${JSON.stringify(data.recordsFresh.any_present)}`);
  lines.push(`empty render: pageStack=${data.renderEmpty.pageStack}, topPath=${data.renderEmpty.topPath},`);
  lines.push(`  screenshotBytes=${data.renderEmpty.screenshotBytes}, pngMagic=${data.renderEmpty.pngMagic}, md5=${data.renderEmpty.screenshotMd5}`);
  lines.push('');
  lines.push('assertion: zero user records in the namespace the app reads => workbench "hasRecords=false"');
  lines.push('  empty-state branch. No fabricated rows exist: home.ts only calls records.*.list().');
  lines.push('limitation: page.data/DOM is NOT readable over DevTools 2.01.x (Page.* dropped), so the');
  lines.push('  empty-state Chinese string is not scraped; zero-record storage + rendered screenshot are');
  lines.push('  the honest evidence.');
  lines.push('');
  lines.push('## (b) 拒绝同意 semantics: 无同意不写数据');
  lines.push('');
  lines.push(`baseline before any consent (consentVersion per ns): ${JSON.stringify(data.consentBaseline)}`);
  lines.push('  => all null/absent: the app has never been consented.');
  lines.push('RUNTIME proof: with a cleared namespace, mhp_records_preferences AND hza_records_preferences');
  lines.push('  are absent, so app.ts checkPrivacyAuth() sees consentVersion===null. In that state this run');
  lines.push('  wrote NO user records (record keys empty above).');
  lines.push('LIMITATION (documented, not faked): the privacy modal does NOT appear under devtools');
  lines.push('  automation (verified T12 — no pending privacy authorization), so the 拒绝 button cannot be');
  lines.push('  pressed here. The refusal branch (wx.exitMiniProgram) is proven STATICALLY below.');
  lines.push('');
  lines.push('STATIC app.ts proof — consent version written ONLY inside the agree branch:');
  lines.push(`  contains "if (res.confirm)": ${data.statics.consentOnlyOnAgree}`);
  lines.push(`  consent write sits between confirm and the exit() fallback: ${data.statics.consentOnlyOnAgree}`);
  lines.push('STATIC home.ts proof — workbench is read-only (no data writes):');
  lines.push(`  records.*.add/update/remove/importMany present: ${data.statics.writesRecords}`);
  lines.push(`  setStorage* present: ${data.statics.writesStorage}`);
  lines.push(`  homeReadOnly: ${data.statics.homeReadOnly}`);
  lines.push('');
  lines.push('## (c) namespace shadowing — RESOLVED (legacy storage.js deleted)');
  lines.push('');
  lines.push('  history: T13 found records.ts imports "../utils/storage" WITHOUT an extension and devtools');
  lines.push('  resolved it to the on-disk legacy storage.js (NS=hza_), shadowing storage.ts (NS=mhp_).');
  lines.push('  fix: legacy storage.js was removed, so the extensionless specifier now resolves to');
  lines.push('  storage.ts — the designed mhp_ namespace; records now persist under mhp_*.');
  lines.push(`  legacy storage.js exists: ${data.statics.shadowing.legacy_js_exists} (NS=${data.statics.shadowing.legacy_js_ns})`);
  lines.push(`  declared storage.ts exists: ${data.statics.shadowing.declared_ts_exists} (NS=${data.statics.shadowing.declared_ts_ns})`);
  lines.push(`  runtime namespace observed by render-change probe: ${JSON.stringify(data.runtimeDetection.runtime)}`);
  lines.push(`  per-namespace render change: ${JSON.stringify(data.runtimeDetection.observations)}`);
  lines.push('  the render-diff probe is retained as a REGRESSION GUARD: Phase 4 requires the runtime');
  lines.push('  namespace to be exactly mhp_, so a re-added shadowing module fails loudly.');
  lines.push('');
  lines.push('## verdict');
  lines.push('');
  const verdict =
    data.recordsFresh.any_present.length === 0 &&
    Object.values(data.consentBaseline).every((v) => v === null) &&
    data.statics.consentOnlyOnAgree &&
    data.statics.homeReadOnly &&
    data.renderEmpty.ok;
  lines.push(`PASS=${verdict} (fresh storage => no records, no consent; consent write only on agree; home read-only)`);
  lines.push(bar);
  lines.push('');
  return lines.join('\n');
}

async function main() {
  ensureDir(E2E_ARTIFACTS);
  ensureDir(path.dirname(QA_FAILURE_PATH));
  section('HOME WORKBENCH SPEC');

  const report = {
    command: 'node tests/e2e/home.spec.mjs',
    timestamp: new Date().toISOString(),
    platform: `${os.platform()} ${os.release()} (${os.arch()})`,
    node_version: process.version,
    project_path: CONFIG.projectPath,
    render: null,
    render_populated: null,
    entries: [],
    namespace: null,
    consent: {
      model: 'storage-simulation',
      modal_in_automation: false,
      declared_key: 'mhp_records_preferences',
      legacy_shadow_key: 'hza_records_preferences',
      baseline: null,
      written: null,
      after_relaunch: null,
      no_consent_no_records: null,
      consent_does_not_write_records: null,
    },
    empty_state: null,
    static_invariants: null,
    summary: null,
  };

  const statics = staticInvariantChecks();
  report.static_invariants = {
    consent_only_on_agree: statics.consentOnlyOnAgree,
    home_read_only: statics.homeReadOnly,
    namespace_shadowing: statics.shadowing,
  };

  let allOk = true;
  let miniProgram;
  let failureData = null;

  try {
    // ---- Phase 1: fresh state → empty-state + no-consent/no-write evidence ----
    miniProgram = await launchMiniProgram();
    await removeAllRecords(miniProgram);
    await miniProgram.reLaunch('/' + HOME_ROUTE);

    const consentBaseline = await readConsent(miniProgram);
    const recordsFresh = await recordState(miniProgram);
    const renderEmpty = await renderEvidence(miniProgram, 'empty');

    report.consent.baseline = consentBaseline;
    report.consent.no_consent_no_records = recordsFresh.any_present.length === 0;
    report.empty_state = {
      record_count: 0,
      any_record_present: recordsFresh.any_present,
      record_state: recordsFresh.by_namespace,
      render_ok: renderEmpty.ok,
      screenshotBytes: renderEmpty.screenshotBytes,
      pngMagic: renderEmpty.pngMagic,
      note: 'DOM text not scrapable over DevTools 2.01.x; zero-record storage + rendered screenshot are the evidence',
    };
    report.render = { ...renderEmpty, method: 'currentPage+pageStack+screenshot' };

    if (recordsFresh.any_present.length === 0) {
      ok('fresh: zero user records in both namespaces (empty-state condition)');
    } else {
      fail(`fresh not clean: ${JSON.stringify(recordsFresh.any_present)}`);
      allOk = false;
    }
    if (Object.values(consentBaseline).every((v) => v === null)) {
      ok('fresh: no consent record in either namespace (no-consent => no-data invariant)');
    } else {
      fail(`consent unexpectedly present: ${JSON.stringify(consentBaseline)}`);
      allOk = false;
    }
    if (statics.consentOnlyOnAgree && statics.homeReadOnly) {
      ok('static invariants: consent write only on agree; home is read-only');
    } else {
      fail(`static invariant failure: consentOnlyOnAgree=${statics.consentOnlyOnAgree} homeReadOnly=${statics.homeReadOnly}`);
      allOk = false;
    }

    // ---- Phase 2: render + 8-entry navigation (happy path) ----
    const initial = await miniProgram.currentPage();
    const initialPath = initial ? initial.path : null;
    if (initialPath === HOME_ROUTE) {
      ok(`launch page "${HOME_ROUTE}" current`);
    } else {
      fail(`launch page: expected "${HOME_ROUTE}" but observed "${initialPath}"`);
      allOk = false;
    }
    if (renderEmpty.ok) {
      ok(`render evidence: pageStack=${renderEmpty.pageStack}, bytes=${renderEmpty.screenshotBytes}, pngMagic=${renderEmpty.pngMagic}`);
    } else {
      fail(`render check failed: ${JSON.stringify(renderEmpty)}`);
      allOk = false;
    }

    for (const entry of EXPECTED_ENTRIES) {
      const expectedPath = entry.route.replace(/^\//, '').split('?')[0];
      let observed = null;
      let observedQuery = null;
      try {
        const page = await miniProgram.navigateTo(entry.route);
        observed = page ? page.path : null;
        observedQuery = page ? page.query : null;
      } catch (err) {
        fail(`navigateTo "${entry.route}" threw: ${err?.message || err}`);
      }
      const queryOk = Object.entries(entry.query).every(
        ([k, v]) => observedQuery && observedQuery[k] === v
      );
      const entryOk = observed === expectedPath && queryOk;
      report.entries.push({
        label: entry.label,
        route: entry.route,
        query: entry.query,
        observed,
        observedQuery,
        method: 'navigateTo',
        ok: entryOk,
      });
      if (entryOk) ok(`entry "${entry.label}" -> "${entry.route}" navigable`);
      else {
        fail(`entry "${entry.label}": expected "${entry.route}" but observed path="${observed}" query=${JSON.stringify(observedQuery)}`);
        allOk = false;
      }
      try {
        await miniProgram.navigateBack();
      } catch (err) {
        fail(`navigateBack after "${entry.route}" threw: ${err?.message || err}`);
        allOk = false;
      }
    }

    // ---- Phase 3: simulate consent state (both namespaces) ----
    const consentRecord = {
      aiEnabled: false,
      consentVersion: CONSENT_VERSION,
      fontSize: 14,
      highContrast: false,
      updatedAt: new Date().toISOString(),
    };
    await writeAllNamespaces(miniProgram, RAW_KEYS.preferences, consentRecord);
    report.consent.written = consentRecord;
    log(`simulated consent: wrote records_preferences to ${APP_NAMESPACES.join(', ')} (model=storage-simulation)`);

    try {
      await miniProgram.close();
      log('miniProgram.close() done');
    } catch (err) {
      log(`warning: close failed: ${err?.message || err}`);
    }
    await delay(2000);
    miniProgram = await launchMiniProgram();

    const afterRelaunch = await readConsent(miniProgram);
    const recordsAfterConsent = await recordState(miniProgram);
    const consentPersisted = Object.values(afterRelaunch).every((v) => v === CONSENT_VERSION);
    const noRecordsFromConsent = recordsAfterConsent.any_present.length === 0;

    report.consent.after_relaunch = {
      consentVersion_per_ns: afterRelaunch,
      record_keys_with_data: recordsAfterConsent.any_present,
    };
    report.consent.consent_does_not_write_records = noRecordsFromConsent;

    if (consentPersisted) {
      ok(`consentVersion persisted across relaunch in all namespaces (${CONSENT_VERSION})`);
    } else {
      fail(`consentVersion not persisted everywhere: ${JSON.stringify(afterRelaunch)}`);
      allOk = false;
    }
    if (noRecordsFromConsent) {
      ok('consent alone does not auto-write user records');
    } else {
      fail(`consent wrote records unexpectedly: ${JSON.stringify(recordsAfterConsent.any_present)}`);
      allOk = false;
    }

    // ---- Phase 4: runtime namespace detection + populated render proof ----
    await removeAllRecords(miniProgram);
    await miniProgram.reLaunch('/' + HOME_ROUTE);
    const renderEmpty2 = await renderEvidence(miniProgram, 'empty2');

    const detection = await detectRuntimeNamespace(miniProgram, renderEmpty2.screenshotMd5);
    report.namespace = {
      declared: 'mhp_',
      candidates: APP_NAMESPACES,
      runtime_observed: detection.runtime,
      observations: detection.observations,
      empty_baseline_md5: renderEmpty2.screenshotMd5,
    };
    if (detection.runtime === 'mhp_') {
      ok(`runtime namespace is "mhp_" (storage.ts; legacy storage.js shadow is gone)`);
    } else {
      fail(
        `runtime namespace must be "mhp_" but observed ${JSON.stringify(detection.runtime)} — a ` +
          're-added shadowing module (e.g. shared/utils/storage.js) would re-resolve the ' +
          `extensionless '../utils/storage' specifier away from storage.ts; observations: ${JSON.stringify(detection.observations)}`
      );
      allOk = false;
    }

    const targetNs = detection.runtime || APP_NAMESPACES[0];
    await removeAllRecords(miniProgram);
    await writeRaw(miniProgram, targetNs, RAW_KEYS.profile, {
      id: 'prof_demo_1',
      createdAt: '2026-02-01T00:00:00.000Z',
      updatedAt: '2026-02-01T00:00:00.000Z',
      name: '李建国',
      ageRange: '60-69',
      allergies: '青霉素',
      medications: '氯沙坦',
      history: '',
    });
    await writeRaw(miniProgram, targetNs, RAW_KEYS.symptoms, [
      SAMPLE_SYMPTOM('sym_demo_1'),
      { ...SAMPLE_SYMPTOM('sym_demo_2'), updatedAt: '2026-02-05T00:00:00.000Z', text: '活动后有点气短' },
    ]);
    await writeRaw(miniProgram, targetNs, RAW_KEYS.notes, [
      {
        id: 'note_demo_1',
        createdAt: '2026-02-03T00:00:00.000Z',
        updatedAt: '2026-02-03T00:00:00.000Z',
        name: '社区体检报告',
        excerpt: '血压偏高',
        sourceDate: '2026-08',
        attachment: null,
        remark: '',
      },
    ]);
    await writeRaw(miniProgram, targetNs, RAW_KEYS.questions, [
      {
        id: 'ques_demo_1',
        createdAt: '2026-02-04T00:00:00.000Z',
        updatedAt: '2026-02-04T00:00:00.000Z',
        text: '咳嗽是否需要进一步检查',
        done: false,
        group: '',
        source: 'manual',
      },
    ]);
    await miniProgram.reLaunch('/' + HOME_ROUTE);
    const renderPopulated = await renderEvidence(miniProgram, 'populated');
    const populatedChanged = renderPopulated.screenshotMd5 !== renderEmpty2.screenshotMd5;
    report.render_populated = {
      ...renderPopulated,
      namespace: targetNs,
      changed_vs_empty_md5: populatedChanged,
    };
    if (renderPopulated.ok && populatedChanged) {
      ok(`populated workbench renders records (md5 ${renderEmpty2.screenshotMd5} -> ${renderPopulated.screenshotMd5})`);
    } else {
      fail(`populated render did not change: ${JSON.stringify(report.render_populated)}`);
      allOk = false;
    }

    failureData = {
      consentBaseline,
      recordsFresh,
      renderEmpty,
      statics,
      runtimeDetection: detection,
    };
  } catch (err) {
    fail(`home spec run error: ${err?.stack || err}`);
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
  }

  const entriesPassed = report.entries.filter((e) => e.ok).length;
  const consentOk =
    report.consent.after_relaunch !== null &&
    Object.values(report.consent.after_relaunch.consentVersion_per_ns).every(
      (v) => v === CONSENT_VERSION
    );
  const populatedOk = Boolean(
    report.render_populated && report.render_populated.ok && report.render_populated.changed_vs_empty_md5
  );

  report.summary = {
    render_ok: report.render ? report.render.ok : false,
    entries_total: report.entries.length,
    entries_passed: entriesPassed,
    namespace_runtime_observed: report.namespace ? report.namespace.runtime_observed : null,
    populated_render_ok: populatedOk,
    consent_ok: consentOk,
    no_consent_no_records: report.consent.no_consent_no_records === true,
    consent_does_not_write_records: report.consent.consent_does_not_write_records === true,
    empty_state_ok: Boolean(report.empty_state && report.empty_state.render_ok),
    passed: false,
    failed: true,
  };

  const checks = {
    render_ok: report.summary.render_ok === true,
    entries_total: report.summary.entries_total === EXPECTED_ENTRIES.length,
    entries_passed: entriesPassed === EXPECTED_ENTRIES.length,
    namespace_observed: report.summary.namespace_runtime_observed === 'mhp_',
    populated_ok: populatedOk === true,
    consent_ok: consentOk === true,
    no_consent_no_records: report.summary.no_consent_no_records === true,
    consent_does_not_write_records: report.summary.consent_does_not_write_records === true,
  };
  const okReport = Object.values(checks).every((v) => v === true);
  log(`summary checks: ${JSON.stringify(checks)}`);

  if (failureData !== null) {
    fs.writeFileSync(QA_FAILURE_PATH, buildFailureTranscript(failureData));
    log(`failure evidence: ${QA_FAILURE_PATH}`);
  }

  report.summary.passed = okReport && allOk === true;
  report.summary.failed = !report.summary.passed;
  const reportPath = path.join(E2E_ARTIFACTS, 'home.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  log(`home evidence: ${reportPath}`);

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
