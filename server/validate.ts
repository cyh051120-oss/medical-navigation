// server/validate.ts
// 双模式输出确定性校验 + schema 白名单重建（任务 25；P1-8/10/15/16 修订）。
//
// 契约：
//   - 输出类型（OrganizeResult / ConsultResult / Citation…）在此定义，编排器再导出。
//   - validateOrganizeOutput(raw) / validateConsultOutput(raw, options) 均为纯函数，
//     返回 `{ ok: true, value }` 或 `{ ok: false, reason }`（reason 仅内部使用，绝不回显）。
//   - schema 白名单：只有已知字段会被重建进结果；模型返回的任何额外字段（例如 narrative
//     自由文本病情叙述）一律丢弃，永不回传。
//   - 受限词（P1-8/P1-10/P1-8-tightening）：
//       * 结论/建议字段（direction.text / suggestion.text）保持严格（出现即失败）；
//         「拨打 / 120」为**分句内共现**规则：仅当**同一分句**内出现急救线索
//         （立即/马上/急诊/急救）且该分句未否定呼叫（不要/无需/不用/禁止/避免 紧邻呼叫词）时放行，
//         从而允许产品在急症路径上给出「立即拨打 120」这类正确引导，同时拒绝
//         「尽快拨打120」（弱线索不再豁免）与「不要拨打120，立即就医」（线索在别句/呼叫被否定）。
//       * 会渲染给用户的全部字段（points / extracted.* / unknowns / questions）一律扫描；
//         受限词按「分句 + 中性缺失标记」判定：同一分句内同时出现中性标记（不确定/未说明/待确认/
//         是否…）时视为「复述用户的信息缺口」放行，否则拦截。分句判定修复了「尚待确认，确诊为…」
//         这类在旧 ±8 字窗口下被错误放行的绕过。
//   - extracted 子字段（P1-16）：显式缺失 → 空数组；存在但类型不符 → 失败（绝不静默丢弃
//     过敏史/用药），由编排器统一降级为 unsafe_output（可见）。
//   - 长度：direction.text ≤20 字；suggestion.text ≤40 字。
//   - 引用（P1-15）：citation 先做 URL 归一化（去空白、去尾斜杠、host 小写、百分号解码、
//     允许省略 scheme）再与「本次请求已获取的搜索结果」比较；仅真正不同的 URL 才失败。
//     解析出的 title/url/domain 取自已获取来源，不信任模型。
//   - 受控科室：suggestedDepartments 每项必须属于 CONTROLLED_DEPARTMENTS（否则失败）。
//
// 本模块纯函数、无副作用、无网络/磁盘 I/O（asRecord 等纯工具集中在 config.ts，避免重复实现）。
// 约束：可擦除语法；仅类型导入使用 `import type`。

import type { ChatMessage } from './providers/llm.ts';
import type { SearchReason, SearchResult } from './providers/search.ts';
import { isAuthorityUrl } from './authorities.ts';
import { asRecord } from './config.ts';
import { CONSULT_DISCLAIMER, CONTROLLED_DEPARTMENTS } from './prompts.ts';

// ---------------------------------------------------------------------------
// 共享纯工具（单一权威定义，供 orchestrator/interview/extract-memory 复用）
// ---------------------------------------------------------------------------

/** 合法对话角色白名单（消息规范化共用）。 */
export const CHAT_ROLES: readonly string[] = ['user', 'assistant', 'system'];

/**
 * 消息数组规范化：非空、每项为对象且 role 合法、content 为字符串；否则 null。
 */
export function normalizeMessages(value: unknown): ChatMessage[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const out: ChatMessage[] = [];
  for (const item of value) {
    if (item === null || typeof item !== 'object') return null;
    const rec = item as Record<string, unknown>;
    if (typeof rec.role !== 'string' || !CHAT_ROLES.includes(rec.role)) return null;
    if (typeof rec.content !== 'string') return null;
    out.push({ role: rec.role as ChatMessage['role'], content: rec.content });
  }
  return out;
}

/** 严格 JSON 解析；容忍外层 ```json 围栏；失败返回 null。 */
export function parseJsonContent(content: string): { ok: true; value: unknown } | null {
  let text = content.trim();
  if (text === '') return null;
  const fence = /^```[a-zA-Z0-9]*\s*([\s\S]*?)\s*```$/.exec(text);
  if (fence !== null) text = fence[1].trim();
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return null;
  }
}

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
  /**
   * P1-14：检索降级标记。仅当 consult 未获得任何权威来源时出现，
   * 且此时 suggestedDepartments 已被清空（不以正常结果形状伪装有来源）。
   */
  degraded?: SearchReason;
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

/** 通用医疗判断词。（导出供任务 43 记忆提炼复用；行为不变。） */
export const DECISION_TERMS: readonly string[] = ['确诊', '诊断', '处方', '疗效', '剂量', '治愈', '拨打', '120'];

/**
 * 强急救线索（P1-8 tightening）：只有**同一分句**内出现这些词才豁免「拨打 / 120」。
 * 已移除弱线索「尽快」——它可被「尽快拨打120」滥用而并非真正的呼叫指引。
 */
const EMERGENCY_CUES: readonly string[] = ['立即', '马上', '急诊', '急救'];

/** 推荐性字段（direction.text）额外禁止：具体医生/医院/挂号等。（导出供任务 43 复用。） */
export const REFERRAL_TERMS: readonly string[] = ['医生', '医院', '挂号', '大夫', '主任', '专家'];

/** 通用生活/照护提示（suggestion.text）额外禁止的个性化用药指令。（导出供任务 43 复用。） */
export const SELF_MEDICATION_TERMS: readonly string[] = ['服用', '口服', '停药', '加量', '减量', '换药', '毫克', 'mg', '遵医嘱'];

const EMERGENCY_CALL_TERMS: readonly string[] = ['拨打', '120'];

/** 否定呼叫的动词：紧邻「拨打/120」时，即使同句有急救线索也判违规（P1-8 tightening）。 */
const EMERGENCY_CALL_NEGATIONS: readonly string[] = ['不要', '无需', '不用', '禁止', '避免'];

/** 否定判定窗口：只看呼叫词前后各多少个字符（「紧邻/环绕」语义）。 */
const EMERGENCY_CALL_NEG_WINDOW = 4;

const MAX_DIRECTION_CHARS = 20;
const MAX_SUGGESTION_CHARS = 40;

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

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

/**
 * 中性缺失 / 不确定标记：同一分句内出现这些词时，视为「复述用户的信息缺口」而非模型断言。
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

/** 分句边界（中英文标点 + 换行）。 */
const CLAUSE_SPLIT = /[，,。.！!？?；;、\n\r]+/u;

/** 是否为「共现放宽」的急救词（拨打/120）。 */
function isEmergencyCallTerm(term: string): boolean {
  return EMERGENCY_CALL_TERMS.includes(term);
}

/**
 * 整段文本是否含急救线索（用于 拨打/120 的共现放宽）。
 * 导出供测试/门禁引用，使「急救线索」的判定与生产校验共享唯一实现（P1-8）。
 */
export function hasEmergencyCue(text: string): boolean {
  return EMERGENCY_CUES.some((cue) => text.includes(cue));
}

/**
 * 判定某段文本内「拨打/120」是否被明确否定：
 * 呼叫词前后 EMERGENCY_CALL_NEG_WINDOW 个字符内出现否定动词即视为否定。
 */
function isNegatedEmergencyCall(text: string): boolean {
  for (const term of EMERGENCY_CALL_TERMS) {
    let from = 0;
    for (;;) {
      const at = text.indexOf(term, from);
      if (at === -1) break;
      const before = text.slice(Math.max(0, at - EMERGENCY_CALL_NEG_WINDOW), at);
      const after = text.slice(at + term.length, at + term.length + EMERGENCY_CALL_NEG_WINDOW);
      if (EMERGENCY_CALL_NEGATIONS.some((n) => before.includes(n) || after.includes(n))) return true;
      from = at + term.length;
    }
  }
  return false;
}

/**
 * 分句级「拨打/120」判定：仅当与急救线索**同分句**且该分句未否定呼叫时放行。
 * 返回命中的呼叫词（违规）或 null。
 */
function findEmergencyCallViolation(text: string): string | null {
  for (const rawClause of text.split(CLAUSE_SPLIT)) {
    const clause = rawClause.trim();
    if (clause === '') continue;
    for (const term of EMERGENCY_CALL_TERMS) {
      if (!clause.includes(term)) continue;
      if (hasEmergencyCue(clause) && !isNegatedEmergencyCall(clause)) continue;
      return term;
    }
  }
  return null;
}

/**
 * 严格受限词扫描（结论/建议性字段）：任一受限词出现即命中；
 * 「拨打/120」按分句 + 否定守卫判定（P1-8 tightening）。
 */
function findBannedStrict(text: string, terms: readonly string[]): string | null {
  for (const term of terms) {
    if (isEmergencyCallTerm(term)) {
      const emergencyHit = findEmergencyCallViolation(text);
      if (emergencyHit !== null) return emergencyHit;
    } else if (text.includes(term)) {
      return term;
    }
  }
  return null;
}

/**
 * 分句受限词扫描（可渲染的复述性字段）：逐分句判定；
 * 同一分句内出现中性标记即放行；「拨打/120」按分句内共现 + 否定守卫判定。
 */
function findBannedInClauses(text: string, terms: readonly string[]): string | null {
  for (const rawClause of text.split(CLAUSE_SPLIT)) {
    const clause = rawClause.trim();
    if (clause === '') continue;
    if (NEUTRAL_MARKERS.some((marker) => clause.includes(marker))) continue;
    const hit = findBannedStrict(clause, terms);
    if (hit !== null) return hit;
  }
  return null;
}

/** 对若干文本做严格受限词扫描；返回首个命中词或 null。 */
function scanStrictTexts(texts: readonly string[], terms: readonly string[]): string | null {
  for (const text of texts) {
    const hit = findBannedStrict(text, terms);
    if (hit !== null) return hit;
  }
  return null;
}

/** 对若干文本做分句受限词扫描；返回首个命中词或 null。 */
function scanClauseTexts(texts: readonly string[], terms: readonly string[]): string | null {
  for (const text of texts) {
    const hit = findBannedInClauses(text, terms);
    if (hit !== null) return hit;
  }
  return null;
}

/**
 * 导出供测试：判定一段文本是否含「断言式」通用医疗判断词。
 * 复述性字段使用分句规则；「拨打/120」在含急救线索时放行。
 * 返回命中的词或 null。
 */
export function firstBannedDecisionTerm(text: string): string | null {
  return findBannedInClauses(text, DECISION_TERMS);
}

// ---------------------------------------------------------------------------
// citation（P1-15：URL 归一化后比较）
// ---------------------------------------------------------------------------

/**
 * 归一化 URL 以便比较：去空白、百分号解码、host 小写、去尾斜杠；
 * 允许省略 scheme（补 https://）。无法解析时退化为「去尾斜杠 + 小写」。
 */
function normalizeUrlForCompare(input: string): string | null {
  let value = input.trim();
  if (value === '') return null;
  try {
    value = decodeURIComponent(value);
  } catch {
    // 非法百分号序列：保留原文继续。
  }
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
  try {
    const url = new URL(hasScheme ? value : `https://${value}`);
    const path = url.pathname.replace(/\/+$/, '');
    const port = url.port !== '' ? `:${url.port}` : '';
    return `${url.protocol}//${url.hostname.toLowerCase()}${port}${path}${url.search}${url.hash}`;
  } catch {
    return value.replace(/\/+$/, '').toLowerCase();
  }
}

/**
 * 解析 citation：归一化 URL 后必须是本次已获取来源中的某个 URL，且域名通过权威白名单。
 * 返回规范化引用（title/url/domain 取自已获取来源，不信任模型）。
 */
function resolveCitation(
  value: unknown,
  sourceByUrl: ReadonlyMap<string, SearchResult>,
  domains: readonly string[]
): Citation | null {
  if (typeof value !== 'string') return null;
  const key = normalizeUrlForCompare(value);
  if (key === null) return null;
  const source = sourceByUrl.get(key);
  if (source === undefined) return null;
  if (!isAuthorityUrl(source.url, domains)) return null;
  return { title: source.title, url: source.url, domain: source.domain };
}

// ---------------------------------------------------------------------------
// organize
// ---------------------------------------------------------------------------

const EXTRACTED_KEYS: readonly (keyof OrganizeExtracted)[] = [
  'symptoms',
  'medications',
  'allergies',
  'history',
  'exams',
];

/**
 * 校验并重建 organize 输出。仅保留 points/extracted/unknowns/questions。
 * 未知字段丢弃；全部渲染字段走分句受限词扫描；extracted 子字段类型不符即失败（P1-16）。
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
  if (typeof rec.extracted !== 'object' || Array.isArray(rec.extracted)) {
    return fail('extracted 必须为对象');
  }

  const extractedRec = asRecord(rec.extracted);
  const extracted: OrganizeExtracted = {
    symptoms: [],
    medications: [],
    allergies: [],
    history: [],
    exams: [],
  };
  for (const key of EXTRACTED_KEYS) {
    const value = extractedRec[key];
    // 显式缺失 → 空数组；存在但类型不符 → 失败（绝不静默丢弃过敏史/用药）。
    if (value === undefined || value === null) {
      extracted[key] = [];
      continue;
    }
    const array = readStringArray(value);
    if (array === null) return fail(`extracted.${key} 类型错误（应为字符串数组）`);
    extracted[key] = array;
  }

  // 全部会渲染的字段一律扫描：points / extracted.* / unknowns / questions。
  const rendered = [
    ...points,
    ...extracted.symptoms,
    ...extracted.medications,
    ...extracted.allergies,
    ...extracted.history,
    ...extracted.exams,
    ...unknowns,
    ...questions,
  ];
  const hit = scanClauseTexts(rendered, DECISION_TERMS);
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
  for (const source of options.sources) {
    const key = normalizeUrlForCompare(source.url);
    if (key !== null && !sourceByUrl.has(key)) sourceByUrl.set(key, source);
  }

  const citations: Citation[] = [];
  const citationIndex = new Map<string, Citation>();
  const directions: ConsultDirection[] = [];

  for (const item of rawDirections) {
    const direction = asRecord(item);
    const text = typeof direction.text === 'string' ? direction.text.trim() : null;
    if (text === null || text === '') return fail('direction.text 缺失');
    if (text.length > MAX_DIRECTION_CHARS) return fail('direction 超长');
    const banned = findBannedStrict(text, [...DECISION_TERMS, ...REFERRAL_TERMS]);
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
      const banned = findBannedStrict(text, DECISION_TERMS) ?? findBannedStrict(text, SELF_MEDICATION_TERMS);
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

  // P1-10：unknowns/questions 会渲染给用户，必须扫描；按分句 + 中性缺失标记放行复述性缺口。
  const hit = scanClauseTexts([...unknowns, ...questions], DECISION_TERMS);
  if (hit !== null) return fail(`输出含受限词：${hit}`);

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
