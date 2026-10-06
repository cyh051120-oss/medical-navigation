#!/usr/bin/env node
// server/mock-upstream.mjs
// 独立、零依赖的 mock 上游服务（任务 26），供 E2E（任务 33）与检查脚本本地替换真实上游使用。
//
// 提供两个端点（只绑定 127.0.0.1）：
//   POST /chat/completions  —— OpenAI 兼容；非流式 JSON。
//   POST /search            —— 任务 24 冻结的自定义搜索契约 { results: [{title,url,snippet,publishedAt?}] }。
// 两个端点同一端口、同一 baseUrl；config 的 llm.baseUrl 与 search.baseUrl 都可指向它。
//
// 确定性内容选择（LLM）——按请求 messages 中的模式关键词，互斥、可复现：
//   1) 命中「连续追问」（interview system prompt）→ 问诊引导的单个追问 JSON
//   2) 命中「记忆提炼」或（同时含「偏好」与「提炼」）→ extract-memory 候选 JSON
//   3) 命中「问诊建议」（orchestrator consult system prompt）→ consult 形状 JSON
//   4) 其余（含「资料整理」或无法判定）→ organize 形状 JSON
// 环境变量 MOCK_ADVERSARIAL=1 时，consult 分支改回一条含禁令词的对抗样例
// （确诊 / 剂量），用于验证校验器拦截；默认绝不返回。
//
// 端口：命令行首个数字参数或 MOCK_PORT / PORT 环境变量；默认 0（OS 分配临时端口）。
// 启动时打印实际 base URL。收到 SIGINT/SIGTERM 优雅退出。
//
// 隐私：绝不打印 / 落盘任何请求内容。

import { createServer } from 'node:http';

// ---------------------------------------------------------------------------
// 固化来源（与 demo fixtures 一致的权威域名，默认权威清单即可通过）
// ---------------------------------------------------------------------------

const SRC_NHC = {
  title: '国家卫生健康委员会：就医准备与信息整理提示',
  url: 'https://nhc.gov.cn/health/mock-1',
  snippet: 'mock 来源摘要（非真实页面）。',
};
const SRC_CDC = {
  title: '中国疾病预防控制中心：日常健康生活方式提示',
  url: 'https://www.chinacdc.cn/health/mock-2',
  snippet: 'mock 来源摘要（非真实页面）。',
};

const SEARCH_RESULTS = [
  { ...SRC_NHC, publishedAt: '2024-01-01' },
  { ...SRC_CDC },
];

// ---------------------------------------------------------------------------
// 确定性 LLM 输出
// ---------------------------------------------------------------------------

const ORGANIZE_CONTENT = JSON.stringify({
  points: ['近一周出现头痛', '入睡较晚、睡眠欠佳'],
  extracted: {
    symptoms: ['头痛'],
    medications: [],
    allergies: [],
    history: [],
    exams: [],
  },
  unknowns: ['头痛诱因与持续时间未说明'],
  questions: ['头痛从何时开始、多久一次？'],
});

const CONSULT_CONTENT = JSON.stringify({
  directions: [
    { text: '注意休息与规律作息', citation: SRC_NHC.url },
    { text: '保持清淡均衡饮食', citation: SRC_CDC.url },
  ],
  suggestedDepartments: ['全科'],
  suggestions: [{ text: '作息规律、避免熬夜', citation: SRC_NHC.url }],
  unknowns: ['症状出现时间与频率'],
  questions: ['需要向医生了解哪些检查或注意事项？'],
});

// 对抗样例（仅 MOCK_ADVERSARIAL=1 时启用）：含确认性词与用药词，预期被校验器拦截。
const ADVERSARIAL_CONSULT_CONTENT = JSON.stringify({
  directions: [{ text: '你已确诊流感', citation: SRC_NHC.url }],
  suggestedDepartments: ['全科'],
  suggestions: [{ text: '按说明书剂量使用', citation: SRC_NHC.url }],
  unknowns: [],
  questions: [],
});

const EXTRACT_MEMORY_CONTENT = JSON.stringify({
  candidates: [{ text: '偏好晚上十点前入睡' }],
});

/** 问诊引导（连续追问）：固定返回下一个待补齐的追问。 */
const INTERVIEW_CONTENT = JSON.stringify({
  status: 'ask',
  question: { text: '这个情况大概持续多久了？', slot: 'duration' },
});

const ADVERSARIAL = process.env.MOCK_ADVERSARIAL === '1';

function pickContent(messages) {
  const text = Array.isArray(messages)
    ? messages
        .map((m) => (m && typeof m.content === 'string' ? m.content : ''))
        .join('\n')
    : '';
  if (text.includes('连续追问')) {
    return INTERVIEW_CONTENT;
  }
  if (text.includes('记忆提炼') || (text.includes('偏好') && text.includes('提炼'))) {
    return EXTRACT_MEMORY_CONTENT;
  }
  if (text.includes('问诊建议')) {
    return ADVERSARIAL ? ADVERSARIAL_CONSULT_CONTENT : CONSULT_CONTENT;
  }
  return ORGANIZE_CONTENT;
}

// ---------------------------------------------------------------------------
// HTTP 工具
// ---------------------------------------------------------------------------

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}

function parseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function sendJson(res, status, payload) {
  if (res.writableEnded) return;
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function chatPayload(content) {
  return {
    id: 'chatcmpl-mock',
    object: 'chat.completion',
    created: 0,
    model: 'mock-model',
    choices: [
      { index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

function resolvePort() {
  const arg = process.argv.slice(2).find((a) => /^\d+$/.test(a));
  if (arg !== undefined) return Number(arg);
  for (const key of ['MOCK_PORT', 'PORT']) {
    const value = process.env[key];
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  }
  return 0;
}

const server = createServer((req, res) => {
  const url = req.url ?? '/';
  const path = url.split('?')[0];

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }

  readBody(req).then((raw) => {
    const body = parseJson(raw);

    if (path === '/chat/completions') {
      const messages = body && Array.isArray(body.messages) ? body.messages : [];
      const content = pickContent(messages);
      sendJson(res, 200, chatPayload(content));
      return;
    }

    if (path === '/search') {
      // 契约：{ q, limit } → { results: [...] }；固定返回权威来源。
      sendJson(res, 200, { results: SEARCH_RESULTS });
      return;
    }

    sendJson(res, 404, { error: 'not_found', path });
  });
});

server.listen(resolvePort(), '127.0.0.1', () => {
  const address = server.address();
  const port = address !== null && typeof address === 'object' ? address.port : 0;
  console.log(`[mock-upstream] listening on http://127.0.0.1:${port}`);
  console.log(
    `[mock-upstream] endpoints: POST /chat/completions, POST /search; adversarial=${ADVERSARIAL}`
  );
});

function shutdown(signal) {
  console.log(`[mock-upstream] received ${signal}, closing…`);
  const force = setTimeout(() => process.exit(1), 3000);
  force.unref();
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  server.close(() => {
    clearTimeout(force);
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
