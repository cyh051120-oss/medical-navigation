# server — 本地 AI 代理（骨架）

本目录是个人医疗整理助手的**本地 AI 代理**服务端骨架。它只在本机回环地址运行，
后续任务（23–28）会在此基础上加入 LLM 适配、检索适配、编排与 demo 流程；本任务（22）
只落地：配置契约、健康检查、仅本机监听。

## 运行环境

- **Node ≥ 24**（必需）。原因：
  - 直接以 `node server/index.ts` 运行 TypeScript（Node 24 原生类型擦除，无需构建步骤）；
  - 使用全局 `fetch`（无需任何依赖）。
- **零运行时依赖**：只用 Node 内置模块（`node:http` / `node:fs` / `node:path` / `node:url`）。

## 快速开始

```bash
# 1) 复制配置示例（server/config.json 已被 .gitignore 忽略，不会提交）
cp server/config.example.json server/config.json

# 2) 启动（两种等价方式）
npm run dev:api
# 或
node server/index.ts
```

启动后应看到类似日志（只打印端口与布尔标记，**绝不打印任何 key**）：

```
[server] 监听 http://127.0.0.1:8787
[server] demo=false providerReady=false searchReady=false
[server] 仅本机可访问（127.0.0.1）；CORS 允许本地 devtools；不记录请求内容。
```

## 配置

配置文件路径固定为 `server/config.json`。结构：

```jsonc
{
  "port": 8787,                 // 监听端口（默认 8787，避开 devtools 自动化的 9420）
  "demo": false,                // 演示模式开关（原样透传到 /api/health）
  "llm": {
    "baseUrl": "",              // LLM 服务地址
    "apiKey": "",               // 留空 => providerReady=false，服务仍正常启动
    "model": ""                 // 模型名
  },
  "search": {
    "baseUrl": "",              // 检索服务地址
    "apiKey": ""                // 留空 => searchReady=false，服务仍正常启动
  },
  "authorityDomains": []        // 权威信源域名白名单（卫健委/疾控/药监局/中华医学会/三甲官网/MSD 手册等）
}
```

行为约定：

- **缺失配置** → 进程非零退出，并打印可读指引（提示复制 `config.example.json`），**绝不静默兜底**。
- **JSON 破损** → 进程非零退出，并打印包含文件路径的解析错误。
- **文件存在但 key 为空** → 服务照常运行；`/api/health` 报 `providerReady=false` / `searchReady=false`。

## 健康检查

```bash
curl -s http://127.0.0.1:8787/api/health
# => {"ok":true,"providerReady":false,"searchReady":false,"demo":false}
```

- `GET /api/health` → 200 JSON `{ ok, providerReady, searchReady, demo }`（均为布尔）。
- `OPTIONS *` → 204（CORS 预检）。
- 未知路由 → 404 JSON。

## LLM 适配器（任务 23）

`server/providers/llm.ts` 提供 OpenAI 兼容的 `/chat/completions` 适配器，零运行时依赖
（仅用 Node 内置 `fetch` / `AbortController` / `TextDecoder`）。

```ts
import { chat } from './providers/llm.ts';

const result = await chat(
  [
    { role: 'system', content: '…' },
    { role: 'user', content: '…' },
  ],
  { config: { baseUrl: '…', apiKey: '…', model: '…' } }
);
// result = { content, model, finishReason, usage, streamed }
```

- **配置驱动**：`config` 直接取自 `server/config.json` 的 `llm.{baseUrl,apiKey,model}`；
  换厂商只改 JSON、无需改代码。`loadConfig()`（`server/config.ts`）负责读取与校验契约，
  `baseUrl` 末尾斜杠会自动规整为 `POST {baseUrl}/chat/completions`。
- **流式**：`stream: true` 时解析 SSE（`data:` 帧，`data: [DONE]` 结束），逐段回调 `onDelta(delta)`；
  `apiKey` 非空时带 `Authorization: Bearer <key>`。
- **超时**：`timeoutMs`（默认 30000ms）经 `AbortController` 生效，覆盖连接与响应体读取。
- **重试**：默认 `maxRetries: 1`（最多 2 次尝试）。
  - 可重试：网络错误 / 超时 / 上游 5xx。
  - 不重试：配置错误 / 4xx / 响应格式错误 / 调用方 `signal` 取消；流式一旦已发出增量也不再重试（避免内容重复）。
- **错误归一化**：抛 `LlmError` 实例（契约 `{ code, message }`）。稳定机器码：
  `invalid_config` | `network_error` | `timeout` | `aborted` | `upstream_error` | `invalid_response`。
- **隐私**：适配器不写盘、不打印任何请求内容（messages / body / apiKey），上游错误也不回显响应体。

自检：`npx tsx scripts/check-llm.mjs`（本地 mock 上游，仅 127.0.0.1）→ `artifacts/checks/server-llm.json`；
失败路径：`npx tsx scripts/check-llm.mjs --simulate-failure` → `artifacts/qa/23-failure.txt`。

## 搜索适配器（任务 24）

`server/providers/search.ts` + `server/authorities.ts` 提供搜索结果归一化与权威域名过滤，
零运行时依赖（仅用 Node 内置 `fetch` / `AbortController`）。

```ts
import { search } from './providers/search.ts';

const { results, reason } = await search('高血压', {
  config: { baseUrl: '…', apiKey: '…' }, // 取自 server/config.json 的 search 段
  authorityDomains: undefined,           // 省略 => 用默认清单
});
// results = [{ title, url, snippet, domain, publishedAt? }]（仅权威来源）
// reason  = null（有结果）| 'no_results' | 'no_authority_match' | 'search_unavailable' | 'not_configured'
```

### 上游契约（自定义；T26 的 `server/mock-upstream.mjs` 据此实现）

| 项 | 约定 |
| --- | --- |
| 方法 / URL | `POST {baseUrl}/search`（baseUrl 末尾斜杠自动规整） |
| headers | `Content-Type: application/json`；`apiKey` 非空时带 `Authorization: Bearer <key>` |
| 请求体 | `{ "q": string, "limit": number }` |
| 2xx 响应 | `{ "results": [ { "title": string, "url": string, "snippet": string, "publishedAt"?: string } ] }`（空结果 `{ "results": [] }`） |

### 归一化与过滤

- 逐条归一化 `[{ title, url, snippet, domain, publishedAt? }]`；`domain = new URL(url).hostname.toLowerCase()`，
  `url` 不可解析的条目直接丢弃，`publishedAt` 仅在非空字符串时透传。
- 只保留命中权威域名白名单的条目（严格子域匹配）。
- 超时经 `AbortController`，默认 30000ms，可用 `timeoutMs` 覆盖。

### `reason` 语义

| reason | 含义 |
| --- | --- |
| `null` | 有权威结果 |
| `no_results` | 上游成功但 0 条（含条目全部 url 不可解析、或 query 为空——后者不发请求） |
| `no_authority_match` | 上游返回 ≥1 条可解析条目，但无一命中权威域名 |
| `search_unavailable` | 未配置之外的一切不可用：网络 / 超时 / 429 / 5xx / 响应非法（**绝不抛异常**） |
| `not_configured` | `search.baseUrl` 为空（不发请求） |

### 权威域名清单与覆盖语义

- 默认清单 `DEFAULT_AUTHORITY_DOMAINS`（卫健委 `nhc.gov.cn`、疾控 `chinacdc.cn`、药监局 `nmpa.gov.cn`、
  中华医学会 `cma.org.cn`、三甲官网示例 `pumch.cn` / `wchscu.cn`、MSD 手册 `msdmanuals.cn`）——
  均为**示例，可扩展**。
- `resolveAuthorityDomains(configDomains)`：`config.authorityDomains` **非空时完全覆盖默认**；
  空 / 未提供 / 全为无效项时回退默认。两种路径都会小写化、去重、去点/scheme/端口。
- `isAuthorityUrl(urlOrHost, domains)`：严格子域匹配（`host === d || host.endsWith('.' + d)`）；
  `evil-nhc.gov.cn` 与 `nhcgov.cn` **不会**命中 `nhc.gov.cn`。

自检：`npx tsx scripts/check-search.mjs`（本地 mock 上游，仅 127.0.0.1）→ `artifacts/checks/server-search.json`；
失败路径：`npx tsx scripts/check-search.mjs --simulate-failure` → `artifacts/qa/24-failure.txt`。

## 编排器（任务 25）

`server/orchestrator.ts` 提供双模式编排入口 `ask(request, options?)`：一次调用、JSON 进 → JSON 出，
供任务 26 的 `POST /api/ask` 薄处理器直接调用。配套模块：
`server/prompts.ts`（确定性提示 + 受控词表）、`server/validate.ts`（输出校验/白名单重建）、
`server/redflags.ts`（红标确定性规则）。

```ts
import { ask } from './orchestrator.ts';

const res = await ask(
  { mode: 'consult', messages: [{ role: 'user', content: '最近胃不舒服' }], consent: true },
  { config } // 省略则读取 server/config.json
);
```

`ask()` **绝不抛异常**：任何未预期错误都归一化为 `{ error: 'internal_error' }`。

### 请求契约

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `mode` | `'organize' \| 'consult'` | 双模式 |
| `messages` | `{role:'user'\|'assistant'\|'system', content:string}[]` | 非空；`content` 必须为字符串 |
| `profileSummary` | `string?` | **脱敏档案摘要**（客户端脱敏），仅供语境 |
| `consent` | `true` | 必须字面 `true`；否则 `consent_required` |
| `recordExcerpts` | `string[]?` | 用户确认后的记录摘录，**合计 ≤2K 字符**（超出按序截断） |
| `memories` | `string[]?` | 启用的记忆条目文本，**≤20 条且合计 ≤1K 字符**；语义=偏好，非医学事实 |

`recordExcerpts` / `memories` 缺省视为空数组；`profileSummary` 缺省视为无。类型非法的可选字段 → `invalid_request`。

### 响应契约（成功）

`organize`（资料整理，无医疗判断；**不含** `directions/suggestedDepartments/citations/suggestions/disclaimer`）：

```jsonc
{ "points": ["…"], "extracted": { "symptoms": [], "medications": [], "allergies": [], "history": [], "exams": [] },
  "unknowns": ["…"], "questions": ["…"] }
```

`consult`（问诊建议）：

```jsonc
{
  "directions": [ { "text": "≤20 字", "citation": { "title": "…", "url": "…", "domain": "…" } } ],
  "suggestedDepartments": ["消化内科"],
  "citations": [ { "title": "…", "url": "…", "domain": "…" } ],
  "suggestions": [ { "text": "≤40 字", "citation": { "…": "…" } } ],
  "unknowns": ["…"], "questions": ["…"],
  "disclaimer": "（固定非诊断声明，恒存在）"
}
```

- `directions`：每条 `text` **≤20 字**且**必须带引用**。
- `suggestions`：仅归纳权威来源的通用生活/照护提示，每条 **≤40 字**且**必须带引用**；
  始终以数组返回（可为空）。
- `citations`：由解析成功的引用去重生成（**不信任模型自带的 citations 字段**），
  每项 `title/url/domain` 均取自已获取的搜索结果。
- `disclaimer`：固定常量 `CONSULT_DISCLAIMER`，恒随 consult 结果返回。

### 响应契约（护栏与错误）

红标命中（模式无关的固定形状；不含任何方向/科室/引用，也不回显输入）：

```jsonc
{ "redFlag": true, "safetyNotice": "（固定安全提示句）", "disclaimer": "（固定非诊断声明）" }
```

错误对象（`error` 为稳定机器码）：

| `error` | 触发 | 额外字段 |
| --- | --- | --- |
| `consent_required` | `consent !== true` | — |
| `invalid_mode` | `mode` 非 organize/consult | — |
| `invalid_request` | `messages`/可选字段类型非法 | — |
| `provider_not_configured` | `llm.baseUrl` 或 `llm.model` 为空（零网络） | — |
| `upstream_error` | LLM 调用失败（网络/超时/4xx/5xx/响应非法）；附归一化 code | — |
| `unsafe_output` | 解析失败或输出校验失败 | `fallback: 'organize'` |
| `internal_error` | 未预期异常兜底（`ask()` 永不抛） | — |

`unsafe_output` **不回显任何模型文本**。**「保留原文」解读**：原始用户输入始终留在客户端
（本编排器不落盘、不回显）；`fallback:'organize'` 指示客户端降级到整理模式，**不自动重跑**。

### 安全护栏（`server/redflags.ts`）

- `RED_FLAG_TERMS`：计划 8 条（胸痛 / 胸闷伴大汗 / 呼吸困难 / 意识障碍 / 大出血 / 中风征象 / 晕厥 / 剧烈头痛）
  \+ 同精神补充（窒息 / 抽搐 / 咯血 / 吐血 / 便血 / 言语不清 / 一侧无力）。
- 扫描范围（**任何上游调用之前**）：窗口内 `user` 角色消息 + `recordExcerpts` + `profileSummary`。
  **`memories` 不扫描**（偏好语义，非医学事实）。
- 命中即短路：**零 LLM、零搜索调用**，返回固定 `SAFETY_NOTICE`
  （无科室、无方向、无病情名、无引用，且不含任何红标词本身）。

### 输出校验（`server/validate.ts`）

- **schema 白名单重建**：只有已知字段进入结果；模型的任何额外字段（如 `narrative` 自由文本病情叙述）一律丢弃，永不回传。
- **受限词**：通用 `确诊/诊断/处方/疗效/剂量/治愈/拨打/120` 在 points、direction、suggestion、unknowns、questions 中出现即失败；
  `direction.text` 额外禁 `医生/医院/挂号/大夫/主任/专家`（禁具体医生/医院）；`suggestion.text` 额外禁
  `服用/口服/停药/加量/减量/换药/毫克/mg/遵医嘱`（禁个性化用药指令）。
  `unknowns`/`questions` 允许出现「医生」（提问对象）。
- **长度**：`direction.text ≤20`、`suggestion.text ≤40`。
- **引用**：`citation` 必须与**本次请求已获取的搜索结果**某一 `url` **去空白后完全相等**，且域名通过权威白名单；
  解析出的 `title/url/domain` 取自已获取来源，不信任模型。匹配规则：精确 URL（trim 后）相等。
- **受控科室**：`suggestedDepartments` 每项必须在 `CONTROLLED_DEPARTMENTS` 内，否则失败。

### 上下文与上游策略

- 会话窗口：保留最近 **≤20 条**消息，再从最早丢弃直到合计 **≤8K 字符**；单条超大内容硬截断到 8K。
  该 8K 上限作用于会话窗口（不含固定 system 提示）。
- `max_tokens`：默认 `LIMITS.defaultMaxTokens = 1024`，可通过 `options.maxTokens` 覆盖。
- 搜索调用：`organize` **0 次**；`consult` **至多 1 次**，关键词取最近一条 `user` 消息（压空白、**≤200 字**）。
  搜索不可用时 `consult` 仍正常回答，但 `citations` 必然为空；任何引用失败都会降级（`unsafe_output`）。
- LLM 调用：**非流式、严格 JSON**（容忍可选 ` \`\`\`json ` 围栏）；解析失败 → `unsafe_output`。

自检：`npx tsx scripts/check-ask.mjs`（本地 mock LLM + mock 搜索，仅 127.0.0.1）→ `artifacts/checks/server-ask.json`；
失败路径：`npx tsx scripts/check-ask.mjs --simulate-failure` → `artifacts/qa/25-failure.txt`。

## 演示/模拟模式 + `POST /api/ask`（任务 26）

`server/index.ts` 已接线 `POST /api/ask`（薄处理器）；`demo=true` 时用确定性 fixtures 覆盖真实上游。

### 请求 / 响应与状态码

- `POST /api/ask`，`Content-Type: application/json`；请求体即上文的 T25 编排器请求契约。
- 请求体上限 **64KB**；超限 → `413 {error:'payload_too_large'}`。
- 非法 JSON → `400 {error:'invalid_request'}`。
- 非 POST 方法 → `405 {error:'method_not_allowed'}`；未知路由 → `404`（不变）；`OPTIONS` → `204`。
- **业务结果一律 HTTP 200**（含错误信封与红标）：成功返回 organize/consult 结构；
  失败返回 `{error, message}`；红标返回 `{redFlag:true, safetyNotice, disclaimer}`。

### demo 确定性映射（`server/demo-fixtures.json`）

`demo=true` 时**零网络、始终**（即使配置了 key）；判定顺序（文档即契约）：

1. `consent !== true` → `{error:'consent_required'}`；`mode` 非法 → `{error:'invalid_mode'}`；
   `messages` 非数组 / 项非对象 → `{error:'invalid_request'}`（均零网络）。
2. 本地 `detectRedFlag` 扫描请求 `user` 消息命中 → `redflag` fixture（固定安全句 + 免责）。
3. `mode='organize'`：存在任一非空 user 文本 → `organize` fixture；否则 → `organizeMinimal` fixture（全空数组边界）。
4. `mode='consult'` → `consult.response` fixture（`directions`/`suggestions` 带引用、受控科室、含免责）。

fixtures 结构：`{ redflag, organize, organizeMinimal, consult:{sources,response}, extractMemory:{candidates} }`。
`consult.response` 的 citation 落在 `consult.sources` 且通过权威域名校验；`check-demo` 用
`validateOrganizeOutput` / `validateConsultOutput` 自检并断言与存储形状逐字段一致。
`extractMemory.candidates` 供任务 43 的记忆提炼使用（偏好语义、≤3 条、每条 ≤60 字、去重）。

### `demo=false`

`await ask(body, { config })`：真实调用仅在 `demo=false` 且 `llm.baseUrl` / `llm.model` 非空时可能发生；
未配置时 `ask()` 在**任何网络之前**返回 `{error:'provider_not_configured'}`（零外呼）。

### 配置覆盖（测试专用）：`MHP_CONFIG_PATH`

`index.ts` 以 `loadConfig(process.env.MHP_CONFIG_PATH)` 读取配置：环境变量存在时读取该路径，
否则回退 `server/config.json`。测试/检查脚本据此指向 `os.tmpdir()` 下的临时配置，
**绝不改写仓库 `server/config.json`**。

### mock 上游：`server/mock-upstream.mjs`（供 E2E / 检查脚本）

独立、零依赖、仅 `127.0.0.1`；同一端口同时实现两个冻结契约：

| 端点 | 契约 |
| --- | --- |
| `POST /chat/completions` | OpenAI 兼容；非流式 JSON；`stream:true` 时回 SSE（`data:[DONE]` 结束） |
| `POST /search` | T24 契约 `{q,limit}` → `{results:[{title,url,snippet,publishedAt?}]}`（固定返回权威来源） |

- 端口：命令行首个数字参数或 `MOCK_PORT` / `PORT`（默认 `0`，OS 分配临时端口）；启动打印实际 base URL；
  收到 SIGINT/SIGTERM 优雅退出。
- LLM 内容确定性选择：messages 含「记忆提炼」（或同时含「偏好」「提炼」）→ extract-memory 候选；
  含「问诊建议」→ consult 形状；其余 → organize 形状。`MOCK_ADVERSARIAL=1` 时 consult 改回对抗样例
  （含禁令词，供校验器拦截测试）。
- 不打印/落盘任何请求内容。config 的 `llm.baseUrl` 与 `search.baseUrl` 都指向该 base URL 即可。

```bash
node server/mock-upstream.mjs 8788
# [mock-upstream] listening on http://127.0.0.1:8788
```

### 自检与证据

```bash
npx tsx scripts/check-demo.mjs                     # happy → artifacts/server/demo-determinism.txt
npx tsx scripts/check-demo.mjs --simulate-failure  # demo=false+空 key → artifacts/qa/26-failure.txt, exit 1
```

happy 路径用系统 `curl` 对 organize / consult / redflag / minimal（`/api/ask`）与 extract（`/api/extract-memory`）
各 POST 两次，断言原始响应体**逐字节一致**，并断言计数 mock 收到 **0** 次请求（证明 demo 优先于已配置 key）；
失败路径断言 `provider_not_configured` 且零外呼。

## 记忆提炼 / `POST /api/extract-memory`（任务 43）

`server/extract-memory.ts` 提供记忆提炼入口 `extractMemory(request, options?)`：一次调用、JSON 进 → JSON 出，
供 `server/index.ts` 的 `POST /api/extract-memory` 薄处理器直接调用。

```ts
import { extractMemory } from './extract-memory.ts';

const res = await extractMemory(
  { messages: [{ role: 'user', content: '我一般晚上十点前就睡了' }], consent: true, maxItems: 3 },
  { config } // 省略则读取 server/config.json
);
// 成功 => { candidates: [{ text }] }（无 reason）；降级 => { candidates: [], reason }
```

`extractMemory()` **绝不抛异常**：任何未预期错误都归一化为 `{ candidates: [], reason: 'internal_error' }`。

### 请求契约

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `messages` | `{role:'user'\|'assistant'\|'system', content:string}[]` | 非空；**仅最近一轮**，合计 **≤2K 字符**（超出按序丢弃最早，单条超大硬截断） |
| `consent` | `true` | 必须字面 `true`；否则 `consent_required`（零上游） |
| `maxItems` | `number?` | 候选条数上限；缺省 3，超出夹到 **≤3**；显式非法（非正数）→ `invalid_request` |

### 响应契约

- 成功：`{ "candidates": [ { "text": "…" } ] }`（**无** `reason` 字段）。`text` 已去空白。
- 降级：`{ "candidates": [], "reason": "…" }`（`reason` 为稳定机器码）。

| `reason` | 触发 | 上游调用 |
| --- | --- | --- |
| `consent_required` | `consent !== true` | 零 |
| `invalid_request` | `messages` / `maxItems` 非法 | 零 |
| `provider_not_configured` | `llm.baseUrl` 或 `llm.model` 为空 | 零网络 |
| `upstream_error` | 超时 / 非 2xx / JSON 非法 / 缺 `candidates` 字段 | — |
| `internal_error` | 未预期异常兜底（`extractMemory()` 永不抛） | — |

解析成功但全部条目非法 → `{ candidates: [] }`（**无** `reason`，属「成功但无候选」）。

### 提炼范围与逐条校验

- **仅提炼用户偏好/习惯**：作息、饮食、运动、沟通偏好；只取用户自己明确表达的内容，不推断、不编造。
- **禁止提炼任何医疗内容**：症状 / 诊断 / 用药 / 药物 / 疾病 / 医疗结论，以及具体医生 / 医院。
- 逐条校验（**违规条目丢弃，合法条目保留**，不整单失败）：`text` 必须为字符串、去空白非空、**≤60 字**、
  不含受限词（复用 `server/validate.ts` 的 `DECISION_TERMS` / `REFERRAL_TERMS` / `SELF_MEDICATION_TERMS`，
  并叠加记忆提炼专属医疗禁词 `症状/疾病/用药/药物`）；随后**首现去重**、截断到 `maxItems`。
- 提示词 `buildExtractSystemPrompt()`（`server/prompts.ts`）含关键词「记忆提炼」，且不含「问诊建议」——
  与 `server/mock-upstream.mjs` 的确定性内容选择锚点一致。
- **隐私**：不写盘、不打印任何请求/响应内容。

### HTTP 语义（与 `/api/ask` 一致）

- 请求体上限 **64KB** → `413 {error:'payload_too_large'}`；非法 JSON → `400 {error:'invalid_request'}`；
  非 POST → `405 {error:'method_not_allowed'}`；`OPTIONS` → `204`；未知路由 → `404`。
- **业务结果一律 HTTP 200**（含降级信封）。
- `MHP_CONFIG_PATH` 覆盖（测试专用）同 `/api/ask`。
- `demo=true`：零网络、始终返回 `demo-fixtures.json` 的 `extractMemory.candidates`（先做 consent/messages/maxItems
  守卫；有 `maxItems` 时按 ≤3 夹取后切片）；两次相同请求逐字节一致。

自检：`npx tsx scripts/check-extract.mjs`（本地 mock LLM，仅 127.0.0.1）→ `artifacts/checks/server-extract.json`；
失败路径：`npx tsx scripts/check-extract.mjs --simulate-failure` → `artifacts/qa/43-failure.txt`。

## 安全与隐私

- **仅监听 `127.0.0.1`**：不写 `0.0.0.0`，不省略 host；外网无法直接访问。
- **不记录请求内容**：本骨架不落盘任何请求体 / 提示词 / 患者信息。
- **凭据不入库**：`server/config.json` 已被 `.gitignore` 忽略；仓库内只保留占位示例。
- **CORS**：允许本地 devtools 调用（回显 `Origin`，或回退 `*`；允许 `GET/POST/OPTIONS` + `Content-Type`）。

## 校验（零错误门禁）

```bash
# 仅服务端
npx tsc -p server/tsconfig.json --noEmit

# 全量（小程序 + 服务端）
npm run typecheck

# 端到端骨架检查（会临时拉起服务并轮询 /api/health，产出 artifacts/server/health.json）
# 并运行 LLM 适配器检查（本地 mock 上游，产出 artifacts/checks/server-llm.json）
# 以及搜索适配器检查（本地 mock 上游，产出 artifacts/checks/server-search.json）
# 以及编排器检查（本地 mock LLM + mock 搜索，产出 artifacts/checks/server-ask.json）
# 以及记忆提炼检查（本地 mock LLM，产出 artifacts/checks/server-extract.json）
# 以及演示模式确定性检查（spawn 服务 + 计数 mock，产出 artifacts/server/demo-determinism.txt）
# 以及检查矩阵聚合（引用上述 artifact + artifacts/e2e/redaction.json，产出 artifacts/checks/server-all.json）
npm run test:server
```

检查矩阵（任务 27）：`npx tsx scripts/check-matrix.mjs` 不新增用例，只清点本链各 harness 的
artifact（存在 + 零失败 + 时间戳新鲜）并把验收项 ①–⑪ 映射到既有用例；失败路径
`npx tsx scripts/check-matrix.mjs --simulate-failure`（LLM 不可达 / LLM 500 / 搜索不可达 / extract 上游 500）
→ 真实降级记录 `artifacts/qa/27-failure.txt`，刻意 exit 1。

## 目录约定（服务端）

- 服务端相对导入写**显式 `.ts` 扩展名**（Node 直跑要求），例如 `import { x } from './config.ts'`。
- 仅可擦除语法（无 `enum` / `namespace` / 参数属性）。
- 仅类型导入使用 `import type`。
