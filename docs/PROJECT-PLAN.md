# 「就医准备助手」项目开发计划书

> 软件著作权登记用。软件全称：**就医准备助手**；版本：**V1.0**。

本计划书描述「就医准备助手」V1.0 的建设背景、需求、总体与详细设计、开发阶段划分、
测试与验收方案及风险对策。文中所有功能与模块均对应仓库当前实现，并给出可核对的代码锚点；
未在代码中实现的能力不写入本文件。

---

## 1 项目概述

### 1.1 背景

看病前的那段时间常常手忙脚乱：想说的症状记不全，化验单上的字看不懂，想问医生的问题一转身就忘。
这些信息往往散落在手机备忘录、纸质单据和记忆里，就诊时难以完整、有条理地表达。

### 1.2 建设目标

做一个只在自己手机上运行的小工具，把「看诊前要准备的事」理顺：

1. 随时记下症状、资料与想问的问题，全部保存在本机；
2. 出门前把散落的信息收拢成一份条理清楚、可导出的就医摘要；
3. 需要时借助自建的本地 AI 代理，把口语化描述整理成要点，或梳理可留意的健康方向、
   日常建议与值得向医生确认的问题。

### 1.3 产品定位与边界

- 本软件是**个人健康信息的记录与整理工具**，**不是医疗器械**，不提供医疗判断，
  不输出确诊、处方、用药或疗效类结论。
- AI 生成内容仅用于帮助用户把信息说清楚，不能替代执业医务人员的当面判断，
  也不作为任何医疗决定的依据。
- 系统在**任何上游调用之前**都会做危重信号（红标）确定性扫描；命中即短路为固定安全提示，
  不调用模型与检索。

### 1.4 软件形态

由两个组件组成，**都只在本机运行**：

| 组件 | 目录 | 说明 |
| --- | --- | --- |
| 微信小程序 | `hospital-ai-miniapp/` | 记录、整理与展示界面；数据默认只存本机 |
| 本地 AI 代理 | `server/` | 可选。小程序需要 AI 能力时，经它转发到用户自行配置的模型与检索服务 |

---

## 2 需求分析

### 2.1 用户与场景

- **用户**：需要反复就诊、需要向医生说明长期情况的普通人（含视力较弱、需要大字/高对比的长者）。
- **典型场景**：就诊前整理症状与资料；就诊时按摘要表达；就诊后补充记录与待问问题。

### 2.2 功能需求

| 编号 | 功能 | 说明 | 代码锚点 |
| --- | --- | --- | --- |
| F-01 | 工作台总览 | 按本机时间问候并给出一句话产品定位，附本机日期；展示档案准备总览（完整度 + 进度条）与症状/资料/待问计数；合并展示最近记录与使用提示（功能入口改由全局左侧导航栏承载） | `hospital-ai-miniapp/pages/home/home.ts: refresh / greetingFor / todayLabelFor`；`hospital-ai-miniapp/components/app-sidebar/app-sidebar.ts` |
| F-02 | 个人档案（单例） | 称呼、年龄段、性别（可选）、过敏、长期用药、既往情况 | `hospital-ai-miniapp/shared/services/records.ts: profile` |
| F-03 | 症状时间线 | 按发生时间记录症状原话、持续时长、影响、标签与 1 个附件 | `hospital-ai-miniapp/pages/symptoms/symptoms.ts: onSave` |
| F-04 | 资料摘录 | 记录资料名称、摘录、来源日期、备注与 1 个附件 | `hospital-ai-miniapp/pages/notes/notes.ts: onSave` |
| F-05 | 待问清单 | 记录问题与分组、勾选完成、一键多行导入并按文本去重 | `hospital-ai-miniapp/shared/services/records.ts: questions / importMany` |
| F-06 | 就医摘要 | 选择记录后生成可编辑摘要；症状原话逐字保留 | `hospital-ai-miniapp/shared/services/brief.ts: build` |
| F-07 | 摘要图片导出 | 经 2D canvas 生成 750×1334 图片，可保存到相册或分享 | `hospital-ai-miniapp/pages/brief/brief.ts: onExportImage` |
| F-08 | AI 资料整理模式 | 把一段口语化原话整理成要点、提取线索、待补充项与可问问题 | `hospital-ai-miniapp/pages/ai/ai.ts: organizeBlocks` |
| F-09 | AI 问诊建议模式 | 结合带入资料给出健康方向、建议就诊科室、来源链接、日常建议与可问问题 | `hospital-ai-miniapp/shared/services/aiRender.ts: consultBlocks` |
| F-10 | 发送前预览确认 | 按段展示将发送的内容；确认后才发送，预览即即将发送的字节 | `hospital-ai-miniapp/shared/services/aiClient.ts: buildAskPayload / sendAsk` |
| F-11 | 权威来源白名单过滤 | 只有命中白名单域名的检索结果才作为来源展示（严格子域匹配） | `server/authorities.ts: isAuthorityUrl`；`server/providers/search.ts: search` |
| F-12 | AI 偏好记忆 | 手动或自动提炼偏好条目，可启停、编辑、删除、清空 | `hospital-ai-miniapp/shared/services/records.ts: memory`；`server/extract-memory.ts` |
| F-13 | 结果回流 | AI 结果可「存为资料」或「加入待问清单」 | `hospital-ai-miniapp/pages/ai/ai.ts: onSaveAsNote / onAddToQuestions` |
| F-14 | 数据导出与清除 | 一键导出全部文字记录到固定的 `exports/mhp_export.json`；两步确认后清除全部本地资料、附件与本机导出文件 | `hospital-ai-miniapp/pages/settings/settings.ts: onExport / performWipe` |
| F-15 | 无障碍 | 全局字号 14–32 连续可调；高对比模式 | `hospital-ai-miniapp/shared/ui/a11y.ts: syncA11y` |
| F-16 | 演示模式 | 开发环境下 AI 输出为本地固定内容，全程无外部请求 | `hospital-ai-miniapp/shared/services/demoAi.ts`；`server/demo-fixtures.json` |
| F-17 | AI 问诊引导模式 | 先说一段情况，AI **一次只问一个问题**帮用户补齐信息；追问**不给方向/科室/来源**，只收集事实；答完（或点「结束追问」）后可把问答存为症状记录，或加入待问清单/资料摘录 | `hospital-ai-miniapp/pages/ai/ai.ts: setMode / buildInterviewPreview / handleInterviewResult / onEndInterview / onInterviewDraftConfirm`；`hospital-ai-miniapp/shared/services/aiClient.ts: buildInterviewPayload / sendInterview`；`server/interview.ts: interview` |

完整逐条清单（含工程检查能力）见 `docs/FEATURE-LIST.md`。

### 2.3 非功能需求

| 类别 | 要求 | 实现要点 |
| --- | --- | --- |
| 本地优先 | 记录默认只在本机，无需登录、不上传 | `shared/utils/storage.ts` 的 `mhp_` 命名空间；`shared/services/records.ts` 为唯一数据层 |
| 隐私可控 | 外部 AI 默认关闭；开启前需同意；每次发送前预览 | `config/texts.ts: PRIVACY / CONSENT`；`pages/settings/settings.ts: onAiEnabledChange` |
| 脱敏 | 姓名、手机号、证件号离开本机前固定规则替换 | `shared/services/aiClient.ts: redactText` |
| 出口唯一 | 只允许访问本机回环地址，其它地址结构化拒绝 | `shared/services/aiClient.ts: ALLOWED_PROXY_HOSTS / assertProxyUrl` |
| 安全护栏 | 红标短路、禁词校验、受控科室、引用必须匹配已抓取来源 | `server/redflags.ts`、`server/validate.ts`、`server/prompts.ts` |
| 不编造 | 上游不可用或校验不过时降级本地整理，并如实告知原因 | `pages/ai/ai.ts: handleSendResult / autoLocalSend` |
| 确定性 | 同一输入同一结果，供演示与登记材料复现 | 演示模式 + 固定 fixtures；`artifacts/screenshots/index.json: determinism`（本机运行产物，不入库） |
| 零运行时依赖 | 代理只用 Node 内置模块，无需构建 | `server/tsconfig.json`（可擦除语法约束）；`package.json` 无 `dependencies` |
| 无障碍 | 字号 14–32 逐页生效；高对比配色 | `shared/ui/a11y.ts`；`app.wxss` 的 `.is-hc` |

---

## 3 总体设计

### 3.1 系统架构

```
┌─────────────────────────── 用户手机 ───────────────────────────┐
│  微信小程序 hospital-ai-miniapp/                                │
│  pages/ 8 页  ──►  shared/services/（records / organizer /       │
│                     brief / attachments / oplog / aiClient）     │
│                              │                                   │
│                     shared/utils/storage.ts（mhp_ 本机存储）     │
│                              │                                   │
│                     唯一出口：aiClient（脱敏 + 主机白名单）       │
└──────────────────────────────┼──────────────────────────────────┘
                               │  HTTP 127.0.0.1:8787（仅回环）
┌──────────────────────────────▼─────────────── 用户电脑 ─────────┐
│  本地 AI 代理 server/                                            │
│  index.ts（HTTP 装配）► orchestrator.ask() / interview()         │
│    1) 请求校验（consent / mode / messages）                      │
│    2) redflags 红标扫描 ──命中──► 固定安全提示（零上游调用）      │
│    3) providers/search（问诊至多 1 次）► authorities 白名单过滤   │
│    4) prompts 构建 system 提示 ► providers/llm（OpenAI 兼容）     │
│    5) validate 输出校验（白名单重建 / 禁词 / 受控科室 / 引用核验） │
│       └─ 失败 ──► { error: 'unsafe_output', fallback: 'organize' }│
│  POST /api/interview ► interview()（问诊引导：逐轮单步，不检索）  │
│  config.json（用户自填模型与检索；不入库）                        │
└──────────────────────────────────────────────────────────────────┘
```

### 3.2 技术选型

| 选择 | 理由 |
| --- | --- |
| 微信小程序（WXML/WXSS/TS） | 无需安装 App，随手记录；本机存储满足"数据不出机" |
| 全 TypeScript | 小程序与代理共用一套类型思路；`typecheck` 可作门禁 |
| Node ≥ 24 原生类型擦除 | 代理 `node server/index.ts` 直接运行，**零构建步骤** |
| 零运行时依赖 | 只用 `node:http/fs/path/url` 与全局 `fetch`；可审计、易复现 |
| OpenAI 兼容 `/chat/completions` | 换模型厂商只改 `config.json`，不改代码 |
| 自定义检索契约 `POST /search` | 便于自建检索适配层，且结果可强制过权威白名单 |
| 纯函数 + 固定 fixtures | 演示与截图逐字节可复现，满足登记材料要求 |

### 3.3 模块划分

| 模块 | 文件 | 职责 |
| --- | --- | --- |
| 本地存储 | `shared/utils/storage.ts` | `mhp_` 命名空间读写、schema 版本、清理旧命名空间 |
| 数据层 | `shared/services/records.ts` | 6 类实体的 CRUD、偏好单例；页面上方唯一数据入口 |
| 离线整理 | `shared/services/organizer.ts` | 纯函数整理（要点/提取/待补充/问题），AI 不可用时兜底 |
| 摘要 | `shared/services/brief.ts` | 固定小节顺序汇总；症状原话逐字保留 |
| 附件 | `shared/services/attachments.ts` | 附件复制到小程序本机目录；随记录删除 |
| 审计 | `shared/services/oplog.ts` | 导出、清除等操作追加本地留痕 |
| 网络出口 | `shared/services/aiClient.ts` | 脱敏、构造发送载荷、生成预览、唯一 `wx.request` 调用点 |
| 演示 | `shared/services/demoAi.ts` | 演示模式的本地固定输出 |
| 无障碍 | `shared/ui/a11y.ts` | 字号缩放与高对比偏好读取与下发 |
| HTTP 装配 | `server/index.ts` | 路由、CORS、请求体上限、健康检查 |
| 编排 | `server/orchestrator.ts` | `ask()`：资料整理 / 问诊建议两种模式编排 + 护栏 + 校验，绝不抛异常（问诊引导走独立路由 `interview()`） |
| 提示词 | `server/prompts.ts` | 三种模式 system 提示、受控科室、上限常量 |
| 输出校验 | `server/validate.ts` | 白名单重建、禁词、长度、引用核验、受控科室 |
| 红标 | `server/redflags.ts` | 确定性危重信号扫描 + 固定安全句 |
| 权威域名 | `server/authorities.ts` | 白名单解析与严格子域匹配 |
| 上游适配 | `server/providers/llm.ts`、`server/providers/search.ts` | OpenAI 兼容 LLM；检索 + 权威过滤 |
| 记忆提炼 | `server/extract-memory.ts` | 仅提炼偏好/习惯，禁医疗内容，逐条校验 |
| 问诊引导 | `server/interview.ts` | 连续追问的单步接口 `interview()`；一次一个问题、只收集事实、不给方向/科室/来源 |

### 3.4 一次 AI 问诊的完整数据流

1. 用户在 AI 页输入原话，选择模式（资料整理 / 问诊建议 / 问诊引导）；
2. 客户端按勾选范围组装载荷：脱敏后的档案摘要、记录摘录、启用中的记忆、当前对话；
3. **发送前确认**面板按段展示"即将发送的字节"，用户确认后发送；
4. 代理侧：请求校验 → 红标扫描（命中即返回固定安全提示，零上游调用）；
5. 问诊模式至多发起 1 次检索，结果按权威域名白名单过滤；
6. 构建 system 提示调用 LLM（非流式、严格 JSON）；
7. 输出校验：只有已知字段进入结果；禁词、长度、受控科室、引用与已抓取来源逐项核验；
8. 校验通过则返回结构化结果；失败则返回 `unsafe_output` 并指示客户端降级为**本地整理**。

**问诊引导（第三模式）**：走 `POST /api/interview`。每轮把已有问答发往代理，代理返回**下一个问题**
（一次一个，不检索、不给方向/科室/来源）；用户可随时点「结束追问」，随后弹出「保存为症状记录」
草稿，确认后写入症状记录；追问过程中的问答也可「加入待问清单」「摘成资料」（均只写本机）。

---

## 4 详细设计要点

### 4.1 本地数据层

- 所有记录经 `shared/services/records.ts` 写入 `mhp_` 命名空间，键为
  `records_profile / records_symptoms / records_notes / records_questions / records_briefs /
  records_memory / records_preferences`。
- ID 形如 `<prefix>_<ts>_<rand>`；`updatedAt` 单调不减。
- 单例实体（个人档案、偏好）在写入时替换既有记录。

### 4.2 唯一网络出口与脱敏

- 客户端只有一处 `wx.request` 调用（`aiClient.ts`），且受主机白名单
  （`127.0.0.1` / `localhost`）约束，其它地址结构化拒绝。
- 发送前对姓名、手机号、证件号做固定规则脱敏替换（`[姓名已脱敏]` 等）。
- 预览内容即"将发送的字节"，避免"预览与实发不一致"。

### 4.3 服务端编排与安全护栏

| 护栏 | 规则 |
| --- | --- |
| 红标短路 | 扫描用户消息、记录摘录、档案摘要；命中返回固定安全句，**零 LLM、零检索** |
| 未配置即止 | `llm.baseUrl` 或 `model` 为空时在任何网络之前返回 `provider_not_configured` |
| schema 白名单 | 只有已知字段进入结果，模型额外字段一律丢弃 |
| 受限词 | 通用禁用「确诊/诊断/处方/疗效/剂量」等；方向禁具体医生/医院；建议禁个体化用药指令 |
| 长度 | 方向 ≤20 字，建议 ≤40 字 |
| 引用核验 | 引用 URL 必须与**本次已获取的检索来源**完全一致，且域名通过权威白名单 |
| 受控科室 | 建议科室必须落在固定清单内（全科、心内科、呼吸内科……） |

### 4.4 降级策略

| 情形 | 行为 |
| --- | --- |
| 外部 AI 未开启 | 发送时给出引导，仅在本地处理，不产生外发请求 |
| 本机代理未启动/出错 | 状态条如实说明；后续发送自动改用**本地整理**，绝不编造 AI 内容 |
| 输出未通过校验 | 返回 `unsafe_output`，客户端降级为本地整理，并提示原因 |
| 无命中白名单来源 | 不产生任何无引用的方向/建议；界面在来源位置显示
「未找到权威资料，请向医生确认」 |

### 4.5 无障碍

- 字号 14–32 连续可调，经 `--mhp-scale` 统一下发到 8 个页面的根节点，逐页生效。
- 高对比模式经 `.is-hc` 类切换配色变量。
- 语音输入由系统键盘提供，工具本身**不申请麦克风权限**。

### 4.6 演示模式与确定性

- 开发环境（`envVersion === 'develop'`）下设置页显示「演示模式」开关，正式版不显示。
- 开启后 AI 输出为本地固定内容（`demoAi.ts` / `demo-fixtures.json`），全程零外部请求，
  同一输入永远得到同一结果，用于演示与登记材料复现。
- **单开关自足**：演示模式不要求同时开启「允许外部 AI 调用」，也不弹外部 AI 同意框——
  因为它全程零外发、根本不经 `aiClient`（e2e 契约：demo 在 `aiEnabled=false` 下仍成立且 `wx.request === 0`）。

---

## 5 开发计划与里程碑

开发采用"基线 + 迭代 + 终验"的方式推进，主要工作在本地 `main` 分支完成，另有一个本地
`backup-v1.0-before-split` 备份分支。仓库**曾被推送到一个公开的 GitHub 远端**（`origin`），
该远端包含全部提交；因此历史凭证必须按 `docs/SECURITY-REVOKE.md` 吊销（见该文件「背景」）。

| 阶段 | 内容 | 主要交付物 | 状态 |
| --- | --- | --- | --- |
| M1 基础骨架 | 小程序工程与页面注册；本机存储命名空间；数据层 6 类实体与偏好单例；首启隐私说明 | `app.ts/json`、`shared/utils/storage.ts`、`shared/services/records.ts` | 已完成 |
| M2 本地记录八页 | 工作台、个人档案、症状时间线、资料摘录、待问清单、就医摘要、设置；导航与空态 | `pages/*` 八页各 `.ts/.wxml/.wxss/.json` | 已完成 |
| M3 整理与导出 | 离线整理引擎、摘要组装、摘要图片导出、附件本地保存、操作留痕 | `shared/services/organizer|brief|poster|attachments|oplog.ts` | 已完成 |
| M4 AI 三种模式与安全护栏 | 客户端网络出口与脱敏、发送前预览；代理 HTTP 层、配置契约、编排器、LLM/检索适配器、红标、输出校验、记忆提炼、演示模式 | `shared/services/aiClient|demoAi.ts`、`pages/ai/*`、`server/*` | 已完成 |
| M5 无障碍·门禁·登记材料 | 全局字号与高对比、静态扫描与检查脚本、E2E 与截图引擎、功能清单/演示脚本/来源说明、确定性截图集 | `shared/ui/a11y.ts`、`scripts/*`、`tests/e2e/*`、`docs/*`、`artifacts/screenshots/*` | 已完成 |

**迭代与验收记录**：本仓库提交历史共 10 个提交，自 `f054185`（Initial commit）起至
`fda1101`（HEAD）止，按任务编号连续迭代。收尾阶段执行四轮独立验收并全部通过
（验收报告为**本机运行产物**，见 §6.1 说明）：

| 轮次 | 报告（本机运行产物） | 结论 |
| --- | --- | --- |
| F1 计划合规 | `artifacts/final/plan-compliance.md` | APPROVE（范围内条目全通过，红线零命中） |
| F2 代码质量 | `artifacts/final/code-quality.md` | APPROVE（初判问题修复后复核通过） |
| F3 运行时 QA | `artifacts/final/runtime-qa.md` | APPROVE |
| F4 范围保真 | `artifacts/final/scope-fidelity.md` | APPROVE（成功标准逐条核对） |

---

## 6 测试与验收方案

### 6.1 四层测试

| 层 | 手段 | 产出 |
| --- | --- | --- |
| 静态扫描 | `scripts/static-scan.mjs`：能力禁令词、密钥形态、`app.json` 权限与实现一致性、JSON/语法检查 | `artifacts/scan/*` |
| 逻辑与契约检查 | `scripts/check-*.mjs`：整理、摘要、配置、LLM、检索、编排、记忆提炼、演示矩阵 | `artifacts/checks/*.json` |
| 端到端 | `tests/e2e/*.spec.mjs`（微信开发者工具自动化）：八个页面、AI 同意流、降级、无障碍、演示模式、脱敏 | `artifacts/e2e/*.json` |
| 截图确定性 | `tests/e2e/screenshots-soft.mjs`：演示模式下两次冷启动逐张 SHA256 比对 | `artifacts/screenshots/index.json` |

> 说明：上表「产出」列的 `artifacts/` 是**本机运行产物**目录，已被 `.gitignore` 忽略，
> **不随仓库分发**。此处引用它们只为说明产物形态；克隆后的仓库中并不存在这些文件，
> 需在本机重跑对应命令才会生成。

### 6.2 门禁命令

```bash
npm run typecheck     # 小程序 + 代理类型检查
npm run test:scan     # 静态扫描
npm run test:logic    # 本地整理与摘要逻辑
npm run test:server   # 代理端契约检查
npm run test:e2e      # 端到端（需微信开发者工具）
npm run screenshots       # 常规截图 + 大字长文本 OCR 溢出探针（需微信开发者工具）
npm run screenshots:soft  # 软著登记用确定性截图集（需微信开发者工具）
```

### 6.3 验收标准

1. 上述门禁全部通过；
2. 8 个页面均可正常渲染、无白屏与报错；
3. AI 三种模式可用（资料整理 / 问诊建议 / 问诊引导）；资料整理不含医疗判断；问诊建议每条建议带权威来源，或无来源时显示
   「未找到权威资料，请向医生确认」；
4. 外部 AI 关闭、代理不可用、输出未过校验三种情形均按设计降级，不编造内容；
5. 18 张登记截图在两次冷启动下逐字节一致。

---

## 7 风险与对策

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| 真机无法访问 `127.0.0.1` | 真机上 AI 功能不可用 | 明确产品边界：AI 三种模式与演示仅在开发者工具/本地环境成立；真机为纯本地记录体验 |
| 上游模型/检索不可用 | 问诊建议无结果 | 自动降级本地整理并如实说明；绝不伪造 AI 内容 |
| 模型输出不合规 | 可能产出越界表述 | 红标短路 + 白名单重建 + 禁词/长度/科室/引用四重校验，失败即降级 |
| 引用不可信 | 展示虚假来源 | 引用必须与本次已抓取来源逐字匹配，且域名过权威白名单 |
| 医疗类目审核 | 上架类目与资质要求 | 定位为记录整理工具、全链非诊断声明、不提供用药建议 |
| 外部模型费用 | 用户成本 | 默认关闭外部 AI；可自选模型；提供零成本演示模式 |
| 第三方许可 | 版权合规 | 界面图标来自 Lucide（ISC），已在 `hospital-ai-miniapp/README.md` 声明许可与出处 |
| 凭据泄露 | 安全风险 | 代理配置 `server/config.json` 不入库；仓库仅保留示例文件；历史凭据按 `docs/SECURITY-REVOKE.md` 吊销 |

---

## 8 交付物清单

| 类别 | 内容 |
| --- | --- |
| 小程序源码 | `hospital-ai-miniapp/`（8 页面 + 共享服务/UI/工具 + 配置文案） |
| 代理源码 | `server/`（HTTP 层、编排、提示、校验、红标、权威域名、上游适配、记忆提炼、演示夹具） |
| 工程工具 | `scripts/`（静态扫描与契约检查） |
| 测试 | `tests/e2e/`（E2E 规格、截图引擎） |
| 文档 | `README.md`、`hospital-ai-miniapp/README.md`、`server/README.md`、`docs/*` |
| 登记材料 | 本计划书、`docs/USER-MANUAL.md`、`docs/FEATURE-LIST.md`、`docs/DEMO-SCRIPT.md`、`docs/SOURCES.md` |
| 证据 | `artifacts/`（扫描、检查、E2E、验收报告、确定性截图集；**本机运行产物，已被 `.gitignore` 忽略，不随仓库分发**） |

---

## 9 附录

### 9.1 目录结构

```
medical-navigation/
├── README.md                 项目总览与运行说明
├── package.json              统一命令入口
├── hospital-ai-miniapp/      微信小程序（8 页面 + 共享模块）
├── server/                   本地 AI 代理（零运行时依赖）
├── scripts/                  静态扫描与契约检查
├── tests/e2e/                端到端测试与截图引擎
├── docs/                     文档（含软著登记用材料）
└── artifacts/                证据产物（扫描/检查/E2E/验收/截图）
```

### 9.2 运行命令

```bash
# 1) （仅用 AI 功能时需要）准备代理配置
cp server/config.example.json server/config.json
# 2) 启动本地代理
npm run dev:api          # 监听 http://127.0.0.1:8787
# 3) 用微信开发者工具「导入项目」打开 hospital-ai-miniapp/，AppID 用测试号
#    并在「详情 → 本地设置」勾选「不校验合法域名」
```

### 9.3 术语表

| 术语 | 含义 |
| --- | --- |
| 资料整理模式 | 把口语化原话整理为要点/提取/待补充/可问问题，不做医疗判断 |
| 问诊建议模式 | 结合带入资料给出健康方向、建议科室、来源链接、日常建议与可问问题 |
| 问诊引导模式 | 一次只问一个问题帮用户补齐信息，只收集事实、不给方向/科室/来源，答完可存为症状记录 |
| 红标 | 需要立即线下就医的信号词；命中即短路为固定安全提示 |
| 权威白名单 | 允许作为来源展示的域名清单（`authorityDomains`） |
| 降级 | 上游不可用或校验不过时改用本地整理，并如实说明 |
| 演示模式 | 开发环境下输出本地固定内容、零外部请求的模式 |

---

**文档版本**：V1.0　　**对应软件版本**：就医准备助手 V1.0
