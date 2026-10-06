#!/usr/bin/env node
// scripts/dev-api-local.mjs — cross-platform local dev launcher (replaces dev-api-local.ps1).
//
// What it does:
//   1) ensures a local server config exists: copies server/config.example.json -> server/config.json
//      when the target is missing (the example ships an EMPTY apiKey, so /api/health stays
//      providerReady=false until you fill a real key in). Honors MHP_CONFIG_PATH as the target.
//   2) starts `node server/index.ts` with MHP_CONFIG_PATH pointing at that config.
//
// Why: the old PowerShell launcher hard-coded `powershell` and a Windows-only external path, so
// `npm run dev:api:local` failed 100% on macOS/Linux. This runs everywhere Node runs.
//
// Usage: npm run dev:api:local
//   Optional: MHP_CONFIG_PATH=/path/to/config.json npm run dev:api:local

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const examplePath = resolve(root, 'server', 'config.example.json');
const configPath = process.env.MHP_CONFIG_PATH
  ? resolve(process.env.MHP_CONFIG_PATH)
  : resolve(root, 'server', 'config.json');

if (!existsSync(configPath)) {
  if (!existsSync(examplePath)) {
    console.error(`[dev-api-local] example config not found: ${examplePath}`);
    process.exit(1);
  }
  mkdirSync(dirname(configPath), { recursive: true });
  copyFileSync(examplePath, configPath);
  console.log(`[dev-api-local] created ${configPath} from config.example.json (apiKey empty)`);
}

console.log(`[dev-api-local] config: ${configPath}`);
console.log('[dev-api-local] starting: node server/index.ts');

const child = spawn(process.execPath, ['server/index.ts'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, MHP_CONFIG_PATH: configPath },
});

child.on('error', (err) => {
  console.error(`[dev-api-local] failed to start server: ${err.message}`);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`[dev-api-local] server terminated by signal ${signal}`);
    process.exit(1);
  }
  process.exit(code === null ? 1 : code);
});
