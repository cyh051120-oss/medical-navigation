# 演示脚本（软件著作权登记用）

本脚本给出「就医准备助手」微信小程序的可复现演示步骤。步骤顺序与小程序
`hospital-ai-miniapp/app.json` 的 `pages` 数组一致：

home → profile → symptoms → notes → questions → brief → ai → settings

共 8 个主步骤，每步包含「操作」与「预期结果」。全部界面文案与交互均对应仓库当前实现。

## 演示环境与演示数据

- **运行载体**：微信开发者工具「导入项目」打开 `hospital-ai-miniapp/`，AppID 用测试号；
  右上角「详情」→「本地设置」勾选「不校验合法域名」。
- **记录数据**：全部写入手机本机存储的 `mhp_` 命名空间
  （`hospital-ai-miniapp/shared/utils/storage.ts`），默认不上传。
- **演示模式（仅开发者工具可见）**：在「设置」页打开「演示模式」后，AI 输出改为本地固定内容，
  **无需再开「允许外部 AI 调用」**（演示全程零外发、不经 `aiClient`，因此不弹外部 AI 同意框），
  同一输入永远得到同一份结果，且全程不发起任何外部请求。该开关只在开发环境
  （`envVersion === 'develop'`）显示，正式发布版不显示
  （`hospital-ai-miniapp/pages/settings/settings.ts: isDevelopEnv`；固定内容见
  `hospital-ai-miniapp/shared/services/demoAi.ts: demoAsk / demoExtractMemory`）。
  演示模式用于生成演示与登记材料，保证内容确定、可重复。
- **配套截图集**：`artifacts/screenshots/soft-copyright/`，共 18 张
  （8 个页面 × 字号 {14, 32} 共 16 张，另加 AI 问诊建议模式 14 / 32 两张）。
  逐张 SHA256、字节数与文件路径见 `artifacts/screenshots/index.json`，其中 `determinism`
  块记录两次冷启动逐张字节一致。截图在演示模式下生成。

## 步骤 1：工作台（home）

**操作**：打开小程序，进入首页「工作台」。

**预期结果**：

- 顶部按本机时间显示问候语（早上好/中午好/下午好/晚上好/夜深了，见
  `pages/home/home.ts: greetingFor`）；已建档案时问候语后拼接称呼，同行右侧显示本机日期
  （见 `pages/home/home.ts: todayLabelFor`，如「10月3日 周六」）。
- 问候语下方是**一句话产品定位**。
- 「准备总览」以大号数字显示 `已完善 X / 5 项` 与进度条，并给出提示语，右侧为「去完善 / 去看看」
  （核心字段 称呼/年龄段/过敏/长期用药/既往情况）。
- 「记录概览」三块计数卡显示 症状 / 资料 / 待问 条数，点按进入对应页面。
- 「最近记录」列出最近 5 条记录（症状、资料、待问合并后按 `updatedAt` 倒序）；无记录时显示空态文案与「记一条症状」按钮。
- 「使用提示」卡片显示固定安全提示句与本地优先说明。
- 页面左侧是**可折叠导航栏**（`components/app-sidebar`，全局注册于 `app.json`），列出全部 8 个页面：
  工作台、个人档案、症状记录、资料摘录、待问清单、就医摘要、AI 助手、设置；点底部「« / »」可收起为纯图标栏，
  收起状态记入本机偏好（`AppPreferences.sidebarCollapsed`）。工作台自身不再重复列出功能入口。

## 步骤 2：个人档案（profile）

**操作**：进入「个人档案」，填写称呼、年龄段、性别（可选）、过敏、长期用药、既往情况，
点「保存」。

**预期结果**：

- 表单包含称呼、年龄段、性别（可选）、过敏、长期用药、既往情况（`pages/profile/profile.wxml`）。
- 保存后显示创建与更新时间；再次进入仍可见（本机持久化的单例档案，`records.profile`）。
- 点「清除」删除本机档案；称呼留空时保存被拒并给出提示（`pages/profile/profile.ts: onSave / onClear`）。

## 步骤 3：症状时间线（symptoms）

**操作**：进入「症状记录」，点「添加」，选择发生日期与时间，填写原话，可补充持续时长、影响、
标签，并选择 1 个附件，点「保存」。

**预期结果**：

- 记录按发生时间倒序展示为时间线，逐条显示原话、持续时长、影响、标签与附件名
  （`pages/symptoms/symptoms.wxml`）。
- 原话为空时不保存（`pages/symptoms/symptoms.ts: onSave`）。
- 记录与附件只保存在本机。

## 步骤 4：资料摘录（notes）

**操作**：进入「资料摘录」，添加名称、摘录原文、来源日期、备注与 1 个附件，点「保存」。

**预期结果**：

- 列表按来源日期倒序显示名称、摘录、备注与附件名（`pages/notes/notes.wxml`）。
- 点「预览」可查看可读附件；附件缺失时显示「附件缺失，无法预览」占位而不报错。
- 名称留空时保存被拒（`pages/notes/notes.ts: onSave`）。

## 步骤 5：待问清单（questions）

**操作**：进入「待问清单」，点「添加」录入问题并可填分组；展开「一键导入」，每行一条粘贴多个
问题，点「导入」。

**预期结果**：

- 顶部显示 `已完成/总数` 与待问数，并展示分组统计 chips；可按分组筛选
  （`pages/questions/questions.wxml`）。
- 一键导入按规范化文本去重，重复条目自动跳过并提示；全部重复时提示「没有新增」
  （`pages/questions/questions.ts: onImportQuestions`；去重实现 `records.questions.importMany`）。
- 点方框把问题切换为「已完成」，行显示完成态（`pages/questions/questions.ts: onToggleDone`）。

## 步骤 6：就医摘要（brief）——导出

**操作**：进入「就医摘要」，勾选要纳入的记录（个人档案有内容时自动纳入，不作为勾选项），
点「生成摘要」，编辑区出现可编辑摘要；点「复制」把文本写入剪贴板；点「生成图片」得到
750×1334 的摘要图片，可「保存到相册」或「分享」；点「保存」把摘要写入本机。

**预期结果**：

- 摘要按固定小节顺序汇总：称呼/年龄段、症状时间线、用药、过敏/既往、资料摘录、待问问题；
  症状行逐字保留用户原话，缺失小节整体省略、不补写（`shared/services/brief.ts: build`）。
- 编辑区两条说明区分「用户原话」与「整理内容、就诊时请与医生确认」
  （`config/texts.ts: BRIEF.editorRawNotice / editorOrganizedNotice`）。
- 「复制」把摘要文本写入剪贴板（`pages/brief/brief.ts: onCopy`）；「生成图片」经 2D canvas
  导出 750×1334 图片并支持保存到相册/分享（`pages/brief/brief.ts: onExportImage`）。
- 「保存」写入 `records.briefs`（content / sourceIds / exportedAt），页面显示「导出时间」
  （`pages/brief/brief.ts: onGenerate / onSave`）。

## 步骤 7：AI 助手（ai）——双模式与来源展示

**操作**：从工作台进入「资料整理」（`pages/ai/ai?mode=organize`）或「问诊建议」
（`pages/ai/ai?mode=consult`）；输入一段口语化原话；问诊建议模式可打开「带入我的资料」，
勾选要带入的记录；点「发送」，在弹出的「发送前确认」面板查看将发送的范围后点「确认发送」。

**预期结果**：

- **AI 双模式**：
  - 资料整理（组织）模式输出「要点 / 提取 / 待补充 / 可以问的问题」
    （`pages/ai/ai.ts: organizeBlocks`）。
  - 问诊建议（咨询）模式输出「健康方向 / 建议就诊科室 / 来源链接 / 日常建议 / 待补充 /
    可以问的问题」（`pages/ai/ai.ts: consultBlocks`）。
  - 模式切换见 `pages/ai/ai.ts: setMode`；首次进入问诊建议模式需先同意发送范围
    （`pages/ai/ai.ts: requestConsultConsent`）。
- **发送前预览**：面板按段展示将发送的「档案摘要 / 记录摘录 / 记忆 / 对话」，确认后才发送，
  预览内容即将要发送的字节（`pages/ai/ai.ts: buildPreview`；发送边界
  `shared/services/aiClient.ts: buildAskPayload / reassembleAskPayload / sendAsk`）。
- **来源展示**：问诊建议的每条健康方向与日常建议都带 `来源：<标题> · <域名>` 并附链接
  （`pages/ai/ai.ts: citationParts`；前缀文案 `config/texts.ts: AI.citationPrefix`）。来源经过
  服务端权威域名白名单筛选（`server/authorities.ts: isAuthorityUrl`；
  `server/providers/search.ts: search`）。若本次没有命中白名单的来源，服务端规则要求不产生
  任何方向/建议引用（`server/prompts.ts: sourcesBlock`）。若本次没有命中白名单的来源，
  界面在来源位置展示提示「未找到权威资料，请向医生确认」
  （`pages/ai/ai.ts: consultBlocks`；提示文案 `config/texts.ts: AI.noAuthorityNotice`）。
- **降级**：本机代理未启动或出错时，界面显示降级状态条，下一次发送自动改用本地整理（无网络），
  绝不编造 AI 内容（`pages/ai/ai.ts: handleSendResult / autoLocalSend / onLocalOrganize`；
  本地整理引擎 `shared/services/organizer.ts: organize`）。
- **结果回流**：可把 AI 结果「存为资料」或「加入待问清单」
  （`pages/ai/ai.ts: onSaveAsNote / onDraftConfirm / onAddToQuestions`）。

## 步骤 8：设置（settings）——大字模式、高对比度、导出与清除、演示模式

**操作**：进入「设置」，拖动字号滑条、切换高对比模式、开启外部 AI、执行导出/清除、
打开演示模式开关。

**预期结果**：

- **大字模式**：拖动「字号」滑条（14–32），页面文字立即缩放；退出后其他页面同样生效
  （`pages/settings/settings.ts: onFontSizeChanging / onFontSizeChange`；全局机制
  `shared/ui/a11y.ts: syncA11y`，8 个页面根节点统一绑定 `--mhp-scale`）。
- **高对比度**：打开「高对比模式」开关，页面切换为高对比配色
  （`pages/settings/settings.ts: onHighContrastChange`；变量映射见 `app.wxss` 的 `.is-hc`，
  由 `shared/ui/a11y.ts: readA11y` 读取偏好后写入）。
- **外部 AI 调用**：默认关闭；开启前需先阅读发送范围并同意
  （`pages/settings/settings.ts: onAiEnabledChange`）。
- **导出与清除**：「导出全部」把文字记录与附件名称/路径引用写入本机文件
  （`pages/settings/settings.ts: onExport`）；「清除所有本地资料」经两步确认后清除记录、
  旧命名空间与附件（`pages/settings/settings.ts: performWipe`）。
- **演示模式**：仅开发者工具可见的「演示模式」开关；打开后 AI 输出为本地固定内容、全程无外部请求，
  **单开关即生效**（无需再开「允许外部 AI 调用」）
  （`pages/settings/settings.ts: onDemoModeChange / isDevelopEnv`）。

## 附：材料对应关系

- 演示截图：`artifacts/screenshots/soft-copyright/`，索引与确定性说明见
  `artifacts/screenshots/index.json`。
- 功能清单（逐条对应代码锚点）：`docs/FEATURE-LIST.md`。
- 权威来源白名单与「未找到权威资料，请向医生确认」提示说明：`docs/SOURCES.md`。
