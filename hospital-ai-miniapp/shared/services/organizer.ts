/**
 * shared/services/organizer.ts — 本地整理引擎（纯函数，无宿主接口、无网络）。
 *
 * 把用户输入的一段原话，按词面规则整理成可核对的片段：拆分原话、抽取时间 /
 * 数值 / 疑似药品名，并列出原话里没有交代清楚的地方和一组固定模板问题。
 *
 * 设计约束：
 *   - 纯函数：同一输入恒得同一输出；不读时钟、不用随机数、不发起网络请求。
 *   - 不依赖任何小程序宿主接口，可在 node 环境直接 import 做检查。
 *   - 只做正则 / 词面匹配，不做语义推断，不给任何判断性结论。
 *   - `points` 只保留用户原话片段，不改写、不评价。
 *
 * 结构：
 *   interface OrganizeExtraction { times: string[]; values: string[]; maybeMeds: string[] }
 *   interface OrganizeResult {
 *     original: string;
 *     points: string[];
 *     extracted: OrganizeExtraction;
 *     unknowns: string[];
 *     questions: string[];
 *   }
 *   function organize(text: string): OrganizeResult
 */

import { lexiconFor } from '../../config/lexicon';

/** 规则抽取结果。 */
export interface OrganizeExtraction {
  /** 时间类片段（如「昨天」「3 天前」「晚上」）。 */
  times: string[];
  /** 数值类片段（如「140」「38.5 度」「5 年」）。 */
  values: string[];
  /** 疑似药品 / 制剂名（词尾或已知药名模式）。 */
  maybeMeds: string[];
}

/** `organize()` 的返回结构。 */
export interface OrganizeResult {
  /** 用户原话，逐字保留。 */
  original: string;
  /** 原话按标点拆出的片段，忠实保留原措辞。 */
  points: string[];
  /** 规则抽取结果。 */
  extracted: OrganizeExtraction;
  /** 原话没有交代清楚、需要补充的地方。 */
  unknowns: string[];
  /** 固定模板问题；同一输入恒得同一组。 */
  questions: string[];
}

// ---------------------------------------------------------------------------
// 词面规则（顺序即优先级）
// ---------------------------------------------------------------------------

/** 片段分隔符：中英文标点与换行。 */
const FRAGMENT_RE = /[，。！？；、,.!?;:：\n\r]+/;

/** 时间词 / 时间表达的规则源。 */
const TIME_SOURCE =
  '今天|昨天|前天|明天|后天|每天|每周|每次|最近|一直|刚才|刚刚|' +
  '早上|上午|中午|下午|傍晚|晚上|夜里|凌晨|半夜|白天|' +
  '上个月|这个月|本月|下个月|月初|月底|年初|年底|' +
  '上周[一二三四五六日天]|这周[一二三四五六日天]?|本周[一二三四五六日天]?|下周[一二三四五六日天]?|' +
  '\\d{4}\\s*年|\\d{1,2}\\s*月\\d{1,2}\\s*[日号]|\\d{1,2}\\s*点(?:半|\\d{1,2}\\s*分)?|' +
  '\\d{1,2}\\s*(?:年|个月|周|天|小时|分钟)前';

/** 数值 + 可选单位的规则源。 */
const VALUE_SOURCE =
  '(\\d+(?:\\.\\d+)?)\\s*(度|℃|%|毫克|毫升|ml|mg|克|公斤|千克|kg|斤|岁|年|个月|周|天|小时|分钟|次|厘米|cm|毫米|mm)?';

/** 切分药品片段用的边界：标点 / 空白 / 常见动词与虚词。 */
const MED_BOUNDARY_RE =
  /[，。！？；、,.!?;:：\s]|最近|经常|长期|正在|已经|一直|每天|目前|现在|同时|另外|此外|之前|以后|有点|比较|没有|不是|只是|还是|就是|应该|需要|感觉|出现|开始|可能|在|吃|喝|服|用|买|开|停|上|涂|抹|换|了|的|和|与|及|或|还|也|都|又|再|就|要|想|给|把|被|让|从|到|我|你|他|她|它|们|这|那|些|种|个|是|不|没|有|会|能|该|得|着|过|以|为/g;

/** 疑似药品名的规则源：常见药名后缀 / 前缀模式。 */
const MED_SOURCE =
  '头孢[\\u4e00-\\u9fa5]{0,4}|[\\u4e00-\\u9fa5A-Za-z0-9]{1,6}(?:药|片|胶囊|颗粒|西林|沙星|洛尔|地平|霉素)';

/** 词尾命中但并非药名的日常动宾词。 */
const MED_STOP = new Set([
  '用药',
  '吃药',
  '服药',
  '停药',
  '开药',
  '买药',
  '换药',
  '上药',
  '涂药',
  '抹药',
  '喝药',
]);

/** 后缀规则覆盖不到的已知药品类词（经共享词表校验）。 */
const KNOWN_MED_TERMS = ['抗生素'];

/** 「已经持续多久」的线索。 */
const DURATION_RE = /持续|一直|多久|几天|几个月|几年|\d+\s*(?:天|周|个月|年|小时|分钟)/;

/** 「还有其他不舒服」的线索。 */
const OTHER_RE = /还有|其他|别的|伴随|同时|另外|此外/;

/** 未交代事项的固定模板（中性措辞，不含任何判断）。 */
const UNKNOWN_TEMPLATES = {
  time: '未提到相关情况第一次出现的时间',
  duration: '未提到相关情况持续了多久',
  meds: '未提到目前是否在服用药物',
  other: '未提到是否还有其他不舒服',
} as const;

/** 固定模板问题；同一输入恒得同一组。 */
const QUESTION_TEMPLATES = [
  '这个症状第一次出现是什么时候？',
  '除此之外还有没有其他不舒服？',
  '目前有没有在吃药？',
] as const;

// ---------------------------------------------------------------------------
// 规则实现
// ---------------------------------------------------------------------------

/** 按标点拆分原话；空段丢弃，段内去除首尾空白。 */
function splitPoints(text: string): string[] {
  return text
    .split(FRAGMENT_RE)
    .map((fragment) => fragment.trim())
    .filter((fragment) => fragment !== '');
}

/** 用 `source` 全局匹配 `text`，取匹配文本，去重保序。 */
function collectMatches(text: string, source: string): string[] {
  const out: string[] = [];
  const re = new RegExp(source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const token = m[0].trim();
    if (token !== '' && !out.includes(token)) out.push(token);
    if (m.index === re.lastIndex) re.lastIndex += 1;
  }
  return out;
}

/** 抽取数值片段；跳过作为时间表达一部分的裸数字（如「3 天前」中的 3）。 */
function collectValues(text: string): string[] {
  const out: string[] = [];
  const re = new RegExp(VALUE_SOURCE, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const whole = m[0].trim();
    const unit = m[2];
    const next = text[m.index + m[0].length];
    if (next === '前') continue;
    if (unit === undefined && next !== undefined && /[点月日号分]/.test(next)) continue;
    if (whole !== '' && !out.includes(whole)) out.push(whole);
    if (m.index === re.lastIndex) re.lastIndex += 1;
  }
  return out;
}

/** 抽取疑似药品名：先按边界切分，再匹配后缀 / 已知药名模式，最后用共享词表回补。 */
function collectMaybeMeds(text: string): string[] {
  const out: string[] = [];
  const push = (token: string): void => {
    const t = token.trim();
    if (t === '' || MED_STOP.has(t) || out.includes(t)) return;
    out.push(t);
  };
  const pieces = text.split(MED_BOUNDARY_RE);
  for (const piece of pieces) {
    for (const token of collectMatches(piece, MED_SOURCE)) push(token);
  }
  for (const term of KNOWN_MED_TERMS) {
    if (text.includes(term) && lexiconFor(term) !== undefined) push(term);
  }
  return out;
}

/** 汇总原话未交代清楚的地方（中性措辞，顺序固定）。 */
function collectUnknowns(text: string, times: string[], maybeMeds: string[]): string[] {
  const out: string[] = [];
  if (times.length === 0) out.push(UNKNOWN_TEMPLATES.time);
  if (!DURATION_RE.test(text)) out.push(UNKNOWN_TEMPLATES.duration);
  if (maybeMeds.length === 0) out.push(UNKNOWN_TEMPLATES.meds);
  if (!OTHER_RE.test(text)) out.push(UNKNOWN_TEMPLATES.other);
  return out;
}

/**
 * 整理一段原话。
 *
 * 确定性：同一输入恒得同一输出。所有字段只来自词面规则，不含任何判断、
 * 推荐或严重程度分级；`questions` 为固定模板。
 */
export function organize(text: string): OrganizeResult {
  const points = splitPoints(text);
  const times = collectMatches(text, TIME_SOURCE);
  const values = collectValues(text);
  const maybeMeds = collectMaybeMeds(text);
  const unknowns = collectUnknowns(text, times, maybeMeds);
  const questions = QUESTION_TEMPLATES.slice();

  return {
    original: text,
    points,
    extracted: { times, values, maybeMeds },
    unknowns,
    questions,
  };
}
