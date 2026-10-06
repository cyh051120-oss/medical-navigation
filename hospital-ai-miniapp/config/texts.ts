/**
 * config/texts.ts — 长文案唯一来源（single source of long copy）。
 *
 * 页面与组件必须从本模块 import 文案，不得内联长句。
 *
 * 实际导出结构（均为 `as const`，字段只读）：
 *   SAFETY_SENTENCE : string     固定安全提示句（唯一权威版本，任务 25/33 复用）
 *   AUTO_EXTRACT_NOTICE : string 记忆自动提炼说明（任务 28 预览/同意文案唯一来源）
 *   SAFETY          : { fixed }  安全提示分组（fixed === SAFETY_SENTENCE）
 *   DISCLAIMERS     : {...}      非诊断、不提供确诊、不能替代医生、仅供参考
 *   PRIVACY         : {...}      本地优先、外部 AI 默认关闭、清除/导出
 *   CONSENT         : {...}      发送前确认与发送范围说明
 *   EMPTY           : {...}      空态文案
 *   BUTTONS         : {...}      按钮文案
 *   LABELS          : {...}      字段/标签文案
 *   A11Y            : {...}      键盘话筒输入提示、字号说明
 *   DEGRADED        : {...}      代理离线 / 外部 AI 失败的降级提示
 *   MEMORY          : {...}      AI 记忆区块文案（任务 15）
 *   EXPORT          : {...}      导出全部文案（任务 15）
 *   WIPE            : {...}      清除本地资料文案（任务 15）
 *   ABOUT           : {...}      非医疗器械声明与关于（任务 15）
 *
 * 约束：本文件不内联任何医疗能力许可话术；否定式免责短语（如「不提供确诊」）
 * 由 artifacts/scan/whitelist.json 以 path+pattern 精确豁免。
 */

/** 固定安全提示句：单一确定性字符串，不做轻重/紧急判定，仅建议线下就医。 */
export const SAFETY_SENTENCE =
  '如果你出现突然或严重的不适，请立即寻求线下医疗帮助，不要只依赖本工具自行处理。' as const;

export const SAFETY = {
  fixed: SAFETY_SENTENCE,
} as const;

/** 记忆自动提炼说明：预览与同意文案必须包含（任务 28/31/43）。 */
export const AUTO_EXTRACT_NOTICE = '回复后将自动提炼偏好记忆（可在设置关闭）' as const;

export const DISCLAIMERS = {
  notDiagnosis: '本工具为非诊断用途，不提供确诊，不能替代医生的专业判断，内容仅供参考。',
  notProfessional: '本工具不能替代专业医生的当面评估，任何结论都请以线下就诊为准。',
  noMedication: '本工具不提供用药建议，也不调整任何现有治疗方案。',
  seekDoctor: '如有疑问，请向医生确认。',
  notDiagnosisShort: '本工具不作为诊断依据。',
} as const;

export const PRIVACY = {
  localFirst: '你的记录默认只保存在本机，不会自动上传。',
  externalAiOffByDefault: '外部 AI 调用默认关闭；只有你主动开启并同意后，才会使用。',
  externalAiConsent: '开启外部 AI 前会再次说明发送范围，你可以随时关闭。',
  localDataControl: '你可以随时一键清除全部本地数据，或把数据导出备份。',
  externalAiSendScope:
    '开启后，只有你在发送前确认的内容会离开本机：当前输入、你选定的档案摘要、记录摘录，以及启用中的记忆；这些内容经本机代理发送给外部 AI，不会自动上传。',
} as const;

export const CONSENT = {
  beforeSend: '发送前请确认：本次只发送你在上方勾选的内容。',
  scope: '发送范围仅限你选择的内容，未勾选的部分不会离开本机。',
  revocable: '你可以随时撤回同意并关闭外部 AI 调用。',
  enableAiTitle: '开启外部 AI 调用',
  autoExtract: AUTO_EXTRACT_NOTICE,
} as const;

export const EMPTY = {
  records: '还没有记录。从记下第一段身体感受开始。',
  symptoms: '还没有症状记录。',
  notes: '还没有资料摘录。',
  questions: '还没有待问问题。',
  brief: '还没有可导出的内容，请先添加记录。',
  search: '没有找到相关内容。',
  aiDisabled: 'AI 助手尚未开启。你可以先用本地整理功能。',
} as const;

export const BUTTONS = {
  add: '添加',
  save: '保存',
  cancel: '取消',
  edit: '编辑',
  delete: '删除',
  confirm: '确认',
  export: '导出',
  copy: '复制',
  clearAll: '清除全部数据',
  aiOrganize: '本地整理',
  aiConsult: '问诊建议',
} as const;

export const LABELS = {
  createdAt: '创建时间',
  updatedAt: '更新时间',
  source: '来源',
  extracted: '提取要点',
  unknown: '待补充',
  questions: '可以问的问题',
  localOnly: '仅本地',
} as const;

export const A11Y = {
  keyboardMic:
    '可使用键盘话筒输入：语音由系统键盘提供，本工具不申请麦克风权限，使用前请确认你已知晓。',
  fontScale: '可在设置中调整字号，范围 14 到 32。',
  contrast: '可在设置中开启高对比模式。',
} as const;

export const DEGRADED = {
  proxyOffline: '本地代理未启动或未开启。你仍可使用本地整理功能，内容不会上传。',
  aiFailed: '外部 AI 暂时不可用，已切换到本地整理模式。',
  notEnabled: '外部 AI 未开启，本次仅在本地处理。',
  unsafeFallback: '外部 AI 的回复未通过安全校验，已改用本地整理。',
} as const;

export const MEMORY = {
  title: 'AI 记忆',
  intro: 'AI 可在你同意后记住表达偏好，用于调整回复方式；记忆仅保存在本机，可随时修改或删除。',
  empty: '还没有记忆。你可以在下方手动添加，或开启「AI 自动记忆」后由 AI 在对话后提炼。',
  addPlaceholder: '例如：希望回复简短一些',
  autoLabel: 'AI 自动记忆',
  autoHint: '默认开启；关闭后不再发起记忆提炼。',
  sourceManual: '手动',
  sourceAi: 'AI',
  editingHint: '正在编辑这条记忆',
  requiredHint: '请先填写记忆内容',
  savedHint: '记忆已保存',
  deleteTitle: '删除记忆',
  deleteConfirm: '将删除这条记忆，确定继续？',
  clearAllTitle: '清空全部记忆',
  clearAllConfirm: '将删除全部 AI 记忆，确定继续？',
  clearAllButton: '清空全部记忆',
  autoExtractNotice: AUTO_EXTRACT_NOTICE,
} as const;

export const EXPORT = {
  button: '导出全部',
  notice: '图片文件不随文本导出；导出内容仅包含文字记录，以及附件的名称与本地路径引用。',
  doneHint: '已导出全部本地资料',
  failedHint: '导出失败，请重试',
  exportsTitle: '已导出的文件',
  exportsEmpty: '还没有导出文件。',
  exportsNotice: '导出内容为明文文字记录，保存在本机，可在这里单独删除。',
  clearExports: '清空导出文件',
  deleteExportTitle: '删除导出文件',
  deleteExportConfirm: '将删除这个导出文件，确定继续？',
  deleteExportDone: '导出文件已删除',
  clearExportsConfirm: '将删除全部导出文件，确定继续？',
  clearExportsDone: '导出文件已清空',
  deleteFailedHint: '删除未完成，请重试',
} as const;

export const WIPE = {
  button: '清除所有本地资料',
  firstTitle: '清除所有本地资料',
  firstContent: '将删除本机保存的全部记录、附件文件与导出文件；此操作不可撤销。是否继续？',
  secondTitle: '再次确认清除',
  secondContent: '确认后会立即清除全部本地资料、附件与导出文件，且无法恢复。确定要清除吗？',
  doneHint: '已清除本地资料',
  failedHint: '清除未完成，请重试',
  retryButton: '重试清除',
  resultKeysLabel: '本地记录键',
  resultLegacyLabel: '旧数据键',
  resultAttachmentsLabel: '附件文件',
  resultExportsLabel: '导出文件',
  resultUnit: '个',
  resultSeparator: '、',
  partialFailureHint: '部分文件未能删除，请重试清除',
} as const;

export const ABOUT = {
  nonDevice: '本工具是个人使用的本地记录与整理工具，不用于任何医疗用途的判断。',
  aboutText: '「就医准备助手」帮助你在就诊前整理个人资料、症状记录与待问清单；所有数据默认只保存在本机。',
  version: '版本 1.0 · 本地优先',
} as const;

/** 工作台文案：产品定位、档案状态与最近记录（全局导航已移至左侧栏）。 */
export const HOME = {
  tagline: '把零散的健康信息，整理成一份能给医生看的摘要',
  profileTitle: '健康档案',
  profilePending: '去完善',
  profileDone: '去看看',
  profileReadyHint: '档案已填好，可以开始整理摘要了',
  profileTodoHint: '补全档案，整理摘要时更省心',
  overviewUnit: '项已完善',
  statSymptoms: '症状',
  statNotes: '资料',
  statQuestions: '待问',
  recentTitle: '最近记录',
  recentHint: '最近 5 条',
  emptyAction: '记一条症状',
  tipsTitle: '使用提示',
} as const;

/** 症状时间线页文案（任务 17）：记录性语气，仅描述与保存。 */
export const SYMPTOMS = {
  title: '症状时间线',
  intro: '按发生时间倒序记录身体感受；内容只保存在本机。',
  addTitle: '添加症状记录',
  editTitle: '编辑症状记录',
  occurredLabel: '发生时间',
  durationLabel: '持续时长',
  textLabel: '原话',
  impactLabel: '影响',
  tagsLabel: '标签',
  attachmentLabel: '附件（最多 1 个）',
  attachmentHint: '附件仅本地保存与展示，不做任何判读。',
  timestampLabel: '时间戳',
  datePlaceholder: '选择日期',
  timePlaceholder: '选择时间',
  textPlaceholder: '例如：饭后有点胀',
  durationPlaceholder: '例如：20 分钟 / 3 天',
  impactPlaceholder: '例如：没影响睡眠',
  tagsPlaceholder: '用逗号分隔，例如：饭后, 腹胀',
  pickAttachment: '选择附件',
  replaceAttachment: '更换附件',
  requiredHint: '请先填写原话',
  timeRequiredHint: '请选择完整的发生时间',
  attachmentReplaceFailed: '更换失败：新附件未保存，原附件与记录保持不变',
  attachmentNotSaved: '记录已保存，但附件未保存',
  attachmentPickFailed: '未能选择附件，请检查相册权限后重试',
  saveFailed: '保存失败，请重试',
  deleteFailed: '删除失败，请重试',
  savedHint: '症状记录已保存',
  deletedHint: '症状记录已删除',
  deleteTitle: '删除症状记录',
  deleteConfirm: '将删除这条症状记录及其附件，确定继续？',
  createdAtPrefix: '创建',
  updatedAtPrefix: '更新',
} as const;

/** 资料摘录页文案（任务 18）：记录性语气，仅描述、保存与展示。 */
export const NOTES = {
  title: '资料摘录',
  intro: '摘录资料中的原文并注明来源日期；内容只保存在本机。',
  addTitle: '添加资料摘录',
  editTitle: '编辑资料摘录',
  nameLabel: '名称',
  namePlaceholder: '例如：体检报告',
  excerptLabel: '摘录',
  excerptPlaceholder: '例如：抄录资料原文片段',
  sourceDateLabel: '来源日期',
  sourceDatePlaceholder: '选择日期',
  remarkLabel: '备注',
  remarkPlaceholder: '例如：来源与用途说明',
  attachmentLabel: '附件（最多 1 个）',
  attachmentHint: '附件仅本地保存与展示，不做任何判读。',
  pickAttachment: '选择附件',
  replaceAttachment: '更换附件',
  preview: '预览',
  attachmentMissing: '附件缺失，无法预览',
  requiredHint: '请先填写名称',
  attachmentReplaceFailed: '更换失败：新附件未保存，原附件与记录保持不变',
  attachmentNotSaved: '记录已保存，但附件未保存',
  attachmentPickFailed: '未能选择附件，请检查相册权限后重试',
  saveFailed: '保存失败，请重试',
  deleteFailed: '删除失败，请重试',
  savedHint: '资料摘录已保存',
  deletedHint: '资料摘录已删除',
  deleteTitle: '删除资料摘录',
  deleteConfirm: '将删除这条资料摘录及其附件，确定继续？',
  createdAtPrefix: '创建',
  updatedAtPrefix: '更新',
} as const;

/** 待问清单页文案（任务 19）：记录性语气，仅记录、分组与勾选。 */
export const QUESTIONS = {
  title: '待问清单',
  intro: '把想问的问题记下来，按分组整理并勾选已问；内容只保存在本机。',
  addTitle: '添加问题',
  editTitle: '编辑问题',
  textLabel: '问题',
  textPlaceholder: '例如：这个变化需要复查吗',
  groupLabel: '分组',
  groupPlaceholder: '例如：用药 / 复查',
  groupQuickHint: '点击已有分组快速填入',
  noGroup: '未分组',
  filterLabel: '筛选分组',
  filterAll: '全部',
  doneLabel: '已完成',
  pendingCountLabel: '待问',
  listTitle: '全部问题',
  groupStatsTitle: '分组统计',
  toggleHint: '点击方框切换是否已问',
  sourcePrefix: '来源',
  sourceManual: '手动',
  sourceAi: 'AI',
  sourceOrganizer: '整理',
  requiredHint: '请先填写问题',
  savedHint: '问题已保存',
  deletedHint: '问题已删除',
  deleteTitle: '删除问题',
  deleteConfirm: '将删除这条问题，确定继续？',
  importToggleOpen: '一键导入',
  importToggleClose: '收起导入',
  importTitle: '一键导入问题',
  importIntro: '粘贴 AI 整理或其他来源的问题，每行一条；与现有问题重复的会自动跳过。',
  importTextLabel: '问题内容（每行一条）',
  importTextPlaceholder: '每行一个问题，重复的会自动跳过',
  importGroupLabel: '导入到分组',
  importAction: '导入',
  importAddedPrefix: '已导入',
  importSkippedPrefix: '跳过重复',
  importEmpty: '请先粘贴至少一条问题。',
  importAllDup: '没有新增：这些问题都已经在清单中。',
  createdAtPrefix: '创建',
  updatedAtPrefix: '更新',
} as const;

/** 就医摘要页文案（任务 20）：记录性语气，只做忠实汇总与整理，不做任何医疗判断。 */
export const BRIEF = {
  title: '就医摘要',
  intro: '选择要整理进摘要的本地记录；摘要只做忠实汇总，不添加判断，内容请与医生确认。',
  selectionTitle: '选择记录',
  profileTitle: '个人档案',
  profileIncluded: '生成时会带上你的个人档案（称呼、年龄段、过敏、长期用药、既往情况）。',
  profileEmpty: '还没有个人档案；可到「个人档案」补充称呼、年龄段与用药情况。',
  symptomsGroup: '症状时间线',
  notesGroup: '资料摘录',
  questionsGroup: '待问问题',
  noSymptoms: '还没有症状记录。',
  noNotes: '还没有资料摘录。',
  noQuestions: '还没有待问问题。',
  selectAll: '全选',
  clearSelection: '清空选择',
  selectedPrefix: '已选',
  selectedUnit: '条记录',
  generate: '生成摘要',
  generateEmpty: '请先选择至少一条记录',
  editorTitle: '摘要内容（可编辑）',
  editorRawNotice: '「症状时间线」逐字保留你填写的原话，未做改写。',
  editorOrganizedNotice: '其余内容为按你选择的记录整理而成，属于整理内容，就诊时请与医生确认。',
  editorPlaceholder: '选择记录后点击「生成摘要」，这里会出现可编辑的摘要内容。',
  saveHint: '就医摘要已保存',
  savedAtPrefix: '导出时间',
  copyDone: '已复制摘要',
  copyFailed: '复制失败，请重试',
  copyEmpty: '摘要内容为空，暂无可复制的内容',
  saveEmpty: '摘要内容为空，无法保存',
  saveFailed: '保存失败，请重试',
  savedListTitle: '已保存的摘要',
  savedListEmpty: '还没有保存过摘要。',
  savedTimeLabel: '保存时间',
  open: '打开',
  deleteSavedTitle: '删除已保存摘要',
  deleteSavedConfirm: '将删除这条已保存摘要，确定继续？',
  deleteSavedDone: '已删除摘要',
  openHint: '已载入这条摘要，可继续编辑或复制',
  recordsLabel: '条',
} as const;

/** 摘要图片导出文案（任务 21）：记录性语气；图片内容与编辑区摘要一致。 */
export const POSTER = {
  header: '就医准备助手',
  generatedAtPrefix: '生成时间',
  footerNotice: '用户自述 / 待医生确认',
  exportTitle: '导出图片',
  exportNotice: '把摘要生成一张 750×1334 的图片；内容较长时会自动缩小并可能截断，完整内容请以文本摘要为准。',
  exportImage: '生成图片',
  saveImage: '保存到相册',
  share: '分享',
  exporting: '正在生成图片',
  exportDone: '图片已生成，可保存到相册或分享',
  exportFailed: '图片生成失败，请重试',
  exportEmpty: '摘要内容为空，暂无可导出的图片',
  exportFirst: '请先生成图片',
  overflowHint: '摘要较长，图片只包含前面部分；完整内容请用「复制」保存文本摘要。',
  saveImageDone: '已保存到相册',
  saveImageFailed: '保存失败，请重试',
  permissionTitle: '需要相册权限',
  permissionContent: '请在设置中允许访问相册，才能把这张图片保存到相册。',
  permissionConfirm: '去设置',
  permissionHint: '未获得相册权限，可在设置中开启后重试',
  shareTitle: '就医准备助手',
} as const;

/** AI 助手页文案（任务 29）：双模式、带入资料、记忆与降级提示。 */
export const AI = {
  title: 'AI 助手',
  intro: '整理一段原话，或梳理想问的方向；内容只在本地保存，发送前会先给你看发送范围。',
  modeOrganize: '资料整理',
  modeConsult: '问诊建议',
  modeOrganizeHint: '整理要点、提取线索与待补充项，不联网也能用。',
  modeConsultHint: '结合你选择的资料梳理想问的方向，发送前需先确认范围。',
  modeInterview: '问诊引导',
  modeInterviewHint: '先说一段情况，再一次一个问题地帮你补充；说完可存成症状记录。',
  includeRecords: '带入我的资料',
  includeRecordsHint: '勾选要作为上下文的记录；未勾选的内容不会离开本机。',
  includeProfile: '附带档案摘要',
  includeProfileEmpty: '还没有可用档案，可到「个人档案」补充。',
  includeMemoriesPrefix: '已带入',
  includeMemoriesUnit: '条记忆',
  includeMemoriesNone: '未带入记忆',
  memoriesAutoHint: '启用中的记忆会自动带入，可在设置中管理。',
  previewTitle: '发送前确认',
  previewIntro: '以下内容将经本机代理发送给外部 AI；确认后才会发送。',
  previewEmpty: '本次没有额外的档案或记录，仅发送当前对话。',
  previewConfirm: '确认发送',
  previewCancel: '取消',
  /** 预览区独立行：开启外部 AI 且自动记忆开启时展示自动提炼说明（任务 31）。 */
  previewMemoryNotice: AUTO_EXTRACT_NOTICE,
  placeholder: '例如：最近一周晚上睡不好，白天没精神',
  send: '发送',
  sendEmptyHint: '请先输入要整理的内容',
  historyEmpty: '还没有对话。输入一段内容开始整理，或在问诊建议里带入你的资料。',
  localOrganize: '改用本地整理',
  localOrganizeTitle: '本地整理结果',
  redflagTitle: '安全提示',
  saveMemory: '存为记忆',
  saveMemoryDone: '已存为记忆',
  saveMemoryDuplicate: '这条已经在记忆中',
  saveMemoryEmpty: '没有可保存的内容',
  autoMemoryHintPrefix: '已自动记住',
  autoMemoryHintUnit: '条偏好',
  autoMemoryJump: '去管理',
  autoMemoryCap: '记忆已达上限（50 条），未继续保存',
  memoryJump: '管理记忆',
  consentTitle: '使用问诊建议前请确认',
  consentContent: [PRIVACY.externalAiSendScope, AUTO_EXTRACT_NOTICE].join('\n\n'),
  consentConfirm: '我同意',
  consentCancel: '先不用',
  sectionPoints: '要点',
  sectionExtracted: '提取',
  sectionUnknowns: '待补充',
  sectionQuestions: '可以问的问题',
  sectionDirections: '健康方向',
  sectionDepartments: '建议就诊科室',
  sectionCitations: '来源链接',
  /** 无命中白名单来源时的来源小节提示标题；配合 noAuthorityNotice 展示。 */
  sectionSourcesNotice: '来源说明',
  /** 无权威来源时的用户可见提示（决策记录 D-AI4）；是提示而非来源条目。 */
  noAuthorityNotice: '未找到权威资料，请向医生确认',
  sectionSuggestions: '日常建议',
  extractedSymptoms: '症状',
  extractedMedications: '用药',
  extractedAllergies: '过敏',
  extractedHistory: '既往',
  extractedExams: '检查',
  extractedTimes: '时间线索',
  extractedValues: '数值线索',
  extractedMeds: '疑似药品',
  nonAdvice: '非医嘱',
  citationPrefix: '来源：',
  kindSymptom: '症状',
  kindNote: '资料',
  kindQuestion: '问题',
  sourceLocal: '本地整理',
  sourceExternal: '外部 AI',
  aiDisabledHint: '外部 AI 未开启，可先用本地整理。',
  /** 顶部状态条（任务 31）：disabled / idle / ok / offline / local 五态文案与动作。 */
  statusDisabled: '外部 AI 未开启，当前为纯本地模式',
  statusIdle: '外部 AI 已开启；发送前会先给你看发送范围',
  statusOk: '外部 AI 最近一次发送成功',
  statusOffline: '本地代理未连接，本次未能发送；下次发送将自动改用本地整理',
  statusLocal: '本地代理未连接，已自动改用本地整理',
  statusSettingsAction: '去设置',
  statusRetryAction: '重试连接',
  /** 未开启外部 AI 时的发送引导（任务 31）。 */
  guideTitle: '外部 AI 未开启',
  guideContent: '当前为纯本地模式：整理与保存都能用，内容不会离开本机。若需使用外部 AI，请到设置开启并同意发送范围。',
  guideConfirm: '去设置',
  guideCancel: '先不用',
  /** 代理失败后自动改用本地整理的提示（任务 31）。 */
  autoLocalHint: '本地代理未连接，已自动改用本地整理',
  /** 在途提炼被丢弃（期间关闭外部 AI 或自动记忆）的提示（任务 31）。 */
  memoryDiscardHint: '本次未保存记忆：外部 AI 或自动提炼已关闭',
  memoryManageHint: '记忆只保存在本机，可在设置中修改或删除。',
  saveAsNote: '存为资料',
  addToQuestions: '加入待问清单',
  noteDraftTitle: '保存为资料摘录',
  noteDraftIntro: '确认或修改后保存到「资料摘录」；内容只保存在本机。',
  noteDraftNameLabel: '名称',
  noteDraftExcerptLabel: '摘录',
  noteDraftRemarkLabel: '备注',
  noteDraftConfirm: '保存',
  noteDraftCancel: '取消',
  noteDraftEmpty: '没有可保存的内容',
  noteSavedHint: '已保存为资料摘录',
  noteDuplicateHint: '这条摘录已经在资料中',
  questionAddedPrefix: '已加入待问清单',
  questionAddedUnit: '条',
  questionAddedEmpty: '没有可加入的问题',

  /** 问诊引导（连续追问）。 */
  interviewConsentTitle: '使用问诊引导前请确认',
  interviewConsentConfirm: '我同意',
  interviewConsentCancel: '先不用',
  interviewGuide: '请回答上面的问题；也可以点「存入症状记录」保存，或把这次问答「加入待问清单」「摘成资料」。',
  interviewRoundPrefix: '第',
  interviewRoundUnit: '个问题',
  interviewEnd: '结束追问',
  interviewEndedHint: '已结束追问，请确认这条症状记录。',
  interviewFailedHint: '本次未能继续追问，可点「存入症状记录」保存已填内容。',
  interviewOfflineHint: '本地代理未连接，无法继续追问；可点「存入症状记录」保存已填内容。',
  interviewSavedHint: '已保存为症状记录',
  interviewDraftTitle: '保存为症状记录',
  interviewDraftIntro: '确认或修改后保存到「症状记录」；内容只保存在本机。',
  interviewDraftTextLabel: '原话',
  interviewDraftOnsetLabel: '发生时间',
  interviewDraftDurationLabel: '持续时长',
  interviewDraftImpactLabel: '影响',
  interviewDraftTagsLabel: '标签',
  interviewDraftConfirm: '保存',
  interviewDraftCancel: '取消',
  interviewDraftEmpty: '请先填写原话',
  interviewDraftDuplicateHint: '这条症状记录已存在',
  /** 问诊动作条（A 方案）：问答进行中常驻的三个本地保存入口 + 口语意图提示。 */
  interviewSaveSymptom: '存入症状记录',
  interviewAddQuestions: '加入待问清单',
  interviewSaveNote: '摘成资料',
  interviewNoteName: '问诊记录',
  interviewNoteHint: '已按本次问答预填资料摘录，请确认后保存。',
  interviewIntentSavedHint: '已按你的意思预填，请确认后保存。',
} as const;

/** 演示模式文案（任务 32）：开关仅开发者工具可见；输出为本地固定内容，零外呼。 */
export const DEMO = {
  toggleLabel: '演示模式',
  toggleHint: '开启后 AI 输出为本地固定内容、零外部请求，无需再开「外部 AI 调用」；仅开发者工具可见。',
  enabledHint: '已开启演示模式',
  disabledHint: '已关闭演示模式',
  statusDemo: '演示模式：输出为本地固定内容，不会外发',
  previewNotice: '演示模式：本次使用本地固定内容，不会发起任何请求',
} as const;
