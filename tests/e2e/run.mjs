// E2E entrypoint: pre-flight prereq capture, then run the E2E spec matrix.
// Exit 0 iff every spec passes. Never claims pass without a real assert.
//
// Spec discovery: every `tests/e2e/*.spec.mjs` on disk (readdirSync + suffix filter). This is the
// single authoritative list — no hand-maintained copy to drift. Run order is deterministic:
// `bootstrap` first when present (harness smoke), then the rest alphabetically. Non-spec helpers
// (helpers.mjs / devtools-background.mjs / run.mjs / screenshots*.mjs) are naturally excluded by
// the `.spec.mjs` suffix.
// Combined transcript -> artifacts/e2e/ai-all.log
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONFIG,
  E2E_ARTIFACTS,
  cleanupDevtools,
  ensureDir,
  failWithGuidance,
  log,
  section,
  tcpProbe,
  truncate,
  writeBlockedDoc,
} from './helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Per-spec timeout overrides: ai (largest matrix) gets a longer budget; every other spec uses the
// default. Names are spec basenames (no extension). Each spec also gets its own transcript log
// (`artifacts/e2e/<name>.log`) in addition to the combined ai-all.log.
const DEFAULT_SPEC_TIMEOUT = CONFIG.timeout + 120000;
const SPEC_OVERRIDES = {
  ai: {
    timeout: Math.max(CONFIG.timeout + 120000, 600000),
  },
};

/** All `*.spec.mjs` in tests/e2e, `bootstrap` pinned first, the rest alphabetical. */
function discoverSpecs() {
  const names = fs
    .readdirSync(__dirname)
    .filter((f) => f.endsWith('.spec.mjs'))
    .map((f) => f.slice(0, -'.spec.mjs'.length))
    .sort();
  const ordered = names.includes('bootstrap')
    ? ['bootstrap', ...names.filter((n) => n !== 'bootstrap')]
    : names;
  return ordered.map((name) => {
    const override = SPEC_OVERRIDES[name] || {};
    return {
      name,
      path: path.join(__dirname, `${name}.spec.mjs`),
      log: path.join(E2E_ARTIFACTS, `${name}.log`),
      timeout: override.timeout ?? DEFAULT_SPEC_TIMEOUT,
    };
  });
}

const SPECS = discoverSpecs();

const ALL_LOG = path.join(E2E_ARTIFACTS, 'ai-all.log');

function npmVersion() {
  const res = spawnSync('npm', ['--version'], { encoding: 'utf8' });
  return (res.stdout || '').trim() || 'unknown';
}

function probeCli(cliPath) {
  const res = spawnSync(cliPath, ['--help'], {
    encoding: 'utf8',
    timeout: 8000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const output = `${res.stdout || ''}${res.stderr || ''}`.trim();
  return {
    command: `${cliPath} --help`,
    exit_code: res.status,
    output: truncate(output, 2000),
  };
}

async function main() {
  ensureDir(E2E_ARTIFACTS);

  // Zero-spec guard: an empty discovery list must never be reported as a green run.
  if (SPECS.length === 0) {
    const cause = `no E2E specs discovered: 0 *.spec.mjs in ${__dirname}; refusing to report "all 0 spec(s) green"`;
    const prereq = {
      timestamp: new Date().toISOString(),
      spec_count: 0,
      project_path: CONFIG.projectPath,
      automation_port: CONFIG.port,
    };
    fs.writeFileSync(path.join(E2E_ARTIFACTS, 'prereq.json'), JSON.stringify(prereq, null, 2) + '\n');
    const blockedPath = writeBlockedDoc(cause, prereq);
    fs.writeFileSync(ALL_LOG, renderAllTranscript(prereq, [], { blocked: cause, blockedPath }));
    failWithGuidance(cause, `restore tests/e2e/*.spec.mjs, then rerun\nblocked doc: ${blockedPath}`);
    process.exitCode = 1;
    return;
  }

  const cliExists = fs.existsSync(CONFIG.cliPath);
  const portReachable = await tcpProbe(CONFIG.port, '127.0.0.1', 500);

  const prereq = {
    timestamp: new Date().toISOString(),
    node_version: process.version,
    npm_version: npmVersion(),
    platform: `${os.platform()} ${os.release()} (${os.arch()})`,
    project_path: CONFIG.projectPath,
    cli_path_checked: CONFIG.cliPath,
    cli_exists: cliExists,
    cli_probe: cliExists ? probeCli(CONFIG.cliPath) : null,
    automation_port: CONFIG.port,
    port_reachable: portReachable,
    planned_command: SPECS.map((spec) => `node ${path.relative(process.cwd(), spec.path)}`).join(' && '),
  };

  const prereqPath = path.join(E2E_ARTIFACTS, 'prereq.json');
  fs.writeFileSync(prereqPath, JSON.stringify(prereq, null, 2) + '\n');

  section('PRE-FLIGHT');
  log(`prereq written: ${prereqPath}`);
  log(
    `cli_exists=${cliExists} port=${CONFIG.port} port_reachable=${portReachable} node=${process.version}`
  );

  // CLI missing → BLOCKED, never run the happy path.
  if (!cliExists) {
    const cause = `微信开发者工具 CLI 不存在: ${CONFIG.cliPath}`;
    const blockedPath = writeBlockedDoc(cause, prereq);
    fs.writeFileSync(ALL_LOG, renderAllTranscript(prereq, [], { blocked: cause, blockedPath }));
    failWithGuidance(cause, `blocked doc: ${blockedPath}`);
    process.exitCode = 1;
    return;
  }

  const results = [];
  for (const spec of SPECS) {
    section(`${spec.name.toUpperCase()} SPEC`);
    const child = spawnSync(process.execPath, [spec.path], {
      encoding: 'utf8',
      timeout: spec.timeout,
      maxBuffer: 32 * 1024 * 1024,
    });
    const output = `${child.stdout || ''}${child.stderr || ''}`;
    if (output.trim()) process.stdout.write(output);

    const result = {
      name: spec.name,
      path: path.relative(process.cwd(), spec.path),
      exit_code: child.status,
      error: child.error?.message || null,
      output,
    };
    results.push(result);

    // Best-effort: a failed launch can leave `cli auto` helpers holding the port.
    const cleaned = cleanupDevtools(CONFIG.projectPath);
    if (cleaned) log('cleaned up dangling devtools cli auto process(es)');
  }

  const failed = results.filter((result) => result.exit_code !== 0);
  const passed = failed.length === 0;

  // One transcript per spec (artifacts/e2e/<name>.log) so any single failure is reviewable alone.
  for (const spec of SPECS) {
    const result = results.filter((item) => item.name === spec.name)[0];
    fs.writeFileSync(
      spec.log,
      renderTranscript(spec, prereq, [`${result?.output || ''}`], result ? result.exit_code : null)
    );
  }

  fs.writeFileSync(ALL_LOG, renderAllTranscript(prereq, results, null));

  if (passed) {
    log(`PASS — all ${results.length} spec(s) green — transcript: ${ALL_LOG}`);
    process.exitCode = 0;
    return;
  }

  const first = failed[0];
  const cause =
    first.error || `${first.path} exited with code ${first.exit_code}`;

  prereq.launch_failure = {
    spec: first.name,
    exit_code: first.exit_code,
    error: first.error || null,
    output_tail: truncate(first.output, 2000),
  };
  fs.writeFileSync(prereqPath, JSON.stringify(prereq, null, 2) + '\n');

  const blockedPath = writeBlockedDoc(cause, prereq);
  fs.writeFileSync(
    ALL_LOG,
    renderAllTranscript(prereq, results, { blocked: cause, blockedPath })
  );
  failWithGuidance(cause, `full transcript: ${ALL_LOG}\nblocked doc: ${blockedPath}`);
  process.exitCode = 1;
}

function renderTranscript(spec, prereq, parts, exitCode) {
  const bar = '='.repeat(64);
  return [
    bar,
    `# E2E spec transcript: ${spec.name}`,
    `# timestamp: ${new Date().toISOString()}`,
    `# prereq: ${path.join(E2E_ARTIFACTS, 'prereq.json')}`,
    bar,
    '',
    '## prereq.json',
    JSON.stringify(prereq, null, 2),
    '',
    `## ${path.basename(spec.path)} output`,
    parts.join('\n'),
    '',
    `## exit_code: ${exitCode}`,
    bar,
    '',
  ].join('\n');
}

function renderAllTranscript(prereq, results, blocked) {
  const bar = '='.repeat(64);
  const lines = [
    bar,
    '# E2E ai-all transcript',
    `# timestamp: ${new Date().toISOString()}`,
    `# prereq: ${path.join(E2E_ARTIFACTS, 'prereq.json')}`,
    bar,
    '',
    '## prereq.json',
    JSON.stringify(prereq, null, 2),
    '',
  ];
  for (const result of results) {
    lines.push(bar);
    lines.push(`## spec: ${result.path}`);
    lines.push(`## exit_code: ${result.exit_code}`);
    lines.push(bar);
    lines.push('');
    lines.push(result.output);
    lines.push('');
  }
  if (blocked) {
    lines.push(bar);
    lines.push(`## BLOCKED: ${blocked.blocked}`);
    lines.push(`## blocked doc: ${blocked.blockedPath}`);
    lines.push(bar);
    lines.push('');
  }
  lines.push(bar);
  lines.push(`## summary: ${results.length} spec(s), ${results.filter((r) => r.exit_code === 0).length} passed, ${results.filter((r) => r.exit_code !== 0).length} failed`);
  lines.push(bar);
  lines.push('');
  return lines.join('\n');
}

main().catch((err) => {
  failWithGuidance(err?.stack || String(err));
  process.exitCode = 1;
});
