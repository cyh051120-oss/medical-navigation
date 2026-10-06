// E2E entrypoint: pre-flight prereq capture, then run the E2E spec matrix.
// Exit 0 iff every spec passes. Never claims pass without a real assert.
//
// Specs:
//   - bootstrap.spec.mjs  (T5 harness smoke) -> artifacts/e2e/bootstrap.log
//   - ai.spec.mjs         (T33 AI matrix; mock upstream + real server)
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

const SPECS = [
  {
    name: 'bootstrap',
    path: path.join(__dirname, 'bootstrap.spec.mjs'),
    log: path.join(E2E_ARTIFACTS, 'bootstrap.log'),
    timeout: CONFIG.timeout + 120000,
  },
  {
    name: 'ai',
    path: path.join(__dirname, 'ai.spec.mjs'),
    log: null,
    timeout: Math.max(CONFIG.timeout + 120000, 600000),
  },
];

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

  // Preserve the bootstrap transcript artifact for its own spec.
  for (const spec of SPECS) {
    if (spec.log !== null) {
      const result = results.filter((item) => item.name === spec.name)[0];
      fs.writeFileSync(
        spec.log,
        renderTranscript(prereq, [`${result?.output || ''}`], result ? result.exit_code : null)
      );
    }
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

function renderTranscript(prereq, parts, exitCode) {
  const bar = '='.repeat(64);
  return [
    bar,
    '# E2E bootstrap transcript',
    `# timestamp: ${new Date().toISOString()}`,
    `# prereq: ${path.join(E2E_ARTIFACTS, 'prereq.json')}`,
    bar,
    '',
    '## prereq.json',
    JSON.stringify(prereq, null, 2),
    '',
    '## bootstrap.spec.mjs output',
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
