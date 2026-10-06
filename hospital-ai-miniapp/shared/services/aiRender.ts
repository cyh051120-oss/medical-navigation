/**
 * shared/services/aiRender.ts — AI 助手页的纯渲染 / 解析层（重构：从 pages/ai/ai.ts 抽出）。
 *
 * 设计约束：
 *   - 全部为纯函数：不读时钟、不用随机数、不接触任何宿主接口（无网络、无存储），
 *     可在 node 环境直接 import 做检查。
 *   - 输入是已经拿到的服务端 JSON / 本地整理结果，输出是 wxml 直接消费的渲染结构（AiBlock）。
 *   - 只做「形状归一化 + 展示拼装」，不做任何字段改写或判断。
 *
 * 行为与原 `pages/ai/ai.ts` 完全一致（逐函数迁移）。
 */

import { AI, DEMO } from '../../config/texts';
import type { ExcerptKind, InterviewQuestion } from './aiClient';
import type { OrganizeResult } from './organizer';
import type { LocalProfile } from './records';

/** 每条消息「存为记忆」文案的最大长度。 */
const MEMORY_TEXT_MAX = 100;

/** 一个可渲染条目：主文本 + 副行（来源/标签）+ 链接 + 角标。 */
export interface AiBlockItem {
  text: string;
  sub: string;
  url: string;
  tag: string;
}

/** 一个渲染块；`note`/`ask` 决定条目是否可「存为资料 / 加入待问清单」。 */
export interface AiBlock {
  type: string;
  title: string;
  items: AiBlockItem[];
  /** 本块条目可保存为资料摘录。 */
  note?: boolean;
  /** 本块条目可加入待问清单。 */
  ask?: boolean;
}

/** 顶部状态条状态：未开启 / 待发送 / 上次成功 / 代理离线 / 本地兜底 / 演示模式。 */
export type AiStatus = 'disabled' | 'idle' | 'ok' | 'offline' | 'local' | 'demo';

export function statusTextFor(status: AiStatus): string {
  if (status === 'disabled') return AI.statusDisabled;
  if (status === 'ok') return AI.statusOk;
  if (status === 'offline') return AI.statusOffline;
  if (status === 'local') return AI.statusLocal;
  if (status === 'demo') return DEMO.statusDemo;
  return AI.statusIdle;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function blockItem(text: string, sub = '', url = '', tag = ''): AiBlockItem {
  return { text, sub, url, tag };
}

function listBlock(type: string, title: string, values: string[]): AiBlock | null {
  const items = values
    .map((value) => value.trim())
    .filter((value) => value !== '')
    .map((value) => blockItem(value));
  if (items.length === 0) return null;
  return { type, title, items };
}

function pushBlock(blocks: AiBlock[], block: AiBlock | null): void {
  if (block !== null) blocks.push(block);
}

function withFlags(block: AiBlock | null, flags: { note?: boolean; ask?: boolean }): AiBlock | null {
  if (block === null) return null;
  return { ...block, ...flags };
}

export function kindLabel(kind: ExcerptKind): string {
  if (kind === 'symptom') return AI.kindSymptom;
  if (kind === 'note') return AI.kindNote;
  return AI.kindQuestion;
}

export function profileContributes(profile: LocalProfile | null): boolean {
  if (profile === null) return false;
  const fields = [profile.ageRange, profile.gender ?? '', profile.allergies, profile.medications, profile.history];
  return fields.some((field) => typeof field === 'string' && field.trim() !== '');
}

function citationParts(citation: unknown): { sub: string; url: string } {
  if (!isRecord(citation)) return { sub: '', url: '' };
  const title = typeof citation.title === 'string' ? citation.title : '';
  const domain = typeof citation.domain === 'string' ? citation.domain : '';
  const url = typeof citation.url === 'string' ? citation.url : '';
  const parts: string[] = [];
  if (title !== '') parts.push(AI.citationPrefix + title);
  if (domain !== '') parts.push(domain);
  return { sub: parts.join(' · '), url };
}

export function isRedFlag(data: unknown): boolean {
  return isRecord(data) && data.redFlag === true;
}

/**
 * 判定 JSON 是否来自演示/固定 fixture（服务端 `/api/health` 的 `demo`/`demoMode`，
 * 或响应体自带的 `demo` 标记）。用于避免把演示内容当作真实模型输出展示。
 */
export function demoFlagOf(data: unknown): boolean {
  if (!isRecord(data)) return false;
  return data.demo === true || data.demoMode === true;
}

/** 检索不可用（尚未取到权威资料）时的提示；其余零命中情形复用 AI.noAuthorityNotice。 */
const SEARCH_UNAVAILABLE_NOTICE = '当前无法获取权威资料，请向医生确认。';

function searchNoticeFor(reason: string): string {
  if (reason === 'search_unavailable' || reason === 'not_configured') return SEARCH_UNAVAILABLE_NOTICE;
  return AI.noAuthorityNotice;
}

/**
 * 服务端业务错误信封（HTTP 200）识别：`{ error: string, message: string, fallback? }`。
 * 成功响应（organize/consult/redflag）不含 `error` 字段，故空 code 表示「非错误」。
 */
export function serverErrorEnvelope(data: unknown): { code: string; fallback: string | undefined } {
  if (!isRecord(data) || typeof data.error !== 'string' || data.error === '') {
    return { code: '', fallback: undefined };
  }
  return { code: data.error, fallback: typeof data.fallback === 'string' ? data.fallback : undefined };
}

/** 把服务端的追问渲染成一个块（复用现有通用渲染，无需改 wxml）。 */
export function interviewBlocks(question: InterviewQuestion, round: number): AiBlock[] {
  const text = typeof question.text === 'string' ? question.text.trim() : '';
  if (text === '') return [];
  return [
    {
      type: 'list',
      title: `${AI.interviewRoundPrefix}${round}${AI.interviewRoundUnit}`,
      items: [blockItem(text)],
    },
  ];
}

/** 标签输入（逗号/顿号/空白分隔）→ 去空去重数组。 */
export function splitTags(value: string): string[] {
  const parts = value
    .split(/[,，、\s]+/)
    .map((part) => part.trim())
    .filter((part) => part !== '');
  return Array.from(new Set(parts));
}

/** 读取服务端追问响应中的问题；非法返回 null。 */
export function interviewQuestionOf(data: unknown): InterviewQuestion | null {
  const root = isRecord(data) ? data : {};
  if (root.status !== 'ask') return null;
  const question = isRecord(root.question) ? root.question : {};
  const text = typeof question.text === 'string' ? question.text.trim() : '';
  const slot = typeof question.slot === 'string' ? question.slot.trim() : '';
  if (text === '' || slot === '') return null;
  return { text, slot };
}

export function organizeBlocks(data: unknown): AiBlock[] {
  const root = isRecord(data) ? data : {};
  const extracted = isRecord(root.extracted) ? root.extracted : {};
  const blocks: AiBlock[] = [];
  pushBlock(blocks, withFlags(listBlock('list', AI.sectionPoints, stringArray(root.points)), { note: true }));
  const extractedItems: AiBlockItem[] = [];
  const groups: [unknown, string][] = [
    [extracted.symptoms, AI.extractedSymptoms],
    [extracted.medications, AI.extractedMedications],
    [extracted.allergies, AI.extractedAllergies],
    [extracted.history, AI.extractedHistory],
    [extracted.exams, AI.extractedExams],
  ];
  for (const [value, label] of groups) {
    for (const text of stringArray(value)) extractedItems.push(blockItem(text, '', '', label));
  }
  if (extractedItems.length > 0) blocks.push({ type: 'extracted', title: AI.sectionExtracted, items: extractedItems, note: true });
  pushBlock(blocks, listBlock('list', AI.sectionUnknowns, stringArray(root.unknowns)));
  pushBlock(blocks, withFlags(listBlock('list', AI.sectionQuestions, stringArray(root.questions)), { ask: true }));
  return blocks;
}

export function consultBlocks(data: unknown): { blocks: AiBlock[]; disclaimer: string } {
  const root = isRecord(data) ? data : {};
  const blocks: AiBlock[] = [];
  const directions = Array.isArray(root.directions) ? root.directions : [];
  const directionItems: AiBlockItem[] = [];
  for (const direction of directions) {
    const row = isRecord(direction) ? direction : {};
    const text = typeof row.text === 'string' ? row.text.trim() : '';
    if (text === '') continue;
    const citation = citationParts(row.citation);
    directionItems.push(blockItem(text, citation.sub, citation.url));
  }
  if (directionItems.length > 0) blocks.push({ type: 'directions', title: AI.sectionDirections, items: directionItems, note: true });

  pushBlock(blocks, listBlock('list', AI.sectionDepartments, stringArray(root.suggestedDepartments)));

  const citations = Array.isArray(root.citations) ? root.citations : [];
  const citationItems: AiBlockItem[] = [];
  for (const citation of citations) {
    const row = isRecord(citation) ? citation : {};
    const title = typeof row.title === 'string' ? row.title : '';
    if (title === '') continue;
    citationItems.push(blockItem(title, typeof row.domain === 'string' ? row.domain : '', typeof row.url === 'string' ? row.url : ''));
  }
  if (citationItems.length > 0) {
    blocks.push({ type: 'citations', title: AI.sectionCitations, items: citationItems });
  } else {
    const reason =
      typeof root.degraded === 'string'
        ? root.degraded
        : typeof root.searchReason === 'string'
          ? root.searchReason
          : '';
    blocks.push({ type: 'notice', title: AI.sectionSourcesNotice, items: [blockItem(searchNoticeFor(reason))] });
  }

  const suggestions = Array.isArray(root.suggestions) ? root.suggestions : [];
  const suggestionItems: AiBlockItem[] = [];
  for (const suggestion of suggestions) {
    const row = isRecord(suggestion) ? suggestion : {};
    const text = typeof row.text === 'string' ? row.text.trim() : '';
    if (text === '') continue;
    const citation = citationParts(row.citation);
    suggestionItems.push(blockItem(text, citation.sub, citation.url, AI.nonAdvice));
  }
  if (suggestionItems.length > 0) blocks.push({ type: 'suggestions', title: AI.sectionSuggestions, items: suggestionItems, note: true });

  pushBlock(blocks, listBlock('list', AI.sectionUnknowns, stringArray(root.unknowns)));
  pushBlock(blocks, withFlags(listBlock('list', AI.sectionQuestions, stringArray(root.questions)), { ask: true }));
  return { blocks, disclaimer: typeof root.disclaimer === 'string' ? root.disclaimer : '' };
}

export function redflagResult(data: unknown): { blocks: AiBlock[]; disclaimer: string } {
  const root = isRecord(data) ? data : {};
  const notice = typeof root.safetyNotice === 'string' ? root.safetyNotice : '';
  const blocks: AiBlock[] = notice === '' ? [] : [{ type: 'notice', title: AI.redflagTitle, items: [blockItem(notice)] }];
  return { blocks, disclaimer: typeof root.disclaimer === 'string' ? root.disclaimer : '' };
}

export function localOrganizeBlocks(result: OrganizeResult): AiBlock[] {
  const blocks: AiBlock[] = [];
  pushBlock(blocks, withFlags(listBlock('list', AI.sectionPoints, result.points), { note: true }));
  const extractedItems: AiBlockItem[] = [];
  for (const text of result.extracted.times) extractedItems.push(blockItem(text, '', '', AI.extractedTimes));
  for (const text of result.extracted.values) extractedItems.push(blockItem(text, '', '', AI.extractedValues));
  for (const text of result.extracted.maybeMeds) extractedItems.push(blockItem(text, '', '', AI.extractedMeds));
  if (extractedItems.length > 0) blocks.push({ type: 'extracted', title: AI.sectionExtracted, items: extractedItems, note: true });
  pushBlock(blocks, listBlock('list', AI.sectionUnknowns, result.unknowns));
  pushBlock(blocks, withFlags(listBlock('list', AI.sectionQuestions, result.questions), { ask: true }));
  return blocks;
}

export function summarize(blocks: AiBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    for (const item of block.items) parts.push(item.text);
  }
  const text = parts.join('；').trim();
  return text.length > MEMORY_TEXT_MAX ? text.slice(0, MEMORY_TEXT_MAX) : text;
}

/**
 * 把渲染块拼成纯文本（不截断）。用于把助手历史回传上游，保持多轮语境；
 * 与 `summarize`（截断到 MEMORY_TEXT_MAX 的「存记忆」文案）用途不同。
 */
export function blocksToText(blocks: readonly AiBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    for (const item of block.items) {
      if (item.text !== '') parts.push(item.text);
    }
  }
  return parts.join('；');
}

export function extractCandidates(data: unknown): string[] {
  if (!isRecord(data)) return [];
  const candidates = Array.isArray(data.candidates) ? data.candidates : [];
  const out: string[] = [];
  for (const candidate of candidates) {
    const row = isRecord(candidate) ? candidate : {};
    if (typeof row.text === 'string' && row.text.trim() !== '') out.push(row.text.trim());
  }
  return out;
}
