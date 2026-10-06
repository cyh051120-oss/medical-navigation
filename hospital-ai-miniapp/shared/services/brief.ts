/**
 * shared/services/brief.ts — 就医摘要组装与剪贴板导出。
 *
 * 把用户自己选择的本地记录（个人档案 / 症状 / 资料摘录 / 待问问题）组装成
 * 一份结构化纯文本，供用户自行复制给他人参考。只做忠实汇总与排版：
 *   - 不判断轻重缓急，不给任何结论，不生成新的内容。
 *   - 缺失的字段一律省略对应行或整个小节，绝不补写。
 *
 * 设计约束：
 *   - `build()` 为纯函数：同一输入恒得同一输出；不读时钟、不用随机数、不发网络请求。
 *   - `build()` 不接触任何小程序宿主接口，可在 node 环境直接 import 做检查。
 *   - 仅 `toClipboard()` 调用宿主剪贴板接口。
 *
 * 文本结构（section 顺序固定，缺数据的小节整体省略；小节之间空行分隔）：
 *   【称呼/年龄段】
 *   称呼：<name>
 *   年龄段：<ageRange>
 *
 *   【症状时间线】
 *   <发生时间> <text>（持续 <duration>；影响 <impact>；标签 <t1、t2>）
 *
 *   【用药】
 *   长期用药：<medications>
 *
 *   【过敏/既往】
 *   过敏：<allergies>
 *   既往情况：<history>
 *
 *   【资料摘录】
 *   <name>：<excerpt>（来源日期 <sourceDate>；备注 <remark>）
 *
 *   【待问问题】
 *   [ ] <text>
 *   [x] <text>
 *
 * 细则：
 *   - 行内附加信息（持续 / 影响 / 标签 / 来源日期 / 备注）仅在字段非空时出现；
 *     字段为空时不渲染该段，不写占位符。
 *   - 症状按 `occurredAt`（UTC+8 本地化显示）升序；不可解析时回退 `createdAt`，
 *     再不行回退 0；同键保持输入顺序（稳定）。
 *   - 待问问题保持输入顺序，逐条带上完成状态（`[x]` 已完成 / `[ ]` 未完成）。
 *   - `sourceIds` 为实际渲染用到的记录 id，按小节出现顺序去重。
 *   - 空选择：`text` 为 `EMPTY.brief`，`sections` 与 `sourceIds` 均为空数组。
 */

import type { DocumentNote, LocalProfile, QuestionList, SymptomEntry } from './records';
import { EMPTY } from '../../config/texts';
import { formatStamp } from '../utils/time';

/** 组装所用的记录选择；每个字段都可缺省。 */
export interface BriefSelection {
  profile?: LocalProfile | null;
  symptoms?: SymptomEntry[];
  notes?: DocumentNote[];
  questionLists?: QuestionList[];
}

/** 一个文本小节：标题 + 文本行 + 该小节用到的记录 id。 */
export interface BriefSection {
  title: string;
  lines: string[];
  sourceIds: string[];
}

/** `build()` 的返回结构。 */
export interface BriefBuildResult {
  /** 供复制 / 导出的完整纯文本。 */
  text: string;
  /** 实际用到的记录 id，按小节出现顺序去重。 */
  sourceIds: string[];
  /** 已渲染的小节（仅包含有内容的小节）。 */
  sections: BriefSection[];
}

/** 固定的小节标题与顺序。 */
const SECTION_TITLES = {
  profile: '称呼/年龄段',
  symptoms: '症状时间线',
  medications: '用药',
  allergies: '过敏/既往',
  notes: '资料摘录',
  questions: '待问问题',
} as const;

/** 非空判断：非空白字符串才算「有内容」。 */
function isFilled(value: string): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

/** 排序键：优先 occurredAt，不可解析时回退 createdAt，再不行回退 0（确定性）。 */
function symptomSortMs(symptom: SymptomEntry): number {
  const occurred = Date.parse(symptom.occurredAt);
  if (Number.isFinite(occurred)) return occurred;
  const created = Date.parse(symptom.createdAt);
  return Number.isFinite(created) ? created : 0;
}

/** 症状行：保留用户原话逐字不变，附加信息按需追加。 */
function symptomLine(symptom: SymptomEntry): string {
  const extras: string[] = [];
  if (isFilled(symptom.duration)) extras.push(`持续 ${symptom.duration}`);
  if (isFilled(symptom.impact)) extras.push(`影响 ${symptom.impact}`);
  const tags = symptom.tags.filter((tag) => isFilled(tag));
  if (tags.length > 0) extras.push(`标签 ${tags.join('、')}`);
  const stamp = formatStamp(symptom.occurredAt);
  const rawText = isFilled(symptom.occurredAtText ?? '') ? (symptom.occurredAtText as string) : '';
  const when = stamp !== '' ? stamp : rawText;
  const head = when !== '' ? `${when} ${symptom.text}` : symptom.text;
  return extras.length > 0 ? `${head}（${extras.join('；')}）` : head;
}

/** 资料摘录行；无可渲染内容时返回 `null`（该条被省略）。 */
function noteLine(note: DocumentNote): string | null {
  const name = isFilled(note.name) ? note.name : '';
  const excerpt = isFilled(note.excerpt) ? note.excerpt : '';
  let head = '';
  if (name !== '' && excerpt !== '') head = `${name}：${excerpt}`;
  else if (name !== '') head = name;
  else head = excerpt;

  const extras: string[] = [];
  if (isFilled(note.sourceDate)) extras.push(`来源日期 ${note.sourceDate}`);
  if (isFilled(note.remark)) extras.push(`备注 ${note.remark}`);

  if (head === '' && extras.length === 0) return null;
  if (extras.length === 0) return head;
  return head === '' ? extras.join('；') : `${head}（${extras.join('；')}）`;
}

/** 把已渲染小节拼成纯文本，小节之间空行分隔。 */
function renderSections(sections: BriefSection[]): string {
  return sections
    .map((section) => [`【${section.title}】`, ...section.lines].join('\n'))
    .join('\n\n');
}

/** 按小节出现顺序汇总并去重记录 id。 */
function collectSourceIds(sections: BriefSection[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const section of sections) {
    for (const id of section.sourceIds) {
      if (typeof id === 'string' && id !== '' && !seen.has(id)) {
        seen.add(id);
        ordered.push(id);
      }
    }
  }
  return ordered;
}

/**
 * 组装就医摘要。纯函数，无宿主接口依赖。
 * 空选择返回明确空态，不生成任何小节或行。
 */
export function build(selection: BriefSelection): BriefBuildResult {
  const profile = selection.profile ?? null;
  const symptoms = selection.symptoms ?? [];
  const notes = selection.notes ?? [];
  const questionLists = selection.questionLists ?? [];

  const sections: BriefSection[] = [];

  // 1. 称呼 / 年龄段
  if (profile !== null) {
    const lines: string[] = [];
    if (isFilled(profile.name)) lines.push(`称呼：${profile.name}`);
    if (isFilled(profile.ageRange)) lines.push(`年龄段：${profile.ageRange}`);
    if (lines.length > 0) {
      sections.push({ title: SECTION_TITLES.profile, lines, sourceIds: [profile.id] });
    }
  }

  // 2. 症状时间线（occurredAt 升序；不可解析回退 createdAt；同键保持输入顺序）
  const orderedSymptoms = symptoms
    .map((symptom, index) => ({ symptom, index, sortMs: symptomSortMs(symptom) }))
    .sort((a, b) => {
      if (a.sortMs !== b.sortMs) return a.sortMs - b.sortMs;
      return a.index - b.index;
    })
    .map((entry) => entry.symptom)
    .filter((symptom) => isFilled(symptom.text));
  if (orderedSymptoms.length > 0) {
    sections.push({
      title: SECTION_TITLES.symptoms,
      lines: orderedSymptoms.map(symptomLine),
      sourceIds: orderedSymptoms.map((symptom) => symptom.id),
    });
  }

  // 3. 用药（来自个人档案）
  if (profile !== null && isFilled(profile.medications)) {
    sections.push({
      title: SECTION_TITLES.medications,
      lines: [`长期用药：${profile.medications}`],
      sourceIds: [profile.id],
    });
  }

  // 4. 过敏 / 既往（来自个人档案）
  if (profile !== null) {
    const lines: string[] = [];
    if (isFilled(profile.allergies)) lines.push(`过敏：${profile.allergies}`);
    if (isFilled(profile.history)) lines.push(`既往情况：${profile.history}`);
    if (lines.length > 0) {
      sections.push({ title: SECTION_TITLES.allergies, lines, sourceIds: [profile.id] });
    }
  }

  // 5. 资料摘录
  const noteLines: string[] = [];
  const noteIds: string[] = [];
  for (const note of notes) {
    const line = noteLine(note);
    if (line === null) continue;
    noteLines.push(line);
    noteIds.push(note.id);
  }
  if (noteLines.length > 0) {
    sections.push({ title: SECTION_TITLES.notes, lines: noteLines, sourceIds: noteIds });
  }

  // 6. 待问问题（输入顺序，携带完成状态）
  const questionLines: string[] = [];
  const questionIds: string[] = [];
  for (const question of questionLists) {
    if (!isFilled(question.text)) continue;
    const mark = question.done === true ? '[x]' : '[ ]';
    questionLines.push(`${mark} ${question.text}`);
    questionIds.push(question.id);
  }
  if (questionLines.length > 0) {
    sections.push({ title: SECTION_TITLES.questions, lines: questionLines, sourceIds: questionIds });
  }

  if (sections.length === 0) {
    return { text: EMPTY.brief, sourceIds: [], sections: [] };
  }

  return { text: renderSections(sections), sourceIds: collectSourceIds(sections), sections };
}

/**
 * 复制文本到剪贴板。仅使用宿主剪贴板接口，成功时 resolve，失败时 reject。
 * 文本在调用前已由 `build()` 准备好，本函数不改动内容。
 */
export function toClipboard(text: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    wx.setClipboardData({
      data: text,
      success: () => resolve(),
      fail: (error) => reject(error),
    });
  });
}
