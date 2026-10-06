# 软著申报提交清单与整改记录

配套计划：`~/.commandcode/plans/soft-copyright-readiness-and-docs-plan.md`
软件全称与版本：**就医准备助手 V1.0**

---

## 一、本次已完成的整改（含验证）

| 编号 | 整改项 | 改动 | 验证方式与结果 |
| --- | --- | --- | --- |
| **A1** | 清除工作区内的真实 API key | `server/config.json` 的 `llm.apiKey` 置空（保留 `baseUrl`/`model` 作本地配置） | `git grep -nE "user_[A-Za-z0-9]{10,}"` → **无命中**（**已修订：真实 key 移至仓库外，见第九节**） |
| **A2** | 静态扫描不再内置真实凭据前缀 | `scripts/static-scan.mjs`：原硬编码的凭据前缀（API Key `9573****`、接入点 `ep-****`、百度 ASR AK `I8EQ****` / SK `qVZc****`，均为不完整掩码，完整值不在仓库内）改为**结构化模式**（`\bep-\d{14}\b`、`\bsk-[A-Za-z0-9_-]{16,}`、`\bAKID[A-Za-z0-9]{16,}`、方舟默认域名、相关厂商域名），并支持用环境变量 `MHP_SECRET_PATTERN` 追加特定字面量做定向复扫 | `node scripts/static-scan.mjs` → `capability bans: 0`、`secrets/domains: 0`、`json 0`、`syntax 0`（`ts check` 当时报 error 仅因本机 spawn 问题；已在 AI 重构轮修复，现为 `passed`，见第九节） |
| **A3** | 证据文件中的明文凭据掩码化 | `artifacts/scan/credentials-after.txt:5`、`artifacts/final/plan-compliance.md:61-63`、`artifacts/qa/4-failure.txt`（明文 AK 及其 `match` 字段均已改为 `I8EQ****` 掩码）。仓库自身 `docs/SECURITY-REVOKE.md` 本就禁止任何文件写入明文凭据，此为合规修复 | `git grep -nE "\bep-\d{14}\b\|\bsk-[A-Za-z0-9_-]{16,}\|\bAKID[A-Za-z0-9]{16,}"` → **无命中** |
| **B1** | 版本号统一 | `package.json` `version` `0.0.0` → `1.0.0`。**未改** `hospital-ai-miniapp/config/texts.ts` 的 `ABOUT.version`（`'版本 1.0 · 本地优先'`），以保持设置页两张截图的字节一致 | 界面文案仍为「版本 1.0」，仓库内版本表述不再出现 `0.0.0` |
| **B5** | 补版本记录 | 新增 `CHANGELOG.md`（`1.0.0` 条目：小程序 / 代理 / 文档与工程三段新增项） | 与 `package.json` 的 `1.0.0` 及界面「版本 1.0」一致 |
| **B6** | 补第三方许可声明 | 新增 `THIRD-PARTY-NOTICES.md`：Lucide ISC 全文 + Feather 派生图标的 MIT 全文、devDependencies 许可表、权威域名清单说明 | 许可正文取自上游 LICENSE（URL 与拉取日期已注明；npm 包 `lucide-static` 1.48.0 存在，但上游仓库 tag 为 `v0.x` 系列、无 `v1.48.0`，故许可正文按仓库 `main` 分支核取） |
| **B7** | 源码材料导出 | 新增 `scripts/export-source-material.mjs`；产出 `artifacts/soft-copyright/source-listing.txt`、`source-listing-60pages.txt`、`source-material.json` | 实跑：**73 文件 / 15,799 行**，共 **319 页**（据本机产物 `artifacts/soft-copyright/source-material.json` 的 `totals`；该目录不入库，见第九节），输出前 30 + 后 30 页；清单内只出现代码标识符（`apiKey: string`、`Bearer ${cfg.apiKey}`），**无真实密钥字面量**；`server/config.json` 已排除 |
| **C1** | 修正过时的验收结论 | 在 `artifacts/final/scope-fidelity.md` 的 A3 条目后加「后续修订」脚注：字面提示「未找到权威资料，请向医生确认」**当前已实现**（`config/texts.ts: AI.noAuthorityNotice` 定义、`shared/services/aiRender.ts: consultBlocks` 渲染、`tests/e2e/ai-page.spec.mjs: 'consult-no-source'` 断言；`artifacts/e2e/ai-page.json` 为**本机运行产物**，不入库），原「零命中」结论针对更早 HEAD | 已逐条核对（改用文件 + 符号级锚点，避免行号漂移） |

### 附：本次运行的副作用（已处理）

- 运行 `node scripts/static-scan.mjs` 会生成 `artifacts/scan/static-scan-full.json`（未跟踪产物，项目自身 churn 纪律要求运行后删除，见 `artifacts/final/code-quality.md:34`）——**已删除**。
- 同一次运行会重写 `artifacts/scan/neutral-terms.json`（report-only 报告，新增 `generatedAt` 时间戳）。本次改动不涉及任何中性词（科室/医生/医院/就诊/急诊），**词条与计数未变**，仅时间戳更新。注意：`artifacts/` 整个目录**未被 Git 跟踪**（`.gitignore` 忽略），因此**无法用 `git checkout -- artifacts/...` 还原**；如需回到旧内容，请重跑对应命令重新生成。

---

## 二、需你人工执行（仓库无法代做）

| 编号 | 事项 | 说明 |
| --- | --- | --- |
| **A4** | **打包边界** | 只取项目根目录 `medical-navigation/`。**不要**打包其父目录：父目录含 `.commandcode/taste/taste.md`（行为画像笔记）与游离的 `project.config.json` |
| **A5** | **历史凭证吊销** | 按 `docs/SECURITY-REVOKE.md` 的「用户必须执行」一节到控制台吊销：火山引擎方舟 API Key、两个推理接入点、百度智能云 ASR 的 AK/SK。**从仓库移除 ≠ 吊销**，且仓库已被推送到公开远端 |
| **B2** | **AppID 口径确认** | 源码现为 `touristappid`（测试号，`hospital-ai-miniapp/project.config.json: appid`）；证据文件保留历史值 `wxd3658bde1dabe949`。请确认申报材料以哪个口径为准（软著登记本身不要求 AppID） |
| **B4** | **测试期 key 轮换** | 联调时贴入对话的那个 Command Code API key 建议吊销重建；新 key 只填在**仓库外**的 `%USERPROFILE%\.medical-prep\config.local.json`（经 `MHP_CONFIG_PATH` 注入，见第九节）；`server/config.json` 保持空 key 模板 |
| **C2** | 确认接受「TTS/ASR 不实现」（`docs/A11Y-DECISION.md §5`） | 需你表态 |
| **C3** | 确认接受「真机 `127.0.0.1` 不可达，AI 仅开发者工具/演示模式成立」 | 需你表态 |
| **C4** | 确认自担医疗类审核/类目风险与外部模型费用 | 需你表态 |
| **C5** | 微信公众平台「用户隐私保护指引」声明项、AppID 主体类型核对 | 仅后台可见，仓库无法证明 |

---

## 三、关于 B3（本机信息脱敏）——本次**未做批量改写**，需你知晓

计划中 B3 为「对证据里的本机信息脱敏」。复核后发现这类信息（用户名 `aizou`、`/Users/aizou/...`、`darwin 27.0.0`）散落在**约 50 个证据文件**中，包括
`artifacts/e2e/*.json`、`artifacts/qa/*.txt`、`artifacts/final/*.md`、`artifacts/screenshots/index.json`、`artifacts/screenshots/style-refactor/index.json`、`artifacts/scan/*` 等。

**未批量改写的理由：**

1. 这批文件是**历史验收证据**，批量改写会削弱它们"当时运行结果"的证明力；
2. 软著提交材料是**申请表 + 源程序 60 页 + 软件说明书 60 页**，`artifacts/` 本就不在提交范围内；
3. 本机路径不在任何提交材料中出现，实际暴露面为零。

若你仍希望处理，可选：

- **仅脱敏会被引用的两处**：`artifacts/screenshots/index.json` 的 `platform` / `project_path` 字段（说明书引用了该索引）；
- **或**新增一个 `scripts/redact-local-paths.mjs`，在**打包副本**上批量替换 `/Users/aizou` → `<user-home>`、`darwin 27.0.0` → `<platform>`，原始证据保持不动。

---

## 四、提交前自检命令

```bash
# 1) 明文凭据零残留（期望：无输出）
git grep -nE "\bep-[0-9]{14}\b|\bsk-[A-Za-z0-9_-]{16,}|\bAKID[A-Za-z0-9]{16,}|user_[A-Za-z0-9]{10,}"   # 期望：无输出

# 2) 静态扫描（需先 npm i 以获得 tsc，否则 ts 检查会报 error）
npm run test:scan

# 3) 代理配置不含真实密钥（期望：llm.apiKey 为空；search 段仍为本地演示占位 "mock"）
grep -n '"apiKey"' server/config.json

# 4) 版本一致性（期望：1.0.0）
grep -n '"version"' package.json

# 5) 重新导出源码材料（改动产品源码后需重跑；期望：73 文件 / 15,799 行 / 319 页）
node scripts/export-source-material.mjs
```

---

## 五、软著提交材料清单

| 材料 | 来源 | 状态 |
| --- | --- | --- |
| 软件著作权登记申请表 | 中国版权保护中心在线填报 | 待你填报 |
| 源程序（前 30 页 + 后 30 页，连续，每页 ≥50 行） | 已导出：`artifacts/soft-copyright/source-listing-60pages.txt`（前 30 + 后 30 页）；全量清单 `source-listing.txt`（73 文件 / 15,799 行 / 319 页）。打印成 PDF 即可提交 | **已导出** |
| 软件说明书（操作手册） | `docs/USER-MANUAL.md`（含 18 张界面截图） | **已完成** |
| 项目开发计划书 | `docs/PROJECT-PLAN.md` | **已完成** |
| 功能清单 | `docs/FEATURE-LIST.md` | 已有 |
| 演示脚本 | `docs/DEMO-SCRIPT.md` | 已有 |
| 来源与合规说明 | `docs/SOURCES.md` | 已有 |
| 版本记录 | `CHANGELOG.md` | 新增 |
| 第三方许可声明 | `THIRD-PARTY-NOTICES.md` | 新增 |
| 软件运行图样 | `artifacts/screenshots/soft-copyright/`（18 张，含 SHA256 与双跑一致性） | 已有 |
| 申请人身份证明 | 申请人 | 待你提供 |

---

## 六、功能改动「问诊引导」对材料的影响

AI 助手新增第三张模式卡「问诊引导」：先说一段情况 → AI **一次只问一个问题** → 答完（或点「结束追问」）
弹出「保存为症状记录」草稿 → 确认后写入症状记录。追问**不给方向/科室/来源**，只收集信息。

**代码状态**：已完成并通过 `npm run typecheck` 与新增契约检查 `scripts/check-interview.mjs`（31/31）。

| 材料 | 影响 | 处理 |
| --- | --- | --- |
| `artifacts/screenshots/soft-copyright/{ai-14,ai-32,ai-consult-14,ai-consult-32}.png` | AI 页新增第三张卡 → 这 4 张**图样失效** | **必须在原 macOS 环境重跑** `node tests/e2e/screenshots-soft.mjs`，并重写 `artifacts/screenshots/index.json`（shots 与 hash_pairs 各 4 处 sha256 + `determinism` 块）；建议新增 `ai-interview-14/32.png`（总数 18 → 20） |
| `docs/USER-MANUAL.md` 4.7 节 | 已补「问诊引导」操作说明、三种模式卡片与按钮文案 | **已完成** |
| `docs/DEMO-SCRIPT.md` 第 7 步 | 已改为「三种模式」并补追问流程 | **已完成** |
| `docs/PROJECT-PLAN.md` 功能编号表 | 已补 F-17「AI 问诊引导模式」，并同步 §3.1 架构图与 §3.3 模块表 | **已完成** |
| `docs/FEATURE-LIST.md` | 已补一行（第三节） | **已完成** |
| `server/README.md` | 已补 `POST /api/interview` 一节 | **已完成** |
| `tests/e2e/ai-page.spec.mjs` | 静态不变量只要求 `data-mode="organize"` / `"consult"` 存在，本就不排斥第三张卡 | **无需修改** |
| `scripts/check-interview.mjs`、`package.json` | 新增契约检查并接入 `test:server` 链 | **已完成** |

**本机验证情况（Windows）**：`npm run typecheck` exit 0；`node scripts/check-interview.mjs` **31/31**；
`npm run test:scan` 的 bans / secrets / json / syntax 全 0。**e2e 与截图重生成无法在本机执行**
（依赖微信开发者工具自动化与原 macOS 环境）。各检查脚本内置的 `npx tsc` 门禁原先在本机因
`spawnSync('npx')` 在 Windows 返回 `ENOENT` 而报 `exit=null`——**已在 AI 重构轮修复（加 `shell: win32`），
现 `test:scan` / `test:logic` / `test:server` 全部 exit 0，见第九节**。

---

## 七、功能改动「首页 IA 与层次」对材料的影响

首页从「启动器 + 状态卡」改为**产物驱动的工作台**：首屏加一句话产品定位与「主行动」
（按有无记录在「记一条症状 / 生成就医摘要」之间切换）；「健康档案」从大卡片 + 全宽按钮
降为一行紧凑状态；「最近记录」标签固定列宽（各行摘要左边缘对齐）；入口由 8 个平铺磁贴
改为「记录 / 整理与带走 / 设置」三组 7 项（AI 各模式合并为「AI 助手」）；空态补上
「记一条症状」按钮并改写文案（原文案让用户「点击下方按钮」，而那个卡片里没有按钮）。

诊断报告见 `.commandcode/design/review-report.md`（工作区根目录，不在提交边界内）。

**代码状态**：`npm run typecheck` exit 0；`npm run test:scan` 的 bans / secrets / json / syntax 全 0。

| 材料 | 影响 | 处理 |
| --- | --- | --- |
| `artifacts/screenshots/soft-copyright/home-14.png`、`home-32.png` | 首页结构与文案改变 → 失效 | 与「问诊引导」那轮遗留项**合并成一次 macOS 重跑**（`node tests/e2e/screenshots-soft.mjs` + 重写 `index.json`） |
| `tests/e2e/home.spec.mjs` | 工作台入口分组已移除（改为全局左侧导航栏）；spec 的 `EXPECTED_ENTRIES` 仅用于逐路由可达性，不读 DOM | **已核对：无需改** |
| `docs/FEATURE-LIST.md`、`docs/PROJECT-PLAN.md` | 工作台功能描述与代码锚点（`ENTRY_GROUPS` / `primaryActionFor` → 精简为 `refresh` / `greetingFor`；新增左侧导航栏） | **已同步** |
| `docs/DEMO-SCRIPT.md` 步骤 1 | 入口数、档案状态行、空态 | **已同步** |
| `docs/USER-MANUAL.md` 第 4 章引言、4.1 节、8.2 对照表 | 同上 | **已同步** |
| `artifacts/screenshots/style-refactor/index.json` 对比度证据 | 未改配色 → 不受影响 | 无需处理 |

### 7.1 工作台视觉充实（后续补做）

工作台在「精简」之后又做了一轮**视觉充实**，使其填满一屏、信息密度更合理：新增本机日期（与问候同行）、
「准备总览」大号数值 + 进度条 + 提示语、「记录概览」三块计数卡（症状 / 资料 / 待问，可点按进入对应页）、
页尾「使用提示」卡（固定安全提示句 + 本地优先说明）。功能入口仍只由全局左侧导航栏承载，未恢复磁贴式入口。
新增图标 `.mhp-ico--info`；新增文案在 `config/texts.ts: HOME`；本页仍只读（不写入任何记录）。

**代码状态**：`npm run typecheck` exit 0；`npm run test:scan` 无违规；`npm run test:all` 全绿；
a11y 静态契约（每页 `--mhp-scale` / `is-hc` / 字号 `calc(...var(--mhp-scale))` / 零裸 px /
`A11Y_DATA` + `syncA11y(`）8 页 + `app.wxss` PASS。

| 材料 | 影响 | 处理 |
| --- | --- | --- |
| `artifacts/screenshots/soft-copyright/home-14.png`、`home-32.png` | 首页版式再次变化 → 失效 | 与既有遗留项**合并一次 macOS 重跑**（`node tests/e2e/screenshots-soft.mjs` + 重写 `index.json`） |
| `docs/FEATURE-LIST.md`、`docs/PROJECT-PLAN.md`、`docs/DEMO-SCRIPT.md`、`docs/USER-MANUAL.md` | 工作台功能描述与代码锚点 | **已同步** |
| `tests/e2e/home.spec.mjs`、`tests/e2e/a11y.spec.mjs` | 无新增/移除页面，契约不变 | 无需改 |

---

## 八、Windows 自动化（截图 / E2E）探针结果：两条独立阻断

本轮尝试在本机（Windows）打通 `tests/e2e` 的自动化与截图。**结论：原为两条独立阻断；W1 已在本轮修复，仅剩 W2 需你一键开启。**

| # | 阻断 | 证据 | 状态 |
| --- | --- | --- | --- |
| **W1** | `miniprogram-automator` 以 `spawn(cliPath, args)`（**不带 shell**）启动 CLI；Windows 上 CLI 是 `.bat`，Node ≥ 20（本机 Node 24）出于安全**拒绝 spawn `.bat`/`.cmd`** → 立即 `EINVAL`，automator 只能报 `please make sure cliPath is correctly specified`。它还用 `stdio:'ignore'` 起 CLI，所以 CLI 自己的诊断信息根本传不出来 | 源码 `node_modules/miniprogram-automator/out/Launcher.js`：`child_process.spawn(e, n, _)`，`_ = { stdio:'ignore' }`；`spawnSync(cli.bat,['auto',…])` → `status=null error=EINVAL`，经 `cmd /c` → `status=0` | **已修复（本轮）**：`tests/e2e/helpers.mjs` 新增 Windows 分支 `launchViaCmd()`——用 `cmd.exe /c` 自己起 CLI（并捕获输出），再按 automator 的真实协议 `automator.connect({ wsEndpoint: 'ws://127.0.0.1:<port>' })` 接上；同时 `CONFIG.cliPath` 在 Windows 下自动探测 `cli.bat`，`cleanupDevtools`/`frontAppName` 加平台守卫，Windows 跳过 macOS 专有的「后台化阶梯」 |
| **W2** | 开发者工具**「服务端口」未开启**，自动化无法建立。**只能由操作者在 IDE 里开启** | CLI 原始输出：`[error] IDE service port disabled … / 工具的服务端口已关闭。要使用命令行调用工具，请手动打开工具 -> 设置 -> 安全设置，将服务端口开启。`；另**已实测**：CLI 提示里的 "please enter y to confirm enabling CLI capability" **无法从自动化回答**——把 `y` 写入 stdin（`stdio:'pipe'`）后仍报同一句「服务端口已关闭」，说明它需要真实 TTY/控制台。因此未在代码里保留"可代为开启"的开关（做不到的事不留谎） | **待你一键开启**（IDE → 设置 → 安全设置 → 服务端口） |

**W1 的验证证据（本轮实跑）**：修复前报 automator 的含糊提示；修复后同一探针报

```
devtools automation endpoint ws://127.0.0.1:9420 never came up within 90000ms
  cliPath: C:\Program Files (x86)\Tencent\微信web开发者工具\cli.bat
  CLI output (tail):
  [error] IDE service port disabled … / 工具的服务端口已关闭…
```

即：CLI 已被成功拉起（`× initialize` 等真实输出被捕获）、macOS 阶梯已跳过、`cliPath` 自动探测生效，
**失败点已收敛为 W2 这一项**。本轮未写任何截图或 `index.json`（探针脚本放在会话临时目录）。

**所以现状是**：W1 已消除；只剩 W2。你在 IDE 里把「服务端口」打开后，直接跑
`E2E_DEVTOOLS_MINIMIZE=1 node tests/e2e/screenshots-soft.mjs`（可先用 `MHP_SHOT_OUT` 指向临时目录做非破坏性试跑）
即可验证 Windows 出图是否可行。`devtools-background.mjs` 的 macOS 阶梯在 Windows 下已被跳过（不再空跑 5 秒），
若要长期在 Windows 出图，仍建议为该文件补一个 Windows 版阶梯并重建"两次冷启动字节一致"的本机基线。

---

---

## 九、后续修订：AI 助手重构轮（2026-09-29）

对 AI 助手做了「前端重构 + 服务端护栏修复 + 工程门禁修复」三块改动，并在本机（Windows）完成验证。

### 9.1 前端重构（`pages/ai/ai.ts` 拆分）
- `ai.ts` **1299 → 1055 行**；抽出 4 个纯逻辑模块（`shared/services/aiRender.ts`、`aiInput.ts`、`pages/ai/ai-types.ts`、`ai-interview.ts`），页面仅保留控制器与 setData。
- 修复 3 个缺陷：A 多轮上下文（助手消息 `content` 为空，回传上游时用 `blocksToText` 补全）；B 切换模式/发送时清理自动记忆提示条；C 问诊未开启 AI 时不再打开注定失败的预览。
- **19 个软著锚点符号全部保留**（`organizeBlocks`/`consultBlocks`/`setMode`/`buildPreview`/…）。

### 9.2 服务端护栏：`organize.points` 改为「仅拦断言」
- `server/validate.ts` 新增 `NEUTRAL_MARKERS` + 断言式判定：受限词邻近出现「不确定/未说明/待确认/是否…」时视为复述用户信息缺口而放行；无中性标记的断言（「剂量为…」「确诊为…」）仍拦截。
- 根因：模型把用户原话「布洛芬剂量不确定」中性复述进 `points` 即被整单判 `unsafe_output` → 降级本地整理，这正是「AI 无法对话」的残留原因。`unknowns`/`questions` 早已豁免，本轮补上 `points`。
- 新增回归用例 33/34，`check-ask` **34/34**（后续轮次扩至 **36/36**，见 9.8/9.6 汇总）。

### 9.3 工程门禁修复（Windows）
- `spawnSync('npx'|'npm')` 在 Windows 因 `npx.cmd` 无法解析（`status=null`）导致门禁假失败；在 `check-helpers.mjs`、`static-scan.mjs`、`check-server.mjs`、`check-memory.mjs` 加 `shell: process.platform === 'win32'`。
- `check-server.mjs` 改为注入「空 key」临时配置（`MHP_CONFIG_PATH` + 空闲端口），不再依赖开发者本地 `config.json`，也不再抢占 8787。

### 9.4 consult 偶发失败
- 实测根因：推理模型单次 17–60s，`DEFAULT_TIMEOUT_MS=30000` + 1 次重试后仍超时报错；`server/providers/llm.ts` 默认超时 30000 → **60000**（保留重试语义）。调参后 consult 实跑 5/5 成功。

### 9.5 真实 key 重新外置（对应 A1 修订）
- `server/config.json` 的 `llm.apiKey` 再次置空（0 字符），成为归档用模板。
- 真实 key 移至**仓库外** `%USERPROFILE%\.medical-prep\config.local.json`，经 `index.ts` 已支持的 `MHP_CONFIG_PATH` 注入；新增启动器 `scripts/dev-api-local.mjs` 与 `npm run dev:api:local`。
- 自检：`git grep -nE '\bep-[0-9]{14}\b|\bsk-[A-Za-z0-9_-]{16,}|user_[A-Za-z0-9]{10,}'` → **无命中**（`config.json` 已无 key）。

### 9.6 本机验证结果（Windows）
| 项 | 结果 |
| --- | --- |
| `npm run typecheck` | exit 0 |
| `npm run test:scan` | exit 0（`ts check: miniapp=passed, server=passed`）|
| `npm run test:logic` | exit 0（check-organizer / check-brief / check-ai-render 20/20）|
| `npm run test:server` | exit 0（check-server 9/9 · llm 13/13 · search 24/24 · ask 36/36 · extract 27/27 · interview 31/31 · demo ✓ · matrix 32/32）|
| `npm run test:all` | 追加 check-aiclient 15/15 · storage 6/6 · attachments 7/7 · memory 15/15 |
| 真实链路 organize | 「…布洛芬剂量不确定…」不再降级，返回要点 |
| 真实链路 consult ×5 | 5/5 成功（0 错误）|

### 9.7 源码材料影响
- 新增 4 个 `.ts` 源文件 + 若干行为改动 → 重跑 `node scripts/export-source-material.mjs`：**73 文件 / 15,799 行 / 319 页**（据本机产物 `artifacts/soft-copyright/source-material.json` 的 `totals`；目录不入库）。
- `scripts/check-ai-render.mjs` 将原临时断言固化为永久用例并接入 `test:logic`。
- **仍需人工**：`artifacts/screenshots/soft-copyright/*` 与 `tests/e2e/*` 的界面级重跑（依赖微信开发者工具 + 原 macOS 环境），本机不可执行。

### 9.8 问诊动作条（A 方案：问诊引导小步增强）
- `pages/ai/ai-interview.ts` 新增纯函数：`matchSaveIntent`（口语指令识别）、`noteDraftFor`（问答 → 资料摘录草稿）、`questionCandidatesFor`（生成待问候选）；并修复 `interviewDraftFor`——`onset` 槽回答回填「发生时间」、`detail` 槽回答折入症状正文（此前两槽被问出却丢弃）。
- `pages/ai/ai.ts` 新增 `onInterviewSaveSymptom / onInterviewAddQuestions / onInterviewSaveNote / applyInterviewIntent`；问诊进行中输入「帮我记下来 / 加入待问清单 / 摘成资料」等口语指令即路由到对应本地保存动作，**不发送、不联网**（复用 `records.questions.importMany`，`source:'ai'`、`group:''`）。
- `pages/ai/ai.wxml` / `ai.wxss`：问诊进行中常驻动作条（存入症状记录 / 加入待问清单 / 摘成资料）；`config/texts.ts` 新增对应文案；`server/prompts.ts` `LIMITS.maxInterviewChars` 2000 → 4000。
- `scripts/check-ai-render.mjs` 新增 4 条用例（16 → **20/20**）；`npm run test:logic` 同步更新。
- **仍需人工**：`tests/e2e/ai*.spec.mjs` 与软著截图对「结束追问 → 存入症状记录」按钮变更的界面级重跑（依赖微信开发者工具 + 原 macOS 环境）。

### 9.9 演示模式单开关（2026-10-05）
- 现象：在微信开发者工具中，用户只开「演示模式」却「用不了」AI 助手——因为旧逻辑要求 `demoMode && aiEnabled` 同时为真。
- 改动：`pages/ai/ai.ts` 去掉演示路径对 `aiEnabled` 的依赖（`loadAll` / `onSend` / `onConfirmSend` / `buildPreview` / `buildInterviewPreview` / `maybeAutoExtract`），并在演示模式下跳过外部 AI 同意框（`setMode` / `afterSendGuide`）。演示仍**零外发**、不触碰 `aiClient`，隐私默认值不变。
- 文案：`config/texts.ts: DEMO.toggleHint` 明确「无需再开『外部 AI 调用』」。
- 契约更新：`tests/e2e/demo-mode.spec.mjs` 原断言「demoMode never overrides aiEnabled=false」改为新契约 `demo-standalone-ai-disabled`（demo 在 `aiEnabled=false` 下仍出固定结果且 `wx.request === 0`）；失败日志与说明同步。
- 本机验证（无 DevTools，用真实 `ai.ts` + wx shim 的 node/tsx harness 驱动页面方法）：演示单开关 organize / consult 均出结果、**零 `wx.request`、零同意弹窗**；回归：demo 关 + AI 开 → 走真实请求；demo 关 + AI 关 → disabled 且零请求。`npm run typecheck` / `test:scan` / `test:all` 全绿。
- **仍需人工**：`tests/e2e/demo-mode.spec.mjs` 的运行时层（层 2，依赖微信开发者工具）需在 DevTools 内重跑确认。

---

**文档版本**：V1.0　　**对应软件版本**：就医准备助手 V1.0
