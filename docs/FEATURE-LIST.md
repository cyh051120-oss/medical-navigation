# 功能清单（软件著作权登记用）

本清单逐条对应仓库当前实现：每一行都给出一处可核对的代码锚点（文件路径 + 符号）。
未在代码中实现的能力不列入本清单。所有记录默认保存在本机存储的 `mhp_` 命名空间。

## 一、页面与本地记录

| 功能 | 说明 | 代码锚点 |
| --- | --- | --- |
| 全局左侧导航栏 | 可折叠侧边栏，列出全部 8 个页面并可一键切换；当前页高亮；收起 / 展开状态保存在本机偏好 | `hospital-ai-miniapp/components/app-sidebar/app-sidebar.ts`；`hospital-ai-miniapp/shared/ui/nav.ts` / `hospital-ai-miniapp/shared/ui/sidebar.ts` |
| 工作台总览 | 按本机时间给出问候语与一句话产品定位，附本机日期；展示健康档案准备总览（完整度 + 进度条）、症状/资料/待问计数、最近记录与使用提示。功能入口改由全局左侧导航栏承载 | `hospital-ai-miniapp/pages/home/home.ts: refresh / greetingFor / todayLabelFor`；`hospital-ai-miniapp/config/texts.ts: HOME` |
| 个人档案（单例） | 称呼、年龄段、性别（可选）、过敏、长期用药、既往情况；本机保存与清除 | `hospital-ai-miniapp/shared/services/records.ts: profile`；`hospital-ai-miniapp/pages/profile/profile.ts: onSave / onClear` |
| 症状时间线 | 按发生时间记录症状原话、持续时长、影响、标签与 1 个附件 | `hospital-ai-miniapp/shared/services/records.ts: symptoms`；`hospital-ai-miniapp/pages/symptoms/symptoms.ts: onSave` |
| 资料摘录 | 记录资料名称、摘录、来源日期、备注与 1 个附件 | `hospital-ai-miniapp/shared/services/records.ts: notes`；`hospital-ai-miniapp/pages/notes/notes.ts: onSave` |
| 待问清单与去重导入 | 记录问题与分组、勾选完成、一键多行导入并按文本去重 | `hospital-ai-miniapp/shared/services/records.ts: questions / importMany`；`hospital-ai-miniapp/pages/questions/questions.ts: onImportQuestions / onToggleDone` |
| 就医摘要记录 | 保存可编辑摘要，记录来源记录 id 与导出时间 | `hospital-ai-miniapp/shared/services/records.ts: briefs`；`hospital-ai-miniapp/pages/brief/brief.ts: onGenerate / onSave` |
| AI 偏好记忆 | 手动或自动记录的偏好条目，可启停、编辑、删除、清空 | `hospital-ai-miniapp/shared/services/records.ts: memory`；`hospital-ai-miniapp/pages/settings/settings.ts: onMemorySave / onMemoryToggle / onMemoryDelete` |
| 本地记录 6 类与统一命名空间 | 个人档案、症状、资料、待问、就医摘要、偏好记忆；全部经统一数据层写入本机 `mhp_` 命名空间 | `hospital-ai-miniapp/shared/services/records.ts: ENTITY_KEYS / records`；`hospital-ai-miniapp/shared/utils/storage.ts: clearAll / purgeLegacy` |
| 附件本地保存 | 症状与资料各可带 1 个附件，复制到小程序本机文件目录；可更换/随记录删除 | `hospital-ai-miniapp/shared/services/attachments.ts: addWithAttachment / replaceAttachment / deleteRecordWithAttachment` |
| 操作留痕（本地审计日志） | 导出、清除等操作追加本地审计记录 | `hospital-ai-miniapp/shared/services/oplog.ts: append` |

## 二、整理与导出

| 功能 | 说明 | 代码锚点 |
| --- | --- | --- |
| 就医摘要组装 | 按固定小节顺序汇总所选记录；症状原话逐字保留；空小节整体省略 | `hospital-ai-miniapp/shared/services/brief.ts: build` |
| 摘要复制 | 将摘要文本写入系统剪贴板 | `hospital-ai-miniapp/shared/services/brief.ts: toClipboard`；`hospital-ai-miniapp/pages/brief/brief.ts: onCopy` |
| 摘要图片导出 | 经 2D canvas 生成 750×1334 图片，支持保存到相册与分享 | `hospital-ai-miniapp/pages/brief/brief.ts: onExportImage` |
| 导出全部 | 把文字记录与附件名称/路径引用写入本机文件 | `hospital-ai-miniapp/pages/settings/settings.ts: onExport / buildExportPayload` |
| 清除所有本地资料 | 两步确认后清除记录、旧命名空间、附件目录与本机导出文件 | `hospital-ai-miniapp/pages/settings/settings.ts: performWipe`；`hospital-ai-miniapp/shared/services/records.ts: deleteAll`；`hospital-ai-miniapp/shared/services/attachments.ts: clearAttachments / clearExports` |

## 三、AI 三种模式与安全边界

| 功能 | 说明 | 代码锚点 |
| --- | --- | --- |
| AI 资料整理（组织）模式 | 把一段口语化原话整理成要点、提取线索、待补充项与可问问题 | `hospital-ai-miniapp/pages/ai/ai.ts: setMode / organizeBlocks` |
| AI 问诊建议（咨询）模式 | 结合带入资料给出健康方向、建议就诊科室、来源链接、日常建议与可问问题 | `hospital-ai-miniapp/pages/ai/ai.ts: setMode`；`hospital-ai-miniapp/shared/services/aiRender.ts: consultBlocks` |
| 发送前预览确认 | 按段展示将发送的档案摘要、记录摘录、记忆与对话；确认后才发送，预览即发送字节 | `hospital-ai-miniapp/shared/services/aiClient.ts: buildAskPayload / reassembleAskPayload / sendAsk`；`hospital-ai-miniapp/pages/ai/ai.ts: buildPreview` |
| 权威来源白名单过滤 | 只有命中白名单域名的检索结果才作为来源展示；严格子域匹配 | `server/authorities.ts: DEFAULT_AUTHORITY_DOMAINS / resolveAuthorityDomains / isAuthorityUrl`；`server/providers/search.ts: search` |
| 「未找到权威资料」降级 | 无命中白名单来源时不产生任何方向/建议引用；引用必须与本次已获取来源完全一致，否则降级为本地整理；界面在来源位置展示提示「未找到权威资料，请向医生确认」 | `server/prompts.ts: sourcesBlock`；`server/validate.ts: resolveCitation / validateConsultOutput`；`server/orchestrator.ts: unsafeResult`；`hospital-ai-miniapp/shared/services/aiRender.ts: consultBlocks / citationParts`（`citationParts` 为模块内部辅助，未导出）；`hospital-ai-miniapp/config/texts.ts: AI.noAuthorityNotice` |
| 同意与发送范围 | 外部 AI 默认关闭；开启前需阅读并同意发送范围；问诊建议首次进入需确认 | `hospital-ai-miniapp/pages/settings/settings.ts: onAiEnabledChange`；`hospital-ai-miniapp/pages/ai/ai.ts: requestConsultConsent`；`hospital-ai-miniapp/config/texts.ts: PRIVACY / CONSENT` |
| 姓名/手机号/证件号脱敏 | 内容离开本机前对所有字段做固定规则脱敏替换 | `hospital-ai-miniapp/shared/services/aiClient.ts: redactText / collectKnownNames`（占位符 `NAME_PLACEHOLDER / PHONE_PLACEHOLDER / ID_PLACEHOLDER`） |
| 代理不可用时的本地整理降级 | 代理未启动或出错时不编造内容，改用纯本地整理，并在界面说明原因 | `hospital-ai-miniapp/pages/ai/ai.ts: handleSendResult / autoLocalSend / localFallbackForUnsafe / onLocalOrganize`；`hospital-ai-miniapp/shared/services/organizer.ts: organize` |
| 单一出口与地址白名单 | 只允许访问本机回环地址的代理，其它地址结构化拒绝 | `hospital-ai-miniapp/shared/services/aiClient.ts: ALLOWED_PROXY_HOSTS / assertProxyUrl / postToProxy` |
| 平台隐私授权 | 开启 `__usePrivacyCheck__`；设置页提供「隐私授权」入口（官方 `open-type="agreePrivacyAuthorization"` 同意按钮 + 查看协议全文），授权请求到达时弹出同意浮层；未同意前涉及隐私的接口不可用，应用内可直接完成同意，绝不代替用户同意 | `hospital-ai-miniapp/app.json: __usePrivacyCheck__`；`hospital-ai-miniapp/app.ts: setPrivacyAuthResolver / onNeedPrivacyAuthorization`；`hospital-ai-miniapp/pages/settings/settings.ts: registerPrivacyResolver / onAgreePrivacyAuthorization / onOpenPrivacyContract` |
| 结果回流本地记录 | AI 结果可「存为资料」或「加入待问清单」 | `hospital-ai-miniapp/pages/ai/ai.ts: onSaveAsNote / onDraftConfirm / onAddToQuestions` |
| AI 记忆自动提炼 | 对话后按开关自动提炼偏好记忆，带去重与上限，可中途关闭 | `hospital-ai-miniapp/pages/ai/ai.ts: maybeAutoExtract`；`hospital-ai-miniapp/shared/services/records.ts: memory` |
| 历史对话本地持久化 | 对话记录只写入本机存储，按最近 200 条裁剪上限；损坏/超限写入不会连带清空历史 | `hospital-ai-miniapp/pages/ai/ai.ts: loadMessages / appendMessage / persistMessages` |
| 演示模式（开发环境确定性） | 开发环境下 AI 输出改为本地固定内容，全程无外部请求，同一输入结果一致；**单开关即生效，无需开启外部 AI 调用** | `hospital-ai-miniapp/pages/settings/settings.ts: onDemoModeChange / isDevelopEnv`；`hospital-ai-miniapp/pages/ai/ai.ts: onSend / onConfirmSend / maybeAutoExtract`；`hospital-ai-miniapp/shared/services/demoAi.ts: demoAsk / demoExtractMemory` |
| 问诊引导（连续追问） | 先说一段情况，AI **一次只问一个问题**帮你补齐信息；每轮作答前仍走「发送前确认」；答完（或用户点「结束追问」）弹出「保存为症状记录」草稿，确认后写入症状记录。追问**不给方向/科室/来源**，只收集信息 | `hospital-ai-miniapp/pages/ai/ai.ts: setMode / buildInterviewPreview / handleInterviewResult / onEndInterview / onInterviewDraftConfirm`；`hospital-ai-miniapp/shared/services/aiClient.ts: buildInterviewPayload / sendInterview`；`server/interview.ts: interview`；`server/prompts.ts: INTERVIEW_SYSTEM_PROMPT / INTERVIEW_SLOTS` |

## 四、无障碍

| 功能 | 说明 | 代码锚点 |
| --- | --- | --- |
| 大字模式（全局 14–32） | 8 个页面随偏好连续缩放；字号由 `--mhp-scale` 统一驱动 | `hospital-ai-miniapp/shared/ui/a11y.ts: A11Y_DATA / syncA11y`（`readA11y` 为模块内部读取函数）；`hospital-ai-miniapp/pages/settings/settings.ts: onFontSizeChanging / onFontSizeChange` |
| 高对比度 | 一键切换高对比配色，页面经 `is-hc` 类消费变量映射 | `hospital-ai-miniapp/pages/settings/settings.ts: onHighContrastChange`；`hospital-ai-miniapp/shared/ui/a11y.ts: readA11y`（模块内部读取函数） |

## 五、工程检查能力

| 功能 | 说明 | 代码锚点 |
| --- | --- | --- |
| 能力禁令静态扫描 | 扫描源码/文案中的能力禁令词、密钥与越权声明，带精确白名单 | `scripts/static-scan.mjs: BAN_TERMS / loadWhitelist / main` |
| 演示截图确定性 | 演示模式下两次冷启动截图逐张字节一致，可用于登记材料 | `artifacts/screenshots/index.json: determinism`；生成脚本 `tests/e2e/screenshots-soft.mjs` |
