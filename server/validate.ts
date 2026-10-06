// server/validate.ts
// 双模式输出确定性校验 + schema 白名单重建（任务 25）。
//
// 契约：
//   - 输出类型（OrganizeResult / ConsultResult / Citation…）在此定义，编排器再导出。
//   - validateOrganizeOutput(raw) / validateConsultOutput(raw, options) 均为纯函数，
//     返回 `{ ok: true, value }` 或 `{ ok: false, reason }`（reason 仅内部使用，绝不回显）。
//   - schema 白名单：只有已知字段会被重建进结果；模型返回的任何额外字段（例如 narrative
//     自由文本病情叙述）一律丢弃，永不回传。
//   - 受限词：见 DECISION_TERMS / REFERRAL_TERMS / SELF_MEDICATION_TERMS，按字段范围应用。
//     注意（T25 修订）：受限词只作用于「结论/建议性」字段（organize.points、direction.text、
//     suggestion.text）。`unknowns` / `questions` 在语义上就是「缺失信息 / 待问医生的问题」，
//     「剂量未说明」「未提供诊断信息」这类中性缺失描述会自然出现，不判违规——否则会误杀整单。
//     注意（T25 二次修订）：organize.points 对受限词改为「仅拦断言式」——受限词邻近出现中性缺失
//     标记（不确定/未说明/待确认/是否…，见 NEUTRAL_MARKERS）时视为「复述用户的信息缺口」，放行；
//     无中性标记的断言（如「剂量应为…」「确诊为…」）仍拦截。direction/suggestion 保持严格不变。
//   - 长度：direction.text ≤20 字；suggestion.text ≤40 字。
//   - 引用解析：citation 必须与「本次请求已获取的搜索结果」某一 URL 去空白后完全相等，
//     且域名通过权威白名单（isAuthorityUrl）。否则校验失败。
//   - 受控科室：suggestedDepartments 每项必须属于 CONTROLLED_DEPARTMENTS（否则失败）。
//
// 失败时调用方（编排器）统一转为 `{error:'unsafe_output', fallback:'organize'}`，且不携带任何模型文本。
//
// 本模块纯函数、无副作用、无网络、无磁盘 I/O。
// 约束：可擦除语法；仅类型导入使用 `import type`。

import type { SearchResult } from './providers/search.ts';
import { isAuthorityUrl } from './authorities.ts';
import { CONSULT_DISCLAIMER, CONTROLLED_DEPARTMENTS } from './prompts.ts';

// ---------------------------------------------------------------------------
// 输出契约类型
// ---------------------------------------------------------------------------

export type Citation = {
  title: string;
  url: string;
  domain: string;
};

export type OrganizeExtracted = {
  symptoms: string[];
  medications: string[];
  allergies: string[];
  history: string[];
  exams: string[];
};

export type OrganizeResult = {
  points: string[];
  extracted: OrganizeExtracted;
  unknowns: string[];
  questions: string[];
};

export type ConsultDirection = {
  text: string;
  citation: Citation;
};

export type ConsultSuggestion = {
  text: string;
  citation: Citation;
};

export type ConsultResult = {
  directions: ConsultDirection[];
  suggestedDepartments: string[];
  citations: Citation[];
  suggestions: ConsultSuggestion[];
  unknowns: string[];
  questions: string[];
  disclaimer: string;
};

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; reason: string };

export type ConsultValidationOptions = {
  /** 本次请求实际获取到的搜索结果（已按权威域名过滤）。 */
  sources: readonly SearchResult[];
  /** 生效的权威域名清单（用于 citation 域名二次校验）。 */
  authorityDomains: readonly string[];
};

// ---------------------------------------------------------------------------
// 受限词（按字段范围应用）
// ---------------------------------------------------------------------------

/** 通用医疗判断词：任何输出字段出现即失败。（导出供任务 43 记忆提炼复用；行为不变。） */
export const DECISION_TERMS: readonly string[] = ['确诊', '诊断', '处方', '疗效', '剂量', '治愈', '拨打', '120'];

/** 推荐性字段（direction.text）额外禁止：具体医生/医院/挂号等。（导出供任务 43 复用。） */
export const REFERRAL_TERMS: readonly string[] = ['医生', '医院', '挂号', '大夫', '主任', '专家'];

/** 通用生活/照护提示（suggestion.text）额外禁止的个性化用药指令。（导出供任务 43 复用。） */
export const SELF_MEDICATION_TERMS: readonly string[] = ['服用', '口服', '停药', '加量', '减量', '换药', '毫克', 'mg', '遵医嘱'];

const MAX_DIRECTION_CHARS = 20;
const MAX_SUGGESTION_CHARS = 40;

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function fail(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}

/** 读取字符串数组；非数组或含非字符串项 → null（视为格式错误）。 */
function readStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return null;
    out.push(item);
  }
  return out;
}

function findBanned(text: string, terms: readonly string[]): string | null {
  for (const term of terms) {
    if (text.includes(term)) return term;
  }
  return null;
}

/**
 * 中性缺失 / 不确定标记（T25 二次修订）。受限词邻近出现这些词时，视为「复述用户的信息缺口」，
 * 而非模型断言（如「剂量不确定」「诊断未说明」），organize.points 予以放行。
 */
const NEUTRAL_MARKERS: readonly string[] = [
  '不确定',
  '未说明',
  '未提供',
  '未注明',
  '未告知',
  '未明确',
  '不明确',
  '不清楚',
  '不详',
  '待确认',
  '待定',
  '待补充',
  '未知',
  '是否',
  '需咨询',
  '咨询医生',
  '问医生',
];

/** 受限词邻近窗口（字符数）：窗口内出现任一中性标记，即视为「中性出现」。 */
const NEUTRAL_WINDOW = 8;

/**
 * 判定受限词是否为「断言式」出现：逐次定位受限词，检查其前后 ±NEUTRAL_WINDOW 字符窗口，
 * 窗口内无任何中性标记 → 断言式，返回该词；否则继续。全部为中性出现 → null。
 */
function findAssertiveTerm(text: string, terms: readonly string[]): string | null {
  for (const term of terms) {
    let idx = text.indexOf(term);
    while (idx !== -1) {
      const start = Math.max(0, idx - NEUTRAL_WINDOW);
      const end = Math.min(text.length, idx + term.length + NEUTRAL_WINDOW);
      const context = text.slice(start, end);
      if (!NEUTRAL_MARKERS.some((marker) => context.includes(marker))) return term;
      idx = text.indexOf(term, idx + term.length);
    }
  }
  return null;
}

/** 对若干文本扫描「断言式」受限词；返回首个命中词或 null。 */
function scanAssertiveTexts(texts: readonly string[], terms: readonly string[]): string | null {
  for (const text of texts) {
    const hit = findAssertiveTerm(text, terms);
    if (hit !== null) return hit;
  }
  return null;
}

/**
 * 解析 citation：必须是本次已获取来源中的某个 URL（去空白后完全相等），
 * 且域名通过权威白名单。返回规范化引用（title/url/domain 取自已获取来源，不信任模型）。
 */
function resolveCitation(
  value: unknown,
  sourceByUrl: ReadonlyMap<string, SearchResult>,
  domains: readonly string[]
): Citation | null {
  if (typeof value !== 'string') return null;
  const url = value.trim();
  if (url === '') return null;
  const source = sourceByUrl.get(url);
  if (source === undefined) return null;
  if (!isAuthorityUrl(source.url, domains)) return null;
  return { title: source.title, url: source.url, domain: source.domain };
}

// ---------------------------------------------------------------------------
// organize
// ---------------------------------------------------------------------------

/**
 * 校验并重建 organize 输出。仅保留 points/extracted/unknowns/questions。
 * 未知字段丢弃；points 走「断言式」受限词扫描（中性缺失描述放行）；unknowns/questions 完全豁免；
 * extracted 仅做类型规整。
 */
export function validateOrganizeOutput(raw: unknown): ValidationResult<OrganizeResult> {
  const rec = asRecord(raw);
  const points = readStringArray(rec.points);
  const unknowns = readStringArray(rec.unknowns);
  const questions = readStringArray(rec.questions);
  if (points === null) return fail('points 缺失或格式错误');
  if (unknowns === null) return fail('unknowns 缺失或格式错误');
  if (questions === null) return fail('questions 缺失或格式错误');
  if (rec.extracted === undefined || rec.extracted === null) return fail('extracted 缺失');

  const extractedRec = asRecord(rec.extracted);
  const extracted: OrganizeExtracted = {
    symptoms: readStringArray(extractedRec.symptoms) ?? [],
    medications: readStringArray(extractedRec.medications) ?? [],
    allergies: readStringArray(extractedRec.allergies) ?? [],
    history: readStringArray(extractedRec.history) ?? [],
    exams: readStringArray(extractedRec.exams) ?? [],
  };

  // 只对「资料要点」做「断言式」受限词扫描：中性复述（如「剂量不确定」）放行，
  // 断言（如「剂量应为…」「确诊为…」）拦截；unknowns / questions 是「缺失项 / 待问问题」，完全豁免。
  const hit = scanAssertiveTexts(points, DECISION_TERMS);
  if (hit !== null) return fail(`输出含受限词：${hit}`);

  return { ok: true, value: { points, extracted, unknowns, questions } };
}

// ---------------------------------------------------------------------------
// consult
// ---------------------------------------------------------------------------

/**
 * 校验并重建 consult 输出。citations 由解析成功的引用去重生成（不信任模型的 citations 字段）。
 */
export function validateConsultOutput(
  raw: unknown,
  options: ConsultValidationOptions
): ValidationResult<ConsultResult> {
  const rec = asRecord(raw);
  const rawDirections = rec.directions;
  if (!Array.isArray(rawDirections)) return fail('directions 缺失或非数组');

  const sourceByUrl = new Map<string, SearchResult>();
  for (const source of options.sources) sourceByUrl.set(source.url.trim(), source);

  const citations: Citation[] = [];
  const citationIndex = new Map<string, Citation>();
  const directions: ConsultDirection[] = [];

  for (const item of rawDirections) {
    const direction = asRecord(item);
    const text = typeof direction.text === 'string' ? direction.text.trim() : null;
    if (text === null || text === '') return fail('direction.text 缺失');
    if (text.length > MAX_DIRECTION_CHARS) return fail('direction 超长');
    const banned = findBanned(text, [...DECISION_TERMS, ...REFERRAL_TERMS]);
    if (banned !== null) return fail(`direction 含受限词：${banned}`);
    const citation = resolveCitation(direction.citation, sourceByUrl, options.authorityDomains);
    if (citation === null) return fail('direction 引用无效');
    directions.push({ text, citation });
    if (!citationIndex.has(citation.url)) {
      citationIndex.set(citation.url, citation);
      citations.push(citation);
    }
  }

  const rawDepartments = rec.suggestedDepartments;
  if (!Array.isArray(rawDepartments)) return fail('suggestedDepartments 缺失或非数组');
  const departments: string[] = [];
  for (const rawName of rawDepartments) {
    if (typeof rawName !== 'string') return fail('suggestedDepartments 含非字符串');
    const name = rawName.trim();
    if (name === '') continue;
    if (!CONTROLLED_DEPARTMENTS.includes(name)) return fail('科室不在受控清单');
    if (!departments.includes(name)) departments.push(name);
  }

  const suggestions: ConsultSuggestion[] = [];
  const rawSuggestions = rec.suggestions;
  if (rawSuggestions !== undefined && rawSuggestions !== null) {
    if (!Array.isArray(rawSuggestions)) return fail('suggestions 非数组');
    for (const item of rawSuggestions) {
      const suggestion = asRecord(item);
      const text = typeof suggestion.text === 'string' ? suggestion.text.trim() : null;
      if (text === null || text === '') return fail('suggestion.text 缺失');
      if (text.length > MAX_SUGGESTION_CHARS) return fail('suggestion 超长');
      const banned =
        findBanned(text, DECISION_TERMS) ?? findBanned(text, SELF_MEDICATION_TERMS);
      if (banned !== null) return fail(`suggestion 含受限词：${banned}`);
      const citation = resolveCitation(suggestion.citation, sourceByUrl, options.authorityDomains);
      if (citation === null) return fail('suggestion 引用无效');
      suggestions.push({ text, citation });
    }
  }

  const unknowns = readStringArray(rec.unknowns);
  const questions = readStringArray(rec.questions);
  if (unknowns === null) return fail('unknowns 缺失或格式错误');
  if (questions === null) return fail('questions 缺失或格式错误');
  // unknowns / questions 是「缺失项 / 待问医生的问题」，允许出现「剂量/诊断」等中性缺失描述；
  // 结论/建议性字段（direction、suggestion）的受限词校验保持不变（见上方循环）。

  return {
    ok: true,
    value: {
      directions,
      suggestedDepartments: departments,
      citations,
      suggestions,
      unknowns,
      questions,
      disclaimer: CONSULT_DISCLAIMER,
    },
  };
}
