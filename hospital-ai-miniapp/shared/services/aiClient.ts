/**
 * shared/services/aiClient.ts — 客户端「脱敏 + 发送范围构建 + 预览 + 传输」。
 *
 * 单一职责：在内容离开本机之前，把它构建成任务 25 冻结的 `/api/ask` 请求体，
 * 并给出「将发送的内容」预览；或者构建任务 43 的 `/api/extract-memory` 请求体。
 *
 * 设计约束：
 *   - `buildAskPayload()` / `buildExtractMemoryPayload()` 为纯函数：不读时钟、不用随机数、
 *     不接触任何宿主接口（无网络、无存储），可在 node 环境直接 import 做检查。
 *   - `redactText()` 确定性去除姓名 / 手机号 / 证件号，用固定占位符替换；对 payload 的
 *     每一个字段（档案摘要 / 记录摘录 / 记忆 / 对话）都执行。
 *   - 仅 `sendAsk()` / `sendExtractMemory()` 调用宿主请求接口，且 host 白名单限定为
 *     本机回环（127.0.0.1 / localhost），其余一律结构化拒绝。
 *   - 失败绝不伪造 AI 内容：返回结构化降级对象 `{ok:false, degraded:true, error}`，
 *     由页面回退本地整理。
 *
 * 发送范围（任务 28 修订，用户确认：档案 / 记录 / 记忆作为 AI 上下文）：
 *   profileSummary  脱敏档案摘要：年龄段 / 性别? / 过敏 / 长期用药 / 既往情况（不含称呼）
 *   recordExcerpts  用户选定记录摘录：症状 / 资料 / 问题（支持多选；默认建议近期 N 条）≤2K 字符
 *   memories        启用中的记忆条目（关闭的不发送）≤20 条 / ≤1K 字符
 *   messages        当前对话（含本轮症状文本）
 *   consent         恒为字面 true（未同意则在传输层短路，不构建、不发送）
 *
 * 预览与发送一致性：`buildAskPayload()` 同时返回 `payload` 与逐段 `preview`；
 *   `reassembleAskPayload(preview)` 从预览逐段还原请求体，与 `payload` 经
 *   `serializeAskPayload()` 序列化后逐字节相等——预览即是「将要发送的内容」。
 *
 * allow: SIZE_OK — T28 明确要求「脱敏 + 发送范围 + 预览 + 传输」为同一个客户端边界模块
 *   （shared/services/aiClient.ts），拆分会破坏任务的单文件交付约束。
 */

import type {
  AppPreferences,
  DocumentNote,
  LocalProfile,
  MemoryItem,
  QuestionList,
  SymptomEntry,
} from './records';
import { MEMORY } from '../../config/texts';

// ---------------------------------------------------------------------------
// 常量（发送范围上限与占位符）
// ---------------------------------------------------------------------------

/** 本机代理默认端口（与服务端 config.json 的 port 默认值一致，避开 devtools 的 9420）。 */
export const DEFAULT_PROXY_PORT = 8787;
/** 本机代理默认地址（唯一允许的外部出口）。 */
export const DEFAULT_PROXY_URL = `http://127.0.0.1:${DEFAULT_PROXY_PORT}`;
/** host 白名单：仅本机回环。 */
export const ALLOWED_PROXY_HOSTS: readonly string[] = ['127.0.0.1', 'localhost'];
export const ASK_PATH = '/api/ask';
export const EXTRACT_PATH = '/api/extract-memory';
export const INTERVIEW_PATH = '/api/interview';
export const DEFAULT_TIMEOUT_MS = 8000;

/** recordExcerpts 合计字符上限（与任务 25 契约一致）。 */
export const MAX_RECORD_EXCERPTS_CHARS = 2000;
/** 记忆条数上限。 */
export const MAX_MEMORY_ITEMS = 20;
/** 记忆合计字符上限。 */
export const MAX_MEMORY_CHARS = 1000;
/** 提炼请求合计字符上限（仅最近一轮）。 */
export const MAX_EXTRACT_CHARS = 2000;
/** 问诊引导请求合计字符上限。 */
export const MAX_INTERVIEW_CHARS = 2000;
/** 问诊引导追问轮数上限（与服务端 LIMITS.maxInterviewQuestions 保持一致）。 */
export const MAX_INTERVIEW_QUESTIONS = 6;
/** 提炼候选条数上限。 */
export const MAX_EXTRACT_ITEMS = 3;
/** 记录摘录「默认建议近期 N 条」的 N。 */
export const DEFAULT_RECENT_RECORDS = 5;

export const NAME_PLACEHOLDER = '[姓名已脱敏]';
export const PHONE_PLACEHOLDER = '[手机号已脱敏]';
export const ID_PLACEHOLDER = '[证件号已脱敏]';

// ---------------------------------------------------------------------------
// 基础类型
// ---------------------------------------------------------------------------

export type AiMode = 'organize' | 'consult';
export type ChatRole = 'user' | 'assistant' | 'system';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

/** 任务 25 冻结的 `/api/ask` 请求体。 */
export interface AskPayload {
  mode: AiMode;
  messages: ChatMessage[];
  profileSummary?: string;
  consent: true;
  recordExcerpts?: string[];
  memories?: string[];
}

/** 任务 43 冻结的 `/api/extract-memory` 请求体。 */
export interface ExtractPayload {
  messages: ChatMessage[];
  consent: true;
  maxItems?: number;
}

/** `buildAskPayload()` 的输入；每个上下文来源都可缺省 = 不发送。 */
export interface AskInput {
  mode: AiMode;
  messages: ChatMessage[];
  /** 档案来源；null/缺省 = 不发送档案摘要。 */
  profile?: LocalProfile | null;
  /** 用户选定的记录摘录（经 `excerptFrom*` 构建）；缺省/空 = 不发送。 */
  excerpts?: string[];
  /** 全部记忆；内部只取 `enabled === true`，缺省/空 = 不发送。 */
  memories?: MemoryItem[];
}

export interface ExtractInput {
  messages: ChatMessage[];
  /** 档案来源：仅用于得到已知姓名做脱敏；缺省则只做手机号/证件号脱敏。 */
  profile?: LocalProfile | null;
  /** 候选条数上限（内部再夹到 `MAX_EXTRACT_ITEMS`）。 */
  maxItems?: number;
}

/** `/api/interview`（问诊引导）请求体。 */
export interface InterviewPayload {
  messages: ChatMessage[];
  consent: true;
  /** 已完成的追问轮数；缺省由服务端按 assistant 轮数估算。 */
  round?: number;
  /** 启用中的记忆条目（偏好语义，仅用于调整提问的表达方式）。 */
  memories?: string[];
}

/** `buildInterviewPayload()` 的输入。 */
export interface InterviewInput {
  messages: ChatMessage[];
  /** 档案来源：仅用于得到已知姓名做脱敏；缺省则只做手机号/证件号脱敏。 */
  profile?: LocalProfile | null;
  /** 已完成的追问轮数。 */
  round?: number;
  /** 全部记忆；内部只取 `enabled === true`。 */
  memories?: MemoryItem[];
}

/** 服务端返回的追问问题；`slot` 决定答案映射到症状记录的哪个字段。 */
export interface InterviewQuestion {
  text: string;
  slot: string;
}

// ---------------------------------------------------------------------------
// 预览类型（逐段「将发送的内容」）
// ---------------------------------------------------------------------------

export type PreviewKey = 'profileSummary' | 'recordExcerpts' | 'memories' | 'messages';
export type PreviewValue = string | string[] | ChatMessage[];

export interface PreviewSection {
  key: PreviewKey;
  /** 逐段标题：档案摘要 / 记录摘录 / 记忆 / 对话。 */
  title: string;
  /** 展示给用户的文本。 */
  text: string;
  /** 对应 payload 字段的确切片段（还原即发送内容）。 */
  value: PreviewValue;
}

export interface AskPayloadPreview {
  mode: AiMode;
  consent: true;
  sections: PreviewSection[];
}

export interface ExtractPreview {
  consent: true;
  /** 自动提炼说明（同意/预览文案必须包含）。 */
  notice: string;
  messages: ChatMessage[];
  text: string;
}

/** 问诊引导的逐段预览（与 ask 同形状：记忆 / 对话）。 */
export interface InterviewPreview {
  consent: true;
  sections: PreviewSection[];
}

export interface AskBuildResult {
  payload: AskPayload;
  preview: AskPayloadPreview;
}

export interface ExtractBuildResult {
  payload: ExtractPayload;
  preview: ExtractPreview;
}

export interface InterviewBuildResult {
  payload: InterviewPayload;
  preview: InterviewPreview;
}

const SECTION_TITLES: Record<PreviewKey, string> = {
  profileSummary: '档案摘要',
  recordExcerpts: '记录摘录',
  memories: '记忆',
  messages: '对话',
};

const ROLE_LABELS: Record<ChatRole, string> = {
  user: '用户',
  assistant: '助手',
  system: '系统',
};

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

function assertNever(value: never): never {
  throw new Error(`[aiClient] unreachable variant: ${String(value)}`);
}

function isFilled(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/** 逐项累积直到超过 `maxChars`；单项超限则截断并停止（确定性）。 */
function capByChars(items: readonly string[], maxChars: number): string[] {
  const out: string[] = [];
  let total = 0;
  for (const item of items) {
    if (total >= maxChars) break;
    const remaining = maxChars - total;
    const piece = item.length <= remaining ? item : item.slice(0, remaining);
    if (piece === '') break;
    out.push(piece);
    total += piece.length;
    if (piece.length < item.length) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 脱敏
// ---------------------------------------------------------------------------

// 手机号：可选 +86 前缀 / 分隔符；证件号：17 位数字 + 校验位。
const PHONE_RE = /(?:\+?86[-\s]?)?1[3-9]\d[\s-]?\d{4}[\s-]?\d{4}/g;
const ID_RE = /\b\d{17}[\dXx]\b/g;

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 收集已知姓名（档案称呼）。长度 < 2 的称呼不参与替换，避免误伤常见单字。
 * 这是确定性规则，不做命名实体识别。
 */
export function collectKnownNames(profile?: LocalProfile | null): string[] {
  if (profile === undefined || profile === null) return [];
  const name = typeof profile.name === 'string' ? profile.name.trim() : '';
  return name.length >= 2 ? [name] : [];
}

/**
 * 确定性脱敏：手机号 → `[手机号已脱敏]`，证件号 → `[证件号已脱敏]`，
 * 已知姓名 → `[姓名已脱敏]`。顺序固定（手机号 → 证件号 → 姓名）。
 */
export function redactText(text: string, knownNames: readonly string[] = []): string {
  if (typeof text !== 'string' || text === '') return text;
  let out = text.replace(ID_RE, ID_PLACEHOLDER).replace(PHONE_RE, PHONE_PLACEHOLDER);
  for (const name of knownNames) {
    if (isFilled(name) && name.length >= 2) {
      out = out.replace(new RegExp(escapeRe(name), 'g'), NAME_PLACEHOLDER);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 档案摘要（脱敏；不含称呼）
// ---------------------------------------------------------------------------

function renderProfileLines(profile?: LocalProfile | null): string[] {
  if (profile === undefined || profile === null) return [];
  const lines: string[] = [];
  if (isFilled(profile.ageRange)) lines.push(`年龄段：${profile.ageRange}`);
  if (isFilled(profile.gender)) lines.push(`性别：${profile.gender}`);
  if (isFilled(profile.allergies)) lines.push(`过敏：${profile.allergies}`);
  if (isFilled(profile.medications)) lines.push(`长期用药：${profile.medications}`);
  if (isFilled(profile.history)) lines.push(`既往情况：${profile.history}`);
  return lines;
}

// ---------------------------------------------------------------------------
// 记录摘录候选（多选 + 默认近期 N 条）
// ---------------------------------------------------------------------------

export type ExcerptKind = 'symptom' | 'note' | 'question';

export interface ExcerptCandidate {
  id: string;
  kind: ExcerptKind;
  updatedAt: string;
  excerpt: string;
}

export function excerptFromSymptom(symptom: SymptomEntry): string {
  const parts: string[] = [];
  if (isFilled(symptom.text)) parts.push(symptom.text);
  if (isFilled(symptom.duration)) parts.push(`持续 ${symptom.duration}`);
  if (isFilled(symptom.impact)) parts.push(`影响 ${symptom.impact}`);
  if (parts.length === 0) return '';
  const time = isFilled(symptom.occurredAt) ? `（${symptom.occurredAt}）` : '';
  return `症状：${parts.join(' ')}${time}`;
}

export function excerptFromNote(note: DocumentNote): string {
  const name = isFilled(note.name) ? note.name : '';
  const body = isFilled(note.excerpt) ? note.excerpt : '';
  let text = '';
  if (name !== '' && body !== '') text = `${name}：${body}`;
  else text = name !== '' ? name : body;
  if (isFilled(note.sourceDate)) {
    text = text === '' ? `来源日期 ${note.sourceDate}` : `${text}（来源日期 ${note.sourceDate}）`;
  }
  return text === '' ? '' : `资料：${text}`;
}

export function excerptFromQuestion(question: QuestionList): string {
  return isFilled(question.text) ? `问题：${question.text}` : '';
}

/** 汇总候选并按 `updatedAt` 降序（同刻按 id）排序，支持调用方多选。 */
export function buildExcerptCandidates(input: {
  symptoms?: readonly SymptomEntry[];
  notes?: readonly DocumentNote[];
  questions?: readonly QuestionList[];
}): ExcerptCandidate[] {
  const candidates: ExcerptCandidate[] = [];
  for (const symptom of input.symptoms ?? []) {
    const excerpt = excerptFromSymptom(symptom);
    if (excerpt !== '') candidates.push({ id: symptom.id, kind: 'symptom', updatedAt: symptom.updatedAt, excerpt });
  }
  for (const note of input.notes ?? []) {
    const excerpt = excerptFromNote(note);
    if (excerpt !== '') candidates.push({ id: note.id, kind: 'note', updatedAt: note.updatedAt, excerpt });
  }
  for (const question of input.questions ?? []) {
    const excerpt = excerptFromQuestion(question);
    if (excerpt !== '') candidates.push({ id: question.id, kind: 'question', updatedAt: question.updatedAt, excerpt });
  }
  return candidates.sort((a, b) => {
    if (a.updatedAt < b.updatedAt) return 1;
    if (a.updatedAt > b.updatedAt) return -1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** 默认建议：近期 `count`（默认 `DEFAULT_RECENT_RECORDS`）条候选。 */
export function defaultRecentExcerpts(
  candidates: readonly ExcerptCandidate[],
  count: number = DEFAULT_RECENT_RECORDS
): ExcerptCandidate[] {
  const n = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  return candidates.slice(0, n);
}

// ---------------------------------------------------------------------------
// 预览渲染 + 还原
// ---------------------------------------------------------------------------

function renderSectionText(key: PreviewKey, value: PreviewValue): string {
  switch (key) {
    case 'profileSummary':
      return value as string;
    case 'recordExcerpts':
      return (value as string[]).map((line, index) => `${index + 1}. ${line}`).join('\n');
    case 'memories':
      return (value as string[]).map((line, index) => `${index + 1}. ${line}`).join('\n');
    case 'messages':
      return (value as ChatMessage[]).map((message) => `${ROLE_LABELS[message.role]}：${message.content}`).join('\n');
    default:
      return assertNever(key);
  }
}

function makeSection(key: PreviewKey, value: PreviewValue): PreviewSection {
  return { key, title: SECTION_TITLES[key], text: renderSectionText(key, value), value };
}

// ---------------------------------------------------------------------------
// 构建 /api/ask 请求体 + 预览
// ---------------------------------------------------------------------------

export function buildAskPayload(input: AskInput): AskBuildResult {
  const names = collectKnownNames(input.profile);
  const messages: ChatMessage[] = input.messages.map((message) => ({
    role: message.role,
    content: redactText(message.content, names),
  }));
  const payload: AskPayload = { mode: input.mode, messages, consent: true };
  const sections: PreviewSection[] = [];

  const profileSummary = redactText(renderProfileLines(input.profile).join('\n'), names);
  if (profileSummary !== '') {
    payload.profileSummary = profileSummary;
    sections.push(makeSection('profileSummary', profileSummary));
  }

  const excerpts = capByChars(
    (input.excerpts ?? []).map((excerpt) => redactText(excerpt, names)),
    MAX_RECORD_EXCERPTS_CHARS
  );
  if (excerpts.length > 0) {
    payload.recordExcerpts = excerpts;
    sections.push(makeSection('recordExcerpts', excerpts));
  }

  const enabledMemories = (input.memories ?? [])
    .filter((memory) => memory.enabled === true)
    .slice(0, MAX_MEMORY_ITEMS)
    .map((memory) => redactText(memory.text, names));
  const memories = capByChars(enabledMemories, MAX_MEMORY_CHARS);
  if (memories.length > 0) {
    payload.memories = memories;
    sections.push(makeSection('memories', memories));
  }

  sections.push(makeSection('messages', messages));

  return { payload, preview: { mode: input.mode, consent: true, sections } };
}

/** 从逐段预览还原请求体；与 `buildAskPayload().payload` 序列化后逐字节相等。 */
export function reassembleAskPayload(preview: AskPayloadPreview): AskPayload {
  const payload: AskPayload = { mode: preview.mode, messages: [], consent: true };
  for (const section of preview.sections) {
    switch (section.key) {
      case 'profileSummary':
        payload.profileSummary = section.value as string;
        break;
      case 'recordExcerpts':
        payload.recordExcerpts = section.value as string[];
        break;
      case 'memories':
        payload.memories = section.value as string[];
        break;
      case 'messages':
        payload.messages = section.value as ChatMessage[];
        break;
      default:
        assertNever(section.key);
    }
  }
  return payload;
}

/** 规范序列化（固定键序），也是 `sendAsk` 实际发送的字节串。 */
export function serializeAskPayload(payload: AskPayload): string {
  const ordered: Record<string, unknown> = { mode: payload.mode, messages: payload.messages };
  if (payload.profileSummary !== undefined) ordered.profileSummary = payload.profileSummary;
  ordered.consent = true;
  if (payload.recordExcerpts !== undefined) ordered.recordExcerpts = payload.recordExcerpts;
  if (payload.memories !== undefined) ordered.memories = payload.memories;
  return JSON.stringify(ordered);
}

// ---------------------------------------------------------------------------
// 构建 /api/extract-memory 请求体 + 预览
// ---------------------------------------------------------------------------

/** 「仅最近一轮」= 最后一条 user 消息起（含其后的助手回复）；无 user 则取最后一条。 */
export function lastRound(messages: readonly ChatMessage[]): ChatMessage[] {
  let start = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') {
      start = i;
      break;
    }
  }
  if (start === -1) return messages.length === 0 ? [] : [messages[messages.length - 1]];
  return messages.slice(start);
}

function capMessages(messages: ChatMessage[], maxChars: number): ChatMessage[] {
  const out: ChatMessage[] = messages.map((message) => ({ role: message.role, content: message.content }));
  const totalOf = (list: ChatMessage[]): number => list.reduce((sum, message) => sum + message.content.length, 0);
  while (out.length > 1 && totalOf(out) > maxChars) out.shift();
  if (out.length > 0 && totalOf(out) > maxChars) {
    const head = out[0];
    out[0] = { role: head.role, content: head.content.slice(0, maxChars) };
  }
  return out;
}

export function buildExtractMemoryPayload(input: ExtractInput): ExtractBuildResult {
  const names = collectKnownNames(input.profile);
  const round = lastRound(input.messages).map((message) => ({
    role: message.role,
    content: redactText(message.content, names),
  }));
  const messages = capMessages(round, MAX_EXTRACT_CHARS);
  const payload: ExtractPayload = { messages, consent: true };
  if (typeof input.maxItems === 'number' && Number.isFinite(input.maxItems) && input.maxItems > 0) {
    payload.maxItems = Math.min(Math.floor(input.maxItems), MAX_EXTRACT_ITEMS);
  }
  const preview: ExtractPreview = {
    consent: true,
    notice: MEMORY.autoExtractNotice,
    messages,
    text: [MEMORY.autoExtractNotice, renderSectionText('messages', messages)].join('\n'),
  };
  return { payload, preview };
}

export function serializeExtractPayload(payload: ExtractPayload): string {
  const ordered: Record<string, unknown> = { messages: payload.messages, consent: true };
  if (payload.maxItems !== undefined) ordered.maxItems = payload.maxItems;
  return JSON.stringify(ordered);
}

// ---------------------------------------------------------------------------
// 构建 /api/interview 请求体 + 预览（问诊引导 / 连续追问）
// ---------------------------------------------------------------------------

export function buildInterviewPayload(input: InterviewInput): InterviewBuildResult {
  const names = collectKnownNames(input.profile);
  const messages = capMessages(
    input.messages.map((message) => ({
      role: message.role,
      content: redactText(message.content, names),
    })),
    MAX_INTERVIEW_CHARS
  );
  const payload: InterviewPayload = { messages, consent: true };
  if (typeof input.round === 'number' && Number.isFinite(input.round) && input.round >= 0) {
    payload.round = Math.floor(input.round);
  }
  const sections: PreviewSection[] = [];

  const enabledMemories = (input.memories ?? [])
    .filter((memory) => memory.enabled === true)
    .slice(0, MAX_MEMORY_ITEMS)
    .map((memory) => redactText(memory.text, names));
  const memories = capByChars(enabledMemories, MAX_MEMORY_CHARS);
  if (memories.length > 0) {
    payload.memories = memories;
    sections.push(makeSection('memories', memories));
  }

  sections.push(makeSection('messages', messages));

  return { payload, preview: { consent: true, sections } };
}

export function serializeInterviewPayload(payload: InterviewPayload): string {
  const ordered: Record<string, unknown> = { messages: payload.messages, consent: true };
  if (payload.round !== undefined) ordered.round = payload.round;
  if (payload.memories !== undefined) ordered.memories = payload.memories;
  return JSON.stringify(ordered);
}

// ---------------------------------------------------------------------------
// 传输（唯一接触宿主请求接口的地方）
// ---------------------------------------------------------------------------

export type DegradedCode =
  | 'blocked_host'
  | 'invalid_proxy_url'
  | 'proxy_unreachable'
  | 'proxy_timeout'
  | 'proxy_error'
  | 'invalid_response';

export type AiClientErrorCode = 'blocked_host' | 'invalid_proxy_url';

export class AiClientError extends Error {
  readonly code: AiClientErrorCode;

  constructor(code: AiClientErrorCode, message: string) {
    super(message);
    this.name = 'AiClientError';
    this.code = code;
  }
}

export interface SendSkipped {
  skipped: true;
  reason: 'ai_disabled' | 'consent_required';
}

export interface SendFailed {
  ok: false;
  degraded: true;
  error: DegradedCode;
  status?: number;
}

export interface SendSuccess {
  ok: true;
  status: number;
  data: unknown;
}

export type SendResult = SendSkipped | SendFailed | SendSuccess;

export interface SendOptions {
  /** 读取 `aiEnabled`；关闭时直接返回 `{skipped:true}`，零网络。 */
  prefs: Pick<AppPreferences, 'aiEnabled'>;
  /** 必须显式 `true`；否则返回 `{skipped:true}`，零网络。 */
  consent?: boolean;
  /** 覆盖代理地址（仍受 host 白名单约束）。 */
  baseUrl?: string;
  timeoutMs?: number;
}

const PROXY_URL_RE = /^(http):\/\/([^/:?#]+)(?::(\d+))?/;

/** 解析代理 host（非法返回 null）。 */
export function proxyHostOf(baseUrl: string): string | null {
  const match = PROXY_URL_RE.exec(baseUrl.trim());
  return match === null ? null : match[2].toLowerCase();
}

/** host 白名单校验；非本机回环地址抛 `AiClientError`。 */
export function assertProxyUrl(baseUrl: string): void {
  const match = PROXY_URL_RE.exec(baseUrl.trim());
  if (match === null) {
    throw new AiClientError('invalid_proxy_url', `代理地址必须为 http://<host>[:port]：${baseUrl}`);
  }
  const host = match[2].toLowerCase();
  if (!ALLOWED_PROXY_HOSTS.includes(host)) {
    throw new AiClientError(
      'blocked_host',
      `只允许访问本机代理（${ALLOWED_PROXY_HOSTS.join(' / ')}），已拒绝：${host}`
    );
  }
}

function postToProxy(path: string, body: string, baseUrl: string, timeoutMs: number): Promise<SendResult> {
  try {
    assertProxyUrl(baseUrl);
  } catch (error) {
    const code: DegradedCode = error instanceof AiClientError ? error.code : 'invalid_proxy_url';
    return Promise.resolve({ ok: false, degraded: true, error: code });
  }

  const url = `${baseUrl.replace(/\/+$/, '')}${path}`;
  return new Promise<SendResult>((resolve) => {
    wx.request({
      url,
      method: 'POST',
      data: body,
      timeout: timeoutMs,
      header: { 'content-type': 'application/json' },
      success: (res) => {
        const status = res.statusCode;
        if (status >= 200 && status < 300) {
          try {
            const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
            resolve({ ok: true, status, data });
          } catch (error) {
            resolve({ ok: false, degraded: true, error: 'invalid_response', status });
          }
        } else {
          resolve({ ok: false, degraded: true, error: 'proxy_error', status });
        }
      },
      fail: (err) => {
        const message = err && typeof err.errMsg === 'string' ? err.errMsg : '';
        const timeout = message.indexOf('timeout') >= 0;
        resolve({ ok: false, degraded: true, error: timeout ? 'proxy_timeout' : 'proxy_unreachable' });
      },
    });
  });
}

/**
 * 发送 `/api/ask`。发送前把预览逐段还原后的字节串作为 body，保证「预览 = 发送内容」。
 * 关闭外部调用 / 未同意 → `{skipped:true}` 零网络；代理不可达 → 结构化降级，绝不伪造。
 */
export function sendAsk(input: AskInput, options: SendOptions): Promise<SendResult> {
  if (options.prefs.aiEnabled !== true) return Promise.resolve({ skipped: true, reason: 'ai_disabled' });
  if (options.consent !== true) return Promise.resolve({ skipped: true, reason: 'consent_required' });
  const { preview } = buildAskPayload(input);
  return postToProxy(
    ASK_PATH,
    serializeAskPayload(reassembleAskPayload(preview)),
    options.baseUrl ?? DEFAULT_PROXY_URL,
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  );
}

/** 发送 `/api/extract-memory`（同样经脱敏与 host 白名单）。 */
export function sendExtractMemory(input: ExtractInput, options: SendOptions): Promise<SendResult> {
  if (options.prefs.aiEnabled !== true) return Promise.resolve({ skipped: true, reason: 'ai_disabled' });
  if (options.consent !== true) return Promise.resolve({ skipped: true, reason: 'consent_required' });
  const { payload } = buildExtractMemoryPayload(input);
  return postToProxy(
    EXTRACT_PATH,
    serializeExtractPayload(payload),
    options.baseUrl ?? DEFAULT_PROXY_URL,
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  );
}

/**
 * 发送 `/api/interview`（问诊引导）。发送前把预览逐段还原后的字节串作为 body，
 * 保证「预览 = 发送内容」；关闭外部调用 / 未同意 → `{skipped:true}` 零网络，
 * 代理不可达 → 结构化降级，绝不伪造问题。
 */
export function sendInterview(input: InterviewInput, options: SendOptions): Promise<SendResult> {
  if (options.prefs.aiEnabled !== true) return Promise.resolve({ skipped: true, reason: 'ai_disabled' });
  if (options.consent !== true) return Promise.resolve({ skipped: true, reason: 'consent_required' });
  const { payload } = buildInterviewPayload(input);
  return postToProxy(
    INTERVIEW_PATH,
    serializeInterviewPayload(payload),
    options.baseUrl ?? DEFAULT_PROXY_URL,
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  );
}
