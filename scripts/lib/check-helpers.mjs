// scripts/lib/check-helpers.mjs
// Shared zero-dependency helpers for the scripts/check-*.mjs harnesses.
//
// LEAF module: imports only node builtins; nothing here imports from ./check-*.
// Each helper is the single canonical definition for the scripts/ tree. The E2E
// automator tree (tests/e2e/helpers.mjs) keeps its own copies on purpose — a
// single repo-wide definition would couple pure node check scripts to the E2E
// stack (miniprogram-automator + devtools-background). One definition per module
// tree, not per repository.
//
// Closure-bound helpers are exposed as make* factories so call sites stay
// unchanged: `const record = makeRecord(cases);` at the old definition site.

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import net from 'node:net';

// ---------------------------------------------------------------------------
// wx shim helpers (scripts install globalThis.wx before importing modules under test)
// ---------------------------------------------------------------------------

// Map-backed wx shim (narrow subset the storage/records/memory modules use).
export function createWxShim() {
  const store = new Map();
  return {
    _store: store,
    setStorageSync(key, value) {
      store.set(key, value);
    },
    getStorageSync(key) {
      return store.has(key) ? store.get(key) : '';
    },
    removeStorageSync(key) {
      store.delete(key);
    },
    getStorageInfoSync() {
      return { keys: Array.from(store.keys()) };
    },
  };
}

export function resetStore() {
  globalThis.wx._store.clear();
}

export function keysWithPrefix(prefix) {
  return globalThis.wx.getStorageInfoSync().keys.filter((key) => key.indexOf(prefix) === 0);
}

export function countPrefix(prefix) {
  return keysWithPrefix(prefix).length;
}

// Closure-bound: bind the module's NS prefix; call site stays rawList(entityKey).
export function makeRawList(ns) {
  return function rawList(entityKey) {
    const val = globalThis.wx.getStorageSync(`${ns}${entityKey}`);
    return Array.isArray(val) ? val : [];
  };
}

// ---------------------------------------------------------------------------
// Small pure utilities
// ---------------------------------------------------------------------------

export const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export function deepEq(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------------------
// Local HTTP mock plumbing (bound to 127.0.0.1 on an OS-assigned port)
// ---------------------------------------------------------------------------

export function listen(server, name, state) {
  return new Promise((resolveP) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolveP({
        name,
        state,
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise((r) => {
            if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
            server.close(() => r());
          }),
      });
    });
  });
}

export function readJsonBody(req, onBody) {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    onBody(raw, parsed);
  });
}

function llmPayload(content) {
  return {
    id: 'chatcmpl-mock',
    object: 'chat.completion',
    model: 'mock-model',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

export function startLlmMock(name) {
  const state = { mode: 'ok', content: '{}', requests: [] };
  const server = createServer((req, res) => {
    readJsonBody(req, (raw, parsed) => {
      state.requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: parsed,
        raw_length: raw.length,
      });
      const json = (status, payload) => {
        if (res.writableEnded) return;
        res.statusCode = status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(payload));
      };
      if (state.mode === 'always-500') {
        json(500, { error: { message: 'mock 500' } });
        return;
      }
      if (state.mode === 'slow') {
        const t = setTimeout(() => json(200, llmPayload(state.content)), 800);
        t.unref();
        return;
      }
      json(200, llmPayload(state.content));
    });
  });
  return listen(server, name, state);
}

export function conversationMessages(body) {
  if (body === null || !Array.isArray(body.messages)) return [];
  return body.messages.filter((m) => m.role !== 'system');
}

export function systemContent(body) {
  if (body === null || !Array.isArray(body.messages)) return '';
  const sys = body.messages.find((m) => m.role === 'system');
  return sys === undefined ? '' : sys.content;
}

// ---------------------------------------------------------------------------
// Closure-bound helpers (const X = makeX(bindings); keeps call sites unchanged)
// ---------------------------------------------------------------------------

// Miniprogram tsc gate (command + raw exit code captured).
export function makeRunTypecheck(root) {
  return function runTypecheck() {
    const command = 'npx tsc -p hospital-ai-miniapp/tsconfig.json --noEmit';
    const res = spawnSync('npx', ['tsc', '-p', 'hospital-ai-miniapp/tsconfig.json', '--noEmit'], {
      cwd: root,
      encoding: 'utf8',
      // Windows: `npx` is `npx.cmd`; without a shell spawnSync cannot resolve it (status=null).
      shell: process.platform === 'win32',
    });
    const output = `${res.stdout || ''}${res.stderr || ''}`.trim();
    const tail = output.length > 2000 ? output.slice(-2000) : output;
    return { command, exit: res.status, output_tail: tail };
  };
}

// Case recorder, `details` schema (storage/records/memory harnesses).
export function makeRecord(cases) {
  return function record(name, pass, details) {
    cases.push({ name, pass, details });
  };
}

// Case recorder, boolean-coerced `detail` schema (ask/extract/llm/search harnesses).
export function makeDetailRecord(cases) {
  return function record(name, pass, detail) {
    cases.push({ name, pass: pass === true, detail });
  };
}

// Bind the LLM mock; call site stays lastLlmBody().
export function makeLastLlmBody(llm) {
  return function lastLlmBody() {
    const reqs = llm.state.requests;
    return reqs.length === 0 ? null : reqs[reqs.length - 1].body;
  };
}

// Bind repo root; call site stays spawnServer(configPath).
export function makeSpawnServer(root) {
  return function spawnServer(configPath) {
    const child = spawn('node', ['server/index.ts'], {
      cwd: root,
      env: { ...process.env, MHP_CONFIG_PATH: configPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout.on('data', (c) => {
      log += c.toString();
    });
    child.stderr.on('data', (c) => {
      log += c.toString();
    });
    return { child, log: () => log };
  };
}

// ---------------------------------------------------------------------------
// Server lifecycle (spawn node server/index.ts, poll /api/health)
// ---------------------------------------------------------------------------

export function getFreePort() {
  return new Promise((resolvePort, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });
}

export async function waitForHealth(port, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return { status: res.status, response: await res.json() };
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await delay(250);
  }
  return { status: null, response: null, error: lastError };
}

export async function stopServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const deadline = Date.now() + 3000;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
    await delay(100);
  }
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}
