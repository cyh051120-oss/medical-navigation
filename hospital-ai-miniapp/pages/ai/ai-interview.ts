/**
 * pages/ai/ai-interview.ts — 问诊引导的纯函数（重构：从 pages/ai/ai.ts 抽出）。
 *
 * 问诊引导的状态迁移仍在页面控制器（pages/ai/ai.ts）；此处只放「问答 → 症状记录/资料/待问清单」
 * 的确定性映射，便于 node 端检查（scripts/check-ai-render.mjs）。
 */

import type { DraftForm, InterviewDraft } from './ai-types';
import { isCanonicalIso } from '../../shared/utils/time';

/** 一轮问答：问题槽位 + 问题文本 + 用户回答。 */
export interface InterviewAnswer {
  slot: string;
  question: string;
  answer: string;
}

/** 动作条可识别的口语意图；null 表示不是「保存类」指令。 */
export type SaveIntent = 'symptom' | 'note' | 'questions' | null;

/** 意图关键词（纯客户端匹配，按列表顺序：先具体后泛化，避免误判）。 */
const INTENT_KEYWORDS: { intent: Exclude<SaveIntent, null>; words: readonly string[] }[] = [
  { intent: 'questions', words: ['加进问题清单', '加入问题清单', '加入待问', '加进待问', '记成问题'] },
  { intent: 'note', words: ['摘成资料', '摘成笔记', '记成资料', '记成笔记', '存为资料', '整理成笔记', '摘录一下'] },
  { intent: 'symptom', words: ['帮我记下来', '记下来', '记录下来', '存成症状', '保存症状', '记成症状'] },
];

/** 资料摘录里槽位回填的顺序与标签。 */
const SLOT_ORDER: readonly { slot: string; label: string }[] = [
  { slot: 'onset', label: '发生时间' },
  { slot: 'duration', label: '持续时长' },
  { slot: 'impact', label: '影响' },
  { slot: 'detail', label: '补充' },
  { slot: 'tags', label: '标签' },
];

/** 取某槽位最后一次回答；无则空串。 */
function lastAnswerFor(answers: readonly InterviewAnswer[], slot: string): string {
  const rows = answers.filter((row) => row.slot === slot);
  return rows.length === 0 ? '' : rows[rows.length - 1].answer;
}

/**
 * 归一化「发生时间」契约：`occurredAt` 必须是共享权威 `isCanonicalIso` 认可的
 * ISO 8601 或空；自由文本（如「昨天晚上」）移入 `occurredAtText` 并清空
 * `occurredAt`。不复制正则，避免与服务端/记录层产生第二套判定。
 */
export function normalizeOccurredAt(value: string): { occurredAt: string; occurredAtText: string } {
  const trimmed = value.trim();
  if (trimmed === '') return { occurredAt: '', occurredAtText: '' };
  if (isCanonicalIso(trimmed)) {
    return { occurredAt: trimmed, occurredAtText: '' };
  }
  return { occurredAt: '', occurredAtText: trimmed };
}

/** 识别用户输入的「保存类」口语指令（纯本地，不外发）。 */
export function matchSaveIntent(text: string): SaveIntent {
  const value = text.trim();
  if (value === '') return null;
  for (const row of INTENT_KEYWORDS) {
    if (row.words.some((word) => value.includes(word))) return row.intent;
  }
  return null;
}

function joinNonEmpty(parts: readonly string[]): string {
  return parts
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .join('；');
}

/** 本轮主描述：优先 origin（首段原话），否则历史首条用户消息。 */
function originTextFor(
  origin: string,
  messages: readonly { role: string; content: string }[]
): string {
  const trimmed = origin.trim();
  if (trimmed !== '') return trimmed;
  const firstUser = messages
    .filter((message) => message.role === 'user')
    .map((message) => (typeof message.content === 'string' ? message.content.trim() : ''))
    .filter((value) => value !== '');
  return firstUser.length === 0 ? '' : firstUser[0];
}

/**
 * 症状主文本：origin（或首条用户消息）为骨架；若 AI 追问出的 `detail` 不在其中，则折进文本。
 * 修复点：重构前 `onset`/`detail` 被问出却整条丢弃。
 */
function symptomTextFor(
  answers: readonly InterviewAnswer[],
  origin: string,
  messages: readonly { role: string; content: string }[]
): string {
  const base = originTextFor(origin, messages);
  const detail = lastAnswerFor(answers, 'detail').trim();
  if (detail !== '' && !base.includes(detail)) return joinNonEmpty([base, detail]);
  return base;
}

/**
 * 用本轮问答预填「保存为症状记录」草稿：
 *   - text：origin / 首条用户消息，并折入 `detail` 槽回答；
 *   - occurredAt：优先 `onset` 槽回答（发生时间），无则用调用方传入的时间戳；
 *   - duration / impact / tags：分别取对应槽位最后一次回答。
 */
export function interviewDraftFor(params: {
  answers: readonly InterviewAnswer[];
  origin: string;
  messages: readonly { role: string; content: string }[];
  occurredAt: string;
}): InterviewDraft {
  const onset = lastAnswerFor(params.answers, 'onset').trim();
  return {
    text: symptomTextFor(params.answers, params.origin, params.messages),
    occurredAt: onset !== '' ? onset : params.occurredAt,
    duration: lastAnswerFor(params.answers, 'duration'),
    impact: lastAnswerFor(params.answers, 'impact'),
    tags: lastAnswerFor(params.answers, 'tags'),
  };
}

/** 本轮问答整理成可读文本：主描述一行 + 各槽位带标签一行。 */
function interviewContentFor(
  answers: readonly InterviewAnswer[],
  origin: string,
  messages: readonly { role: string; content: string }[]
): string {
  const lines: string[] = [];
  const base = symptomTextFor(answers, origin, messages);
  if (base !== '') lines.push(base);
  for (const row of SLOT_ORDER) {
    const answer = lastAnswerFor(answers, row.slot).trim();
    if (answer !== '' && !base.includes(answer)) lines.push(`${row.label}：${answer}`);
  }
  return lines.join('\n');
}

/** 用本轮问答预填「资料摘录」草稿（名称由调用方给出，固定文案不落 UI 逻辑）。 */
export function noteDraftFor(params: {
  answers: readonly InterviewAnswer[];
  origin: string;
  messages: readonly { role: string; content: string }[];
  name: string;
}): DraftForm {
  return {
    name: params.name.trim(),
    excerpt: interviewContentFor(params.answers, params.origin, params.messages),
    remark: '',
  };
}

/** 用本轮问答生成「待问清单」候选问题（中性表述，指向医生，不做诊断）。 */
export function questionCandidatesFor(params: {
  answers: readonly InterviewAnswer[];
  origin: string;
  messages: readonly { role: string; content: string }[];
}): string[] {
  const base = symptomTextFor(params.answers, params.origin, params.messages);
  if (base.trim() === '') return [];
  const short = base.length > 20 ? `${base.slice(0, 20)}…` : base;
  return [
    `「${short}」这种情况通常需要做哪些检查？`,
    '有哪些日常注意事项可以帮助缓解？',
    '出现哪些变化时需要及时就医？',
  ];
}
