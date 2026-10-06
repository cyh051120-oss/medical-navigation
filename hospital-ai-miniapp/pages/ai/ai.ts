// pages/ai/ai.ts — 双模式 AI 助手页（任务 29）。
//
// 两个产品模式（AiMode）：
//   organize 资料整理：一段原话 → 要点 / 提取 / 待补充 / 可问的问题。
//   consult  问诊建议：结合带入的资料 → 健康方向 / 建议就诊科室 / 来源链接 / 日常建议 /
//             待补充 / 可问的问题；首次进入与每次发送前都需确认发送范围。
//
// 数据与隐私边界：
//   - 历史对话只经 shared/utils/storage.ts（键 ai_messages）本地持久化，超出本页即清；
//     本页不出现任何宿主存储直调。
//   - 实体数据只经 records.*；本地整理经 shared/services/organizer.ts（无网络）。
//   - 外部发送只经 shared/services/aiClient.ts：`buildAskPayload().preview` 即「将发送的字节」，
//     确认后再调 `sendAsk`；失败/跳过一律结构化降级，绝不伪造 AI 内容。
//   - 问诊首次同意标记 `ai_consult_ack` 只存本地；不改 AppPreferences、不触碰 consentVersion。
//   - 演示模式（prefs.demoMode，仅开发者工具可开）自足可用：只开它即可出本地固定结果，
//     不要求 aiEnabled，也不弹外部 AI 同意框——因为全程零外发、根本不走 aiClient。

import { AI, DEGRADED, DEMO, DISCLAIMERS, QUESTIONS, SAFETY } from '../../config/texts';
import {
  MAX_INTERVIEW_QUESTIONS,
  buildAskPayload,
  buildExcerptCandidates,
  buildInterviewPayload,
  defaultRecentExcerpts,
  lastRound,
  sendAsk,
  sendExtractMemory,
  sendInterview,
} from '../../shared/services/aiClient';
import { demoAsk, demoExtractMemory, demoInterview } from '../../shared/services/demoAi';
import type {
  AiMode,
  AskInput,
  ChatMessage,
  ExcerptCandidate,
  InterviewInput,
  InterviewQuestion,
  SendResult,
} from '../../shared/services/aiClient';
import { makeId, records } from '../../shared/services/records';
import { organize } from '../../shared/services/organizer';
import * as storage from '../../shared/utils/storage';
import { A11Y_DATA, syncA11y } from '../../shared/ui/a11y';
import { SIDEBAR_DATA, setSidebarCollapsed, syncSidebar } from '../../shared/ui/sidebar';
// —— 重构抽出：纯渲染 / 解析层（shared/services/aiRender.ts）——
import {
  blocksToText,
  consultBlocks as renderConsultBlocks,
  extractCandidates,
  interviewBlocks,
  interviewQuestionOf,
  isRecord,
  isRedFlag,
  kindLabel,
  localOrganizeBlocks,
  organizeBlocks as renderOrganizeBlocks,
  profileContributes,
  redflagResult,
  serverErrorEnvelope,
  splitTags,
  statusTextFor,
  summarize,
} from '../../shared/services/aiRender';
import type { AiBlock, AiBlockItem, AiStatus } from '../../shared/services/aiRender';
// —— 重构抽出：纯请求体构造（shared/services/aiInput.ts）——
import { buildAskInput, buildInterviewInput as buildInterviewInputPayload } from '../../shared/services/aiInput';
// —— 重构抽出：问诊引导草稿（pages/ai/ai-interview.ts）——
import { interviewDraftFor, matchSaveIntent, noteDraftFor, questionCandidatesFor } from './ai-interview';
// —— 重构抽出：页面级类型与守卫（pages/ai/ai-types.ts）——
import { isAiMessage } from './ai-types';
import type {
  AiKind,
  AiMessage,
  AiTab,
  AssistantDraft,
  CandidateRow,
  DraftForm,
  InterviewDraft,
  PreviewRow,
} from './ai-types';

/** 历史对话本地持久化键（storage.ts 前缀后实际为 mhp_ai_messages）。 */
const HISTORY_KEY = 'ai_messages';
/** 问诊首次同意标记（只存本地布尔；任务 31 会另行扩展正式同意版本）。 */
const CONSULT_ACK_KEY = 'ai_consult_ack';
/** 记忆总量上限：达到后停止新增并提示。 */
const MAX_MEMORY_TOTAL = 50;
/** 问诊引导首次同意标记（只存本地布尔）。 */
const INTERVIEW_ACK_KEY = 'ai_interview_ack';

// —— 软著锚点：资料整理 / 问诊建议渲染委托到 shared/services/aiRender.ts（纯函数，可 node 测）——
const organizeBlocks = (data: unknown): AiBlock[] => renderOrganizeBlocks(data);
const consultBlocks = (data: unknown): { blocks: AiBlock[]; disclaimer: string } => renderConsultBlocks(data);

// 纯渲染 / 解析 / 守卫函数已迁移到 shared/services/aiRender.ts 与 pages/ai/ai-types.ts（见文件顶部 import）。

Page({
  initialMode: '' as string,
  selectedIds: [] as string[],
  selectionInitialized: false,
  pendingInput: null as AskInput | null,
  pendingText: '',
  /** 预览确认后的待发问诊引导请求（与 `pendingInput` 互斥）。 */
  pendingInterview: null as InterviewInput | null,
  /** 当前预览属于哪条链路：/api/ask 还是 /api/interview。 */
  pendingKind: 'ask' as 'ask' | 'interview',
  /** 本轮问诊引导的第一段描述，用作症状记录的「原话」。 */
  interviewOrigin: '',

  data: {
    ...A11Y_DATA,
    ...SIDEBAR_DATA,
    mode: 'organize' as AiTab,
    input: '',
    messages: [] as AiMessage[],
    hasMessages: false,
    candidates: [] as CandidateRow[],
    candidateCount: 0,
    includeProfile: false,
    profileAvailable: false,
    memoryCount: 0,
    memoryTotal: 0,
    memoryLabel: '',
    previewOpen: false,
    previewSections: [] as PreviewRow[],
    previewMemoryNotice: '',
    previewDemoNotice: '',
    aiStatus: 'idle' as AiStatus,
    aiStatusText: '',
    aiEnabled: false,
    demoMode: false,
    autoMemoryEnabled: true,
    autoMemoryAdded: 0,
    autoMemoryHint: '',
    memoryCapHit: false,
    hint: '',
    draftOpen: false,
    draftForm: { name: '', excerpt: '', remark: '' } as DraftForm,
    draftHint: '',
    interviewActive: false,
    interviewQuestion: null as InterviewQuestion | null,
    interviewAnswers: [] as { slot: string; question: string; answer: string }[],
    interviewCount: 0,
    interviewDraftOpen: false,
    interviewDraft: {
      text: '',
      occurredAt: '',
      duration: '',
      impact: '',
      tags: '',
    } as InterviewDraft,
    interviewDraftHint: '',
    sending: false,
    copy: AI,
    safetyFixed: SAFETY.fixed,
    notDiagnosis: DISCLAIMERS.notDiagnosis,
  },

  onLoad(options: Record<string, string | undefined>) {
    const mode = options && typeof options.mode === 'string' ? options.mode : '';
    if (mode === 'organize') this.setData({ mode });
    else if (mode === 'consult') this.initialMode = 'consult';
  },

  onShow() {
    syncA11y(this);
    syncSidebar(this);
    this.loadAll();
    const initial = this.initialMode;
    this.initialMode = '';
    if (initial === 'consult') void this.setMode('consult');
  },

  /** 侧栏收起/展开：落盘偏好并回写 data。 */
  onSidebarToggle() {
    this.setData(setSidebarCollapsed(!this.data.sidebarCollapsed));
  },

  loadAll() {
    const prefs = records.preferences.get();
    const messages = this.loadMessages();
    const aiEnabled = prefs.aiEnabled;
    const demoMode = prefs.demoMode === true;
    let aiStatus = this.data.aiStatus;
    // 演示模式自足：只开演示模式即可出结果（本地固定内容、零外发），无需外部 AI 的同意开关。
    if (demoMode) aiStatus = 'demo';
    else if (aiEnabled !== true) aiStatus = 'disabled';
    else if (aiStatus === 'disabled' || aiStatus === 'demo') aiStatus = 'idle';
    this.setData({
      aiEnabled,
      demoMode,
      autoMemoryEnabled: prefs.autoMemory,
      messages,
      hasMessages: messages.length > 0,
      aiStatus,
      aiStatusText: statusTextFor(aiStatus),
    });
    this.refreshCandidates();
    this.refreshMemoryCount();
  },

  setAiStatus(status: AiStatus): void {
    this.setData({ aiStatus: status, aiStatusText: statusTextFor(status) });
  },

  /** 代理失败后处于本地兜底：后续发送不再外发，直至「重试连接」。 */
  isLocalFallback(): boolean {
    return this.data.aiStatus === 'offline' || this.data.aiStatus === 'local';
  },

  // ----- 历史 -----

  loadMessages(): AiMessage[] {
    const raw = storage.get<unknown>(HISTORY_KEY, []);
    if (!Array.isArray(raw)) return [];
    return raw.filter(isAiMessage);
  },

  chatMessages(): ChatMessage[] {
    // BUG A 修复：助手消息的答案只存在 blocks 中，content 为空；回传上游时用 blocksToText 补全，
    // 否则多轮对话里助手历史全是空串，模型拿不到自己上一轮说了什么。
    return this.data.messages.map((message) => {
      const content =
        message.role === 'assistant' && message.content === '' ? blocksToText(message.blocks) : message.content;
      return { role: message.role, content };
    });
  },

  appendMessage(message: AiMessage): void {
    const messages = this.data.messages.concat([message]);
    storage.set(HISTORY_KEY, messages);
    this.setData({ messages, hasMessages: messages.length > 0 });
  },

  pushAssistant(draft: AssistantDraft): AiMessage {
    const blocks = draft.blocks ?? [];
    const message: AiMessage = {
      id: makeId('aimsg'),
      role: 'assistant',
      mode: draft.mode,
      kind: draft.kind,
      content: draft.content ?? '',
      memoryDraft: draft.memoryDraft ?? summarize(blocks),
      blocks,
      disclaimer: draft.disclaimer ?? '',
      errorText: draft.errorText ?? '',
      canLocalOrganize: draft.canLocalOrganize === true,
      localText: draft.localText ?? '',
      createdAt: new Date().toISOString(),
    };
    this.appendMessage(message);
    return message;
  },

  // ----- 模式与同意 -----

  hasConsultConsent(): boolean {
    return storage.get<boolean>(CONSULT_ACK_KEY, false) === true;
  },

  requestConsultConsent(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      if (typeof wx.showModal !== 'function') {
        resolve(false);
        return;
      }
      wx.showModal({
        title: AI.consentTitle,
        content: AI.consentContent,
        confirmText: AI.consentConfirm,
        cancelText: AI.consentCancel,
        success: (res) => {
          if (res.confirm === true) {
            storage.set(CONSULT_ACK_KEY, true);
            resolve(true);
          } else {
            resolve(false);
          }
        },
        fail: () => resolve(false),
      });
    });
  },

  hasInterviewConsent(): boolean {
    return storage.get<boolean>(INTERVIEW_ACK_KEY, false) === true;
  },

  /** 首次进入问诊引导前的同意框：同意后只记本地布尔，不改 AppPreferences。 */
  requestInterviewConsent(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      if (typeof wx.showModal !== 'function') {
        resolve(false);
        return;
      }
      wx.showModal({
        title: AI.interviewConsentTitle,
        content: AI.consentContent,
        confirmText: AI.interviewConsentConfirm,
        cancelText: AI.interviewConsentCancel,
        success: (res) => {
          if (res.confirm === true) {
            storage.set(INTERVIEW_ACK_KEY, true);
            resolve(true);
          } else {
            resolve(false);
          }
        },
        fail: () => resolve(false),
      });
    });
  },

  applyMode(mode: AiTab): void {
    this.setData({
      mode,
      previewOpen: false,
      previewSections: [],
      previewDemoNotice: '',
      hint: '',
      interviewActive: false,
      interviewQuestion: null,
      // BUG B 修复：切换模式时清掉上一轮的自动记忆提示条，避免常驻不消失。
      autoMemoryHint: '',
      autoMemoryAdded: 0,
      memoryCapHit: false,
    });
    this.pendingInput = null;
    this.pendingInterview = null;
    this.pendingKind = 'ask';
    this.refreshMemoryCount();
  },

  setMode(mode: AiTab): Promise<boolean> {
    if (mode === this.data.mode) return Promise.resolve(true);
    if (mode === 'consult' && this.data.demoMode !== true && !this.hasConsultConsent()) {
      return this.requestConsultConsent().then((ok) => {
        if (ok) this.applyMode('consult');
        else this.setData({ hint: AI.aiDisabledHint });
        return ok;
      });
    }
    if (mode === 'interview' && this.data.demoMode !== true && !this.hasInterviewConsent()) {
      return this.requestInterviewConsent().then((ok) => {
        if (ok) {
          this.interviewOrigin = '';
          this.applyMode('interview');
          this.setData({ interviewCount: 0, interviewAnswers: [], interviewActive: false });
        } else {
          this.setData({ hint: AI.aiDisabledHint });
        }
        return ok;
      });
    }
    this.applyMode(mode);
    return Promise.resolve(true);
  },

  onSwitchMode(event: WechatMiniprogram.TouchEvent) {
    const mode = event.currentTarget.dataset.mode;
    if (mode !== 'organize' && mode !== 'consult' && mode !== 'interview') return;
    void this.setMode(mode);
  },

  // ----- 输入与「带入我的资料」 -----

  onInput(event: WechatMiniprogram.Input) {
    this.setData({ input: event.detail.value, hint: '' });
  },

  onToggleProfile() {
    if (!this.data.profileAvailable) return;
    this.setData({ includeProfile: !this.data.includeProfile });
    this.refreshMemoryCount();
  },

  refreshCandidates() {
    const profile = records.profile.list()[0] ?? null;
    const built: ExcerptCandidate[] = buildExcerptCandidates({
      symptoms: records.symptoms.list(),
      notes: records.notes.list(),
      questions: records.questions.list(),
    });
    if (this.selectionInitialized !== true && built.length > 0) {
      this.selectedIds = defaultRecentExcerpts(built).map((candidate) => candidate.id);
      this.selectionInitialized = true;
    }
    const selected = new Set(Array.isArray(this.selectedIds) ? this.selectedIds : []);
    const rows: CandidateRow[] = built.map((candidate) => ({
      id: candidate.id,
      kind: candidate.kind,
      kindLabel: kindLabel(candidate.kind),
      excerpt: candidate.excerpt,
      selected: selected.has(candidate.id),
    }));
    this.setData({ candidates: rows, candidateCount: rows.length, profileAvailable: profileContributes(profile) });
  },

  onToggleExcerpt(event: WechatMiniprogram.TouchEvent) {
    const id = event.currentTarget.dataset.id;
    if (typeof id !== 'string' || id === '') return;
    const selected = Array.isArray(this.selectedIds) ? this.selectedIds.slice() : [];
    const index = selected.indexOf(id);
    if (index === -1) selected.push(id);
    else selected.splice(index, 1);
    this.selectedIds = selected;
    this.refreshCandidates();
    this.refreshMemoryCount();
  },

  selectedExcerpts(): string[] {
    return this.data.candidates.filter((candidate) => candidate.selected).map((candidate) => candidate.excerpt);
  },

  refreshMemoryCount() {
    const enabledMemories = records.memory.list().filter((memory) => memory.enabled === true);
    const profile = records.profile.list()[0] ?? null;
    // 问诊引导只按 /api/interview 的字段计入记忆；这里借用 ask 构造器只为统计条数。
    const askMode: AiMode = this.data.mode === 'interview' ? 'organize' : this.data.mode;
    const built = buildAskPayload({
      mode: askMode,
      messages: [],
      profile: this.data.mode === 'consult' && this.data.includeProfile ? profile : null,
      excerpts: this.data.mode === 'consult' ? this.selectedExcerpts() : [],
      memories: records.memory.list(),
    });
    const count = built.payload.memories === undefined ? 0 : built.payload.memories.length;
    const memoryLabel = count > 0 ? `${AI.includeMemoriesPrefix} ${count} ${AI.includeMemoriesUnit}` : AI.includeMemoriesNone;
    this.setData({ memoryCount: count, memoryTotal: enabledMemories.length, memoryLabel });
  },

  // ----- 发送（先预览确认，再发送） -----

  buildInput(text: string, mode: AiMode): AskInput {
    return buildAskInput(text, mode, {
      messages: this.chatMessages(),
      profile: records.profile.list()[0] ?? null,
      includeProfile: this.data.includeProfile,
      excerpts: this.selectedExcerpts(),
      memories: records.memory.list(),
    });
  },

  /** 关闭外部 AI 时的发送引导：确认去设置（跳转），取消先不用；两者都继续原发送流程。 */
  showEnableGuide(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (typeof wx.showModal !== 'function') {
        resolve();
        return;
      }
      wx.showModal({
        title: AI.guideTitle,
        content: AI.guideContent,
        confirmText: AI.guideConfirm,
        cancelText: AI.guideCancel,
        success: (res) => {
          if (res.confirm === true) this.onJumpSettings();
          resolve();
        },
        fail: () => resolve(),
      });
    });
  },

  /** 组装 `/api/interview` 请求：对话含本轮输入；记忆按启用项带入。 */
  buildInterviewInput(text: string): InterviewInput {
    return buildInterviewInputPayload(text, {
      messages: this.chatMessages(),
      profile: records.profile.list()[0] ?? null,
      round: this.data.interviewCount,
      memories: records.memory.list(),
    });
  },

  /** 预览即「将发送的字节」；开启外部 AI 且自动记忆开启时附上自动提炼说明行。 */
  buildPreview(text: string): { sent: boolean; reason: string } {
    if (this.data.mode === 'interview') return this.buildInterviewPreview(text);
    const mode: AiMode = this.data.mode;
    const input = this.buildInput(text, mode);
    const built = buildAskPayload(input);
    const previewSections: PreviewRow[] = built.preview.sections.map((section) => ({
      key: section.key,
      title: section.title,
      text: section.text,
    }));
    const previewMemoryNotice =
      (this.data.aiEnabled === true || this.data.demoMode === true) && this.data.autoMemoryEnabled === true
        ? AI.previewMemoryNotice
        : '';
    const previewDemoNotice = this.data.demoMode === true ? DEMO.previewNotice : '';
    this.pendingKind = 'ask';
    this.pendingInterview = null;
    this.pendingInput = input;
    this.pendingText = text;
    this.setData({ previewOpen: true, previewSections, previewMemoryNotice, previewDemoNotice, hint: '' });
    return { sent: false, reason: 'preview' };
  },

  /** 问诊引导的预览：与 ask 同形状（记忆 / 对话），复用同一张预览卡与「确认发送」。 */
  buildInterviewPreview(text: string): { sent: boolean; reason: string } {
    const input = this.buildInterviewInput(text);
    const built = buildInterviewPayload(input);
    const previewSections: PreviewRow[] = built.preview.sections.map((section) => ({
      key: section.key,
      title: section.title,
      text: section.text,
    }));
    const previewMemoryNotice =
      (this.data.aiEnabled === true || this.data.demoMode === true) && this.data.autoMemoryEnabled === true
        ? AI.previewMemoryNotice
        : '';
    const previewDemoNotice = this.data.demoMode === true ? DEMO.previewNotice : '';
    this.pendingKind = 'interview';
    this.pendingInterview = input;
    this.pendingInput = null;
    this.pendingText = text;
    this.setData({ previewOpen: true, previewSections, previewMemoryNotice, previewDemoNotice, hint: '' });
    return { sent: false, reason: 'preview' };
  },

  afterSendGuide(text: string): Promise<{ sent: boolean; reason: string }> {
    if (this.data.mode === 'consult' && this.data.demoMode !== true && !this.hasConsultConsent()) {
      return this.requestConsultConsent().then((ok) => {
        if (!ok) {
          this.setData({ hint: AI.aiDisabledHint });
          return { sent: false, reason: 'consent' };
        }
        this.applyMode('consult');
        return this.buildPreview(text);
      });
    }
    return Promise.resolve(this.buildPreview(text));
  },

  onSend(): Promise<{ sent: boolean; reason: string }> {
    // BUG B 修复：每次发送前清掉上一轮的自动记忆提示条。
    this.setData({ autoMemoryHint: '', autoMemoryAdded: 0, memoryCapHit: false });
    const text = this.data.input.trim();
    if (text === '') {
      this.setData({ hint: AI.sendEmptyHint });
      this.toast(AI.sendEmptyHint);
      return Promise.resolve({ sent: false, reason: 'empty' });
    }
    if (this.data.mode === 'interview') {
      const intent = matchSaveIntent(text);
      if (intent !== null && (this.data.interviewAnswers.length > 0 || this.interviewOrigin !== '')) {
        return Promise.resolve(this.applyInterviewIntent(intent));
      }
      if (this.data.aiEnabled !== true && this.data.demoMode !== true) {
        // BUG C 修复：问诊引导依赖外部 AI；未开启时只给出开启引导，不再打开注定失败的「发送前预览」。
        return this.showEnableGuide().then(() => {
          this.setData({ hint: AI.aiDisabledHint });
          this.toast(AI.aiDisabledHint);
          return { sent: false, reason: 'disabled' };
        });
      }
      if (this.isLocalFallback()) {
        // 追问链路没有「本地追问」：如实说明，让用户结束并保存已填内容，绝不伪造问题。
        this.setData({ hint: AI.interviewOfflineHint });
        this.toast(AI.interviewOfflineHint);
        return Promise.resolve({ sent: false, reason: 'offline' });
      }
      return Promise.resolve(this.buildInterviewPreview(text));
    }
    if (this.data.aiEnabled !== true && this.data.demoMode !== true) {
      return this.showEnableGuide().then(() => this.afterSendGuide(text));
    }
    if (this.isLocalFallback()) {
      return Promise.resolve(this.autoLocalSend(text));
    }
    return this.afterSendGuide(text);
  },

  onCancelPreview() {
    this.pendingInput = null;
    this.pendingInterview = null;
    this.pendingKind = 'ask';
    this.pendingText = '';
    this.setData({ previewOpen: false, previewSections: [], previewDemoNotice: '' });
    return { cancelled: true };
  },

  onConfirmSend(): Promise<{ ok: boolean; kind?: AiKind; reason?: string }> {
    if (this.pendingKind === 'interview') {
      const interviewInput = this.pendingInterview;
      if (interviewInput === null || interviewInput === undefined) {
        this.setData({ previewOpen: false });
        return Promise.resolve({ ok: false, reason: 'no_pending' });
      }
      const interviewText = this.pendingText;
      this.pendingInterview = null;
      this.pendingText = '';
      this.setData({ previewOpen: false, sending: true });
      const interviewPrefs = records.preferences.get();
      const useInterviewDemo = interviewPrefs.demoMode === true;
      const pendingInterview = useInterviewDemo
        ? Promise.resolve(demoInterview(interviewInput))
        : sendInterview(interviewInput, { prefs: interviewPrefs, consent: true });
      return pendingInterview.then((result) => {
        this.setData({ sending: false });
        return this.handleInterviewResult(result, interviewInput, interviewText);
      });
    }
    const input = this.pendingInput;
    if (input === null || input === undefined) {
      this.setData({ previewOpen: false });
      return Promise.resolve({ ok: false, reason: 'no_pending' });
    }
    const text = this.pendingText;
    this.pendingInput = null;
    this.pendingText = '';
    this.setData({ previewOpen: false, sending: true });
    const prefs = records.preferences.get();
    const useDemo = prefs.demoMode === true;
    const pending = useDemo ? Promise.resolve(demoAsk(input)) : sendAsk(input, { prefs, consent: true });
    return pending.then((result) => {
      this.setData({ sending: false });
      return this.handleSendResult(result, input, text, useDemo);
    });
  },

  handleSendResult(
    result: SendResult,
    input: AskInput,
    text: string,
    demo: boolean
  ): Promise<{ ok: boolean; kind?: AiKind; reason?: string }> {
    if ('skipped' in result && result.skipped === true) {
      const errorText = result.reason === 'ai_disabled' ? DEGRADED.notEnabled : DEGRADED.aiFailed;
      if (result.reason === 'ai_disabled') this.setAiStatus('disabled');
      this.pushAssistant({ kind: 'error', mode: input.mode, errorText, canLocalOrganize: true, localText: text });
      this.setData({ hint: errorText });
      return Promise.resolve({ ok: false, reason: result.reason });
    }
    if (!('ok' in result && result.ok === true)) {
      const errorCode = 'error' in result ? result.error : 'invalid_response';
      const errorText = errorCode === 'proxy_unreachable' ? DEGRADED.proxyOffline : DEGRADED.aiFailed;
      this.setAiStatus('offline');
      this.pushAssistant({ kind: 'error', mode: input.mode, errorText, canLocalOrganize: true, localText: text });
      this.setData({ hint: errorText });
      return Promise.resolve({ ok: false, reason: errorCode });
    }

    const data = result.data;
    const envelope = serverErrorEnvelope(data);
    if (envelope.code !== '') {
      return this.handleServerError(envelope.code, envelope.fallback, text, input.mode);
    }

    this.setAiStatus(demo ? 'demo' : 'ok');
    let kind: AiKind = input.mode === 'organize' ? 'organize' : 'consult';
    let blocks: AiBlock[] = [];
    let disclaimer = '';
    if (isRedFlag(data)) {
      const redflag = redflagResult(data);
      kind = 'redflag';
      blocks = redflag.blocks;
      disclaimer = redflag.disclaimer;
    } else if (input.mode === 'organize') {
      blocks = organizeBlocks(data);
    } else {
      const consult = consultBlocks(data);
      blocks = consult.blocks;
      disclaimer = consult.disclaimer;
    }

    const userMessage: AiMessage = {
      id: makeId('aimsg'),
      role: 'user',
      mode: input.mode,
      kind: 'text',
      content: text,
      memoryDraft: text,
      blocks: [],
      disclaimer: '',
      errorText: '',
      canLocalOrganize: false,
      localText: '',
      createdAt: new Date().toISOString(),
    };
    this.appendMessage(userMessage);
    this.pushAssistant({ kind, mode: input.mode, blocks, disclaimer });
    this.setData({ input: '', hint: '' });
    return this.maybeAutoExtract().then(() => ({ ok: true, kind }));
  },

  /** 服务端错误信封统一降级：unsafe_output 消费 fallback（本地整理），其余保留原文。 */
  handleServerError(
    code: string,
    fallback: string | undefined,
    text: string,
    mode: AiMode
  ): Promise<{ ok: boolean; kind?: AiKind; reason?: string }> {
    if (code === 'unsafe_output' && (fallback === undefined || fallback === 'organize')) {
      return Promise.resolve(this.localFallbackForUnsafe(text, mode));
    }
    const errorText = DEGRADED.aiFailed;
    this.pushAssistant({ kind: 'error', mode, errorText, canLocalOrganize: true, localText: text });
    this.setData({ hint: errorText });
    return Promise.resolve({ ok: false, reason: code });
  },

  localFallbackForUnsafe(text: string, mode: AiMode): { ok: boolean; kind?: AiKind; reason?: string } {
    const result = organize(text);
    const userMessage: AiMessage = {
      id: makeId('aimsg'),
      role: 'user',
      mode,
      kind: 'text',
      content: text,
      memoryDraft: text,
      blocks: [],
      disclaimer: '',
      errorText: '',
      canLocalOrganize: false,
      localText: '',
      createdAt: new Date().toISOString(),
    };
    this.appendMessage(userMessage);
    this.pushAssistant({
      kind: 'local',
      mode: 'organize',
      content: AI.localOrganizeTitle,
      blocks: localOrganizeBlocks(result),
    });
    this.setData({ input: '', hint: DEGRADED.unsafeFallback });
    return { ok: false, reason: 'unsafe_output' };
  },

  // ----- 问诊引导（连续追问，/api/interview） -----

  /** 追加一条 user 消息，并把本轮回答按槽位记录下来。 */
  appendInterviewUser(text: string): void {
    const trimmed = text.trim();
    const question = this.data.interviewQuestion;
    if (this.interviewOrigin === '' && trimmed !== '') this.interviewOrigin = trimmed;
    if (question !== null && trimmed !== '') {
      this.setData({
        interviewAnswers: this.data.interviewAnswers.concat([
          { slot: question.slot, question: question.text, answer: trimmed },
        ]),
      });
    }
    this.appendMessage({
      id: makeId('aimsg'),
      role: 'user',
      mode: 'interview',
      kind: 'text',
      content: text,
      memoryDraft: text,
      blocks: [],
      disclaimer: '',
      errorText: '',
      canLocalOrganize: false,
      localText: '',
      createdAt: new Date().toISOString(),
    });
  },

  /** 处理问诊引导响应：ask / done / 红标 / 失败 四分支。 */
  handleInterviewResult(
    result: SendResult,
    input: InterviewInput,
    text: string
  ): Promise<{ ok: boolean; kind?: AiKind; reason?: string }> {
    if ('skipped' in result && result.skipped === true) {
      const errorText = result.reason === 'ai_disabled' ? DEGRADED.notEnabled : DEGRADED.aiFailed;
      if (result.reason === 'ai_disabled') this.setAiStatus('disabled');
      this.pushAssistant({ kind: 'error', mode: 'interview', errorText, canLocalOrganize: false });
      this.setData({ hint: errorText });
      return Promise.resolve({ ok: false, reason: result.reason });
    }
    if (!('ok' in result && result.ok === true)) {
      const errorCode = 'error' in result ? result.error : 'invalid_response';
      const errorText = errorCode === 'proxy_unreachable' ? DEGRADED.proxyOffline : DEGRADED.aiFailed;
      this.setAiStatus('offline');
      this.pushAssistant({ kind: 'error', mode: 'interview', errorText, canLocalOrganize: false });
      this.setData({ hint: AI.interviewFailedHint });
      return Promise.resolve({ ok: false, reason: errorCode });
    }

    const data = result.data;
    if (isRedFlag(data)) {
      const redflag = redflagResult(data);
      this.appendInterviewUser(text);
      this.pushAssistant({
        kind: 'redflag',
        mode: 'interview',
        blocks: redflag.blocks,
        disclaimer: redflag.disclaimer,
      });
      this.setData({ input: '', hint: '', interviewActive: false, interviewQuestion: null });
      return Promise.resolve({ ok: true, kind: 'redflag' });
    }

    const question = interviewQuestionOf(data);
    if (question === null) {
      const isDone = isRecord(data) && data.status === 'done';
      this.appendInterviewUser(text);
      if (!isDone) {
        this.pushAssistant({ kind: 'error', mode: 'interview', errorText: DEGRADED.aiFailed });
        this.setData({ input: '', hint: AI.interviewFailedHint });
        return Promise.resolve({ ok: false, reason: 'unsafe_output' });
      }
      this.setData({ input: '', hint: '', interviewActive: false, interviewQuestion: null });
      this.openInterviewDraft();
      return Promise.resolve({ ok: true, kind: 'interview' });
    }

    this.appendInterviewUser(text);
    const round = this.data.interviewCount + 1;
    this.pushAssistant({
      kind: 'interview',
      mode: 'interview',
      blocks: interviewBlocks(question, round),
    });
    this.setData({
      input: '',
      hint: AI.interviewGuide,
      interviewActive: true,
      interviewQuestion: question,
      interviewCount: round,
    });
    return Promise.resolve({ ok: true, kind: 'interview' });
  },

  /** 用本轮问答预填「保存为症状记录」草稿。 */
  openInterviewDraft(): void {
    const draft = interviewDraftFor({
      answers: this.data.interviewAnswers,
      origin: this.interviewOrigin,
      messages: this.data.messages,
      occurredAt: new Date().toISOString(),
    });
    this.setData({
      interviewDraftOpen: true,
      interviewActive: false,
      interviewQuestion: null,
      interviewDraft: draft,
      interviewDraftHint: '',
      hint: AI.interviewEndedHint,
    });
  },

  /** 用户主动结束追问。 */
  onEndInterview() {
    this.openInterviewDraft();
    return { opened: true };
  },

  /** 动作条：把本轮问答存入症状记录（与结束追问同一草稿流程）。 */
  onInterviewSaveSymptom() {
    return this.onEndInterview();
  },

  /** 动作条：把本轮问答整理成待问清单（本地保存、自动去重）。 */
  onInterviewAddQuestions() {
    const candidates = questionCandidatesFor({
      answers: this.data.interviewAnswers,
      origin: this.interviewOrigin,
      messages: this.data.messages,
    });
    if (candidates.length === 0) {
      this.setData({ hint: AI.questionAddedEmpty });
      return { added: 0, skipped: 0 };
    }
    const result = records.questions.importMany(
      candidates.map((candidate) => ({ text: candidate, done: false, group: '', source: 'ai' as const }))
    );
    const added = result.added.length;
    const hint = added > 0 ? `${AI.questionAddedPrefix} ${added} ${AI.questionAddedUnit}` : QUESTIONS.importAllDup;
    this.setData({ hint });
    this.toast(hint);
    return { added, skipped: result.skipped };
  },

  /** 动作条：把本轮问答预填成「资料摘录」草稿。 */
  onInterviewSaveNote() {
    const form = noteDraftFor({
      answers: this.data.interviewAnswers,
      origin: this.interviewOrigin,
      messages: this.data.messages,
      name: AI.interviewNoteName,
    });
    this.setData({ draftOpen: true, draftForm: form, draftHint: '', hint: AI.interviewNoteHint });
    return { opened: true };
  },

  /** 把口语指令路由到对应本地保存动作（不发送、不联网）。 */
  applyInterviewIntent(intent: 'symptom' | 'note' | 'questions'): { sent: boolean; reason: string } {
    this.setData({ input: '' });
    if (intent === 'note') {
      this.onInterviewSaveNote();
      return { sent: false, reason: 'intent_note' };
    }
    if (intent === 'questions') {
      this.onInterviewAddQuestions();
      return { sent: false, reason: 'intent_questions' };
    }
    this.onInterviewSaveSymptom();
    this.setData({ hint: AI.interviewIntentSavedHint });
    return { sent: false, reason: 'intent_symptom' };
  },

  onInterviewDraftInput(event: WechatMiniprogram.Input) {
    const field = event.currentTarget.dataset.field;
    const draft = { ...this.data.interviewDraft };
    const value = event.detail.value;
    if (field === 'text') draft.text = value;
    else if (field === 'occurredAt') draft.occurredAt = value;
    else if (field === 'duration') draft.duration = value;
    else if (field === 'impact') draft.impact = value;
    else if (field === 'tags') draft.tags = value;
    else return;
    this.setData({ interviewDraft: draft, interviewDraftHint: '' });
  },

  /** 保存为症状记录（`records.symptoms`，与原话去重）。 */
  onInterviewDraftConfirm() {
    const draft = this.data.interviewDraft;
    const text = draft.text.trim();
    if (text === '') {
      this.setData({ interviewDraftHint: AI.interviewDraftEmpty });
      return { saved: false, reason: 'empty' };
    }
    const existing = records.symptoms.list();
    if (existing.some((symptom) => typeof symptom.text === 'string' && symptom.text.trim() === text)) {
      this.setData({
        interviewDraftHint: AI.interviewDraftDuplicateHint,
        hint: AI.interviewDraftDuplicateHint,
      });
      this.toast(AI.interviewDraftDuplicateHint);
      return { saved: false, reason: 'duplicate' };
    }
    const record = records.symptoms.add({
      occurredAt: draft.occurredAt.trim(),
      duration: draft.duration.trim(),
      text,
      impact: draft.impact.trim(),
      tags: splitTags(draft.tags),
      attachment: null,
    });
    this.interviewOrigin = '';
    this.setData({
      interviewDraftOpen: false,
      interviewDraft: { text: '', occurredAt: '', duration: '', impact: '', tags: '' },
      interviewDraftHint: '',
      interviewAnswers: [],
      interviewCount: 0,
      hint: AI.interviewSavedHint,
    });
    this.toast(AI.interviewSavedHint);
    return { saved: true, id: record.id };
  },

  onInterviewDraftCancel() {
    this.interviewOrigin = '';
    this.setData({
      interviewDraftOpen: false,
      interviewDraft: { text: '', occurredAt: '', duration: '', impact: '', tags: '' },
      interviewDraftHint: '',
      interviewAnswers: [],
      interviewCount: 0,
    });
    return { cancelled: true };
  },

  // ----- 本地整理（失败路径，无网络） -----

  onLocalOrganize(event?: WechatMiniprogram.TouchEvent) {
    const dataset = event === undefined ? {} : event.currentTarget.dataset;
    const fromDataset = typeof dataset.text === 'string' ? dataset.text : '';
    const text = (fromDataset !== '' ? fromDataset : this.pendingText !== '' ? this.pendingText : this.data.input).trim();
    if (text === '') {
      this.setData({ hint: AI.sendEmptyHint });
      return { organized: false, reason: 'empty' };
    }
    const result = organize(text);
    const userMessage: AiMessage = {
      id: makeId('aimsg'),
      role: 'user',
      mode: 'organize',
      kind: 'text',
      content: text,
      memoryDraft: text,
      blocks: [],
      disclaimer: '',
      errorText: '',
      canLocalOrganize: false,
      localText: '',
      createdAt: new Date().toISOString(),
    };
    this.appendMessage(userMessage);
    this.pushAssistant({
      kind: 'local',
      mode: 'organize',
      content: AI.localOrganizeTitle,
      blocks: localOrganizeBlocks(result),
    });
    this.pendingText = '';
    this.setData({ input: '', hint: '' });
    return { organized: true, points: result.points.length };
  },

  /** 代理离线后的下一次发送：零网络，直接走本地整理并置状态为 local。 */
  autoLocalSend(text: string): { sent: boolean; reason: string } {
    const result = organize(text);
    const userMessage: AiMessage = {
      id: makeId('aimsg'),
      role: 'user',
      mode: this.data.mode,
      kind: 'text',
      content: text,
      memoryDraft: text,
      blocks: [],
      disclaimer: '',
      errorText: '',
      canLocalOrganize: false,
      localText: '',
      createdAt: new Date().toISOString(),
    };
    this.appendMessage(userMessage);
    this.pushAssistant({
      kind: 'local',
      mode: 'organize',
      blocks: localOrganizeBlocks(result),
    });
    this.setAiStatus('local');
    this.setData({ input: '', hint: AI.autoLocalHint });
    return { sent: false, reason: 'local' };
  },

  /** 重试连接：清除 offline/local 兜底，使下一次发送重新尝试外部路径。 */
  onRetryConnection() {
    if (this.isLocalFallback()) {
      this.setAiStatus('idle');
      this.setData({ hint: '' });
    }
    return { retried: true };
  },

  // ----- 记忆 -----

  onSaveMemory(event: WechatMiniprogram.TouchEvent) {
    const id = typeof event.currentTarget.dataset.id === 'string' ? event.currentTarget.dataset.id : '';
    let text = '';
    if (id === 'input') {
      text = this.data.input.trim();
    } else if (id !== '') {
      const message = this.data.messages.filter((item) => item.id === id)[0];
      text = message === undefined ? '' : message.memoryDraft.trim();
    }
    if (text === '') {
      this.setData({ hint: AI.saveMemoryEmpty });
      return { added: false, reason: 'empty' };
    }
    const existing = records.memory.list();
    if (existing.some((memory) => memory.text.trim() === text)) {
      this.setData({ hint: AI.saveMemoryDuplicate });
      this.toast(AI.saveMemoryDuplicate);
      return { added: false, reason: 'duplicate' };
    }
    if (existing.length >= MAX_MEMORY_TOTAL) {
      this.setData({ hint: AI.autoMemoryCap, memoryCapHit: true });
      this.toast(AI.autoMemoryCap);
      return { added: false, reason: 'cap' };
    }
    records.memory.add({ text, source: 'ai' });
    this.setData({ hint: AI.saveMemoryDone, memoryCapHit: false });
    this.toast(AI.saveMemoryDone);
    this.refreshMemoryCount();
    return { added: true };
  },

  // ----- 结果回流本地记录（任务 30） -----

  lookupItem(dataset: Record<string, unknown>): { block: AiBlock; entry: AiBlockItem } | null {
    const messageId = typeof dataset.messageId === 'string' ? dataset.messageId : '';
    const message = this.data.messages.filter((item) => item.id === messageId)[0];
    if (message === undefined) return null;
    const blockIndex = Number(dataset.blockIndex);
    const itemIndex = Number(dataset.itemIndex);
    if (!Number.isInteger(blockIndex) || !Number.isInteger(itemIndex)) return null;
    const block = message.blocks[blockIndex];
    if (block === undefined) return null;
    const entry = block.items[itemIndex];
    if (entry === undefined) return null;
    return { block, entry };
  },

  onSaveAsNote(event: WechatMiniprogram.TouchEvent) {
    const found = this.lookupItem(event.currentTarget.dataset as Record<string, unknown>);
    if (found === null || found.entry.text.trim() === '') {
      this.setData({ hint: AI.noteDraftEmpty });
      return { opened: false, reason: 'empty' };
    }
    const source =
      found.entry.url !== '' ? (found.entry.sub !== '' ? `${found.entry.sub} ${found.entry.url}` : found.entry.url) : '';
    this.setData({
      draftOpen: true,
      draftForm: { name: found.block.title, excerpt: found.entry.text, remark: source },
      draftHint: '',
      hint: '',
    });
    return { opened: true };
  },

  onDraftInput(event: WechatMiniprogram.Input) {
    const field = event.currentTarget.dataset.field;
    const form = { ...this.data.draftForm };
    if (field === 'name') form.name = event.detail.value;
    else if (field === 'excerpt') form.excerpt = event.detail.value;
    else if (field === 'remark') form.remark = event.detail.value;
    else return;
    this.setData({ draftForm: form, draftHint: '' });
  },

  onDraftConfirm() {
    const form = this.data.draftForm;
    const excerpt = form.excerpt.trim();
    if (excerpt === '') {
      this.setData({ draftHint: AI.noteDraftEmpty });
      return { saved: false, reason: 'empty' };
    }
    const existing = records.notes.list();
    if (existing.some((note) => typeof note.excerpt === 'string' && note.excerpt.trim() === excerpt)) {
      this.setData({ draftHint: AI.noteDuplicateHint, hint: AI.noteDuplicateHint });
      this.toast(AI.noteDuplicateHint);
      return { saved: false, reason: 'duplicate' };
    }
    const record = records.notes.add({
      name: form.name.trim(),
      excerpt,
      sourceDate: '',
      attachment: null,
      remark: form.remark.trim(),
    });
    this.setData({
      draftOpen: false,
      draftForm: { name: '', excerpt: '', remark: '' },
      draftHint: '',
      hint: AI.noteSavedHint,
    });
    this.toast(AI.noteSavedHint);
    return { saved: true, id: record.id };
  },

  onDraftCancel() {
    this.setData({ draftOpen: false, draftForm: { name: '', excerpt: '', remark: '' }, draftHint: '' });
    return { cancelled: true };
  },

  onAddToQuestions(event: WechatMiniprogram.TouchEvent) {
    const found = this.lookupItem(event.currentTarget.dataset as Record<string, unknown>);
    if (found === null || found.entry.text.trim() === '') {
      this.setData({ hint: AI.questionAddedEmpty });
      return { added: 0, skipped: 0 };
    }
    const result = records.questions.importMany([
      { text: found.entry.text, done: false, group: '', source: 'ai' },
    ]);
    const added = result.added.length;
    const hint = added > 0 ? `${AI.questionAddedPrefix} ${added} ${AI.questionAddedUnit}` : QUESTIONS.importAllDup;
    this.setData({ hint });
    this.toast(hint);
    return { added, skipped: result.skipped };
  },

  // ----- 自动提炼 -----

  maybeAutoExtract(): Promise<{ ran: boolean; added: number; discarded?: boolean }> {
    const prefs = records.preferences.get();
    const demo = prefs.demoMode === true;
    if ((prefs.aiEnabled !== true && !demo) || prefs.autoMemory !== true) {
      return Promise.resolve({ ran: false, added: 0 });
    }
    const useDemo = demo;
    const round = lastRound(this.chatMessages());
    if (round.length === 0) return Promise.resolve({ ran: false, added: 0 });
    const profile = records.profile.list()[0] ?? null;
    const pending = useDemo
      ? Promise.resolve(demoExtractMemory({ messages: round, profile }))
      : sendExtractMemory({ messages: round, profile }, { prefs, consent: true });
    return pending.then((result) => {
      const nowPrefs = records.preferences.get();
      if ((nowPrefs.aiEnabled !== true && nowPrefs.demoMode !== true) || nowPrefs.autoMemory !== true) {
        this.setData({ autoMemoryAdded: 0, autoMemoryHint: AI.memoryDiscardHint, memoryCapHit: false });
        return { ran: true, added: 0, discarded: true };
      }
      if (!('ok' in result) || result.ok !== true) return { ran: true, added: 0 };
      const candidates = extractCandidates(result.data);
      const existing = records.memory.list();
      const seen = new Set(existing.map((memory) => memory.text.trim()));
      let added = 0;
      let capHit = false;
      for (const candidate of candidates) {
        if (seen.has(candidate)) continue;
        if (existing.length + added >= MAX_MEMORY_TOTAL) {
          capHit = true;
          break;
        }
        records.memory.add({ text: candidate, source: 'ai' });
        seen.add(candidate);
        added += 1;
      }
      const addedHint = `${AI.autoMemoryHintPrefix} ${added} ${AI.autoMemoryHintUnit}`;
      const hint = capHit ? AI.autoMemoryCap : added > 0 ? addedHint : '';
      this.setData({ autoMemoryAdded: added, autoMemoryHint: hint, memoryCapHit: capHit });
      this.refreshMemoryCount();
      return { ran: true, added };
    });
  },

  // ----- 入口跳转 -----

  onJumpSettings() {
    if (typeof wx.navigateTo === 'function') wx.navigateTo({ url: '/pages/settings/settings' });
  },

  toast(title: string) {
    if (typeof wx.showToast === 'function') wx.showToast({ title, icon: 'none' });
  },
});
