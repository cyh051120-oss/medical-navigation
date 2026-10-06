// server/redflags.ts
// 红标（危险信号）确定性检测 + 固定安全提示句（任务 25；P1-7 修订）。
//
// 契约：
//   - REDFLAG_PATTERN_SOURCES：按「危险信号类目」组织的正则源串（每类一项）。
//       * 覆盖口语与书面表述；每项是独立正则，用 `|` 汇总该类目的同义说法。
//       * 客户端孪生（hospital-ai-miniapp/shared/services/redflags.ts）必须导出同名的
//         REDFLAG_PATTERN_SOURCES / NEGATION_PATTERN_SOURCES / NEG_FILLER_SOURCES，
//         且内容逐项相等；scripts/check-demo.mjs 会断言三个数组深度相等。
//   - NEGATION_PATTERN_SOURCES：否定前缀正则源串（没有/无/不伴/未见/否认 + 词）。
//   - NEG_FILLER_SOURCES：否定词与症状词之间允许的填充词（与否定词一致地做孪生对齐）。
//   - RED_FLAG_TERMS：历史导出（人可读的 15 条词表），保留以兼容既有调用/测试；
//     检测逻辑以 REDFLAG_PATTERN_SOURCES 为准。
//   - SAFETY_NOTICE：命中即强制返回的固定安全提示句（含急救电话指引）。
//   - detectRedFlag(texts)：确定性子串/正则扫描 + 否定窗口判定，返回 { hit, terms }。
//
// 语义：
//   - 命中任一类目即 `hit: true`；但「否定式提及」（如「没有胸痛」「未见抽搐」）不算命中。
//   - 否定判定：匹配位置前的短窗口内出现否定词（允许中间夹「明显/任何/其他」等填充词），
//     且该否定词紧邻匹配词（允许填充词与标点），即视为否定。
//   - 本模块纯函数、无副作用、无网络、无磁盘 I/O，且绝不修改/回显输入。
// 约束：可擦除语法；仅类型导入使用 `import type`（本文件无）。

/**
 * 危险信号类目正则源（每项一类，顺序即匹配优先级）。
 * 必须与客户端孪生 `hospital-ai-miniapp/shared/services/redflags.ts` 逐项相等
 * （scripts/check-demo.mjs 断言深度相等）。
 */
export const REDFLAG_PATTERN_SOURCES: readonly string[] = [
  '胸痛',
  '胸闷.{0,6}大汗|大汗.{0,6}胸闷',
  '呼吸困难|喘不上气|喘不过气',
  '意识障碍|昏迷|叫不醒|唤不醒',
  '心跳呼吸停止|呼吸心跳停止|心跳骤停|呼吸停止',
  '大出血',
  '出血不止|持续出血|止不住血',
  '中风|口眼歪斜|嘴歪眼斜|一侧无力|半身无力|偏瘫|说话不清|言语不清|口齿不清',
  '晕厥|晕倒|昏倒',
  '剧烈头痛|头痛欲裂',
  '剧烈腹痛|腹痛剧烈|肚子剧痛',
  '持续高热|高烧不退|持续发烧',
  '抽搐|抽风|惊厥',
  '窒息|无法呼吸',
  '咯血|咳血',
  '吐血|呕血',
  '便血|黑便',
  '中毒|误服|服药过量',
  '自杀|自伤|自残|想死',
  '孕期出血|怀孕.{0,6}出血|阴道出血',
  '喉头水肿|喉水肿|喉咙肿',
];

/**
 * 否定前缀正则源；命中位置前的短窗口以其中一项结尾则视为被否定。
 * 必须与客户端孪生逐项相等（deep equality）。
 */
export const NEGATION_PATTERN_SOURCES: readonly string[] = [
  '没有',
  '无',
  '不伴',
  '未见',
  '否认',
  '未出现',
  '并无',
  '无明显',
  '不觉得',
];

/**
 * 否定词与症状词之间允许出现的填充词（去尾匹配）。
 * 必须与客户端孪生逐项相等（deep equality；与 NEGATION_PATTERN_SOURCES 同属 P1-7 孪生契约）。
 */
export const NEG_FILLER_SOURCES: readonly string[] = ['明显', '任何', '其他', '特殊', '特别', '太', '的'];

/** 否定窗口：只看匹配词前最多 8 个字符。 */
const NEG_LOOKBEHIND = 8;

const NEGATION_SUFFIX_REGEXPS: readonly RegExp[] = NEGATION_PATTERN_SOURCES.map(
  (source) => new RegExp(`(?:${source})$`, 'u')
);

/**
 * 历史导出：人可读的 15 条红标词表（前 8 条对应计划要求）。
 * 检测逻辑不再依赖此表（见 REDFLAG_PATTERN_SOURCES），保留以兼容既有引用。
 */
export const RED_FLAG_TERMS: readonly string[] = [
  '胸痛',
  '胸闷伴大汗',
  '呼吸困难',
  '意识障碍',
  '大出血',
  '中风征象',
  '晕厥',
  '剧烈头痛',
  '窒息',
  '抽搐',
  '咯血',
  '吐血',
  '便血',
  '言语不清',
  '一侧无力',
];

/**
 * 命中红标时强制返回的固定安全提示句（P1-8 修订：含急救电话指引）。
 * 不含科室名、健康方向、病情名、引用，也不含任何红标词本身。
 */
export const SAFETY_NOTICE =
  '您描述的情况可能需要尽快就医。本助手不提供任何医疗判断或建议。请立即拨打 120 或前往最近医院急诊，不要只依赖本工具。';

export type RedFlagScan = {
  hit: boolean;
  /** 命中的类目正则源串（去重，保持类目顺序）。 */
  terms: string[];
};

/** 判定匹配位置是否处于否定语境（紧邻否定词，允许填充词/标点）。 */
function isNegatedMatch(text: string, matchIndex: number): boolean {
  let context = text.slice(Math.max(0, matchIndex - NEG_LOOKBEHIND), matchIndex);
  let changed = true;
  while (changed) {
    changed = false;
    const trimmed = context.replace(/[，,。．.、\s;；:：!！?？~～\-—]+$/u, '');
    if (trimmed !== context) {
      context = trimmed;
      changed = true;
      continue;
    }
    for (const filler of NEG_FILLER_SOURCES) {
      if (context.endsWith(filler)) {
        context = context.slice(0, -filler.length);
        changed = true;
        break;
      }
    }
  }
  return NEGATION_SUFFIX_REGEXPS.some((re) => re.test(context));
}

/**
 * 对一组文本做确定性红标扫描。
 * 命中任一类目即 `hit: true`；否定式提及（没有/无/不伴/未见/否认 + 词）不算命中。
 * 非字符串/空串直接跳过；绝不修改输入。
 */
export function detectRedFlag(texts: readonly string[]): RedFlagScan {
  const hits: string[] = [];
  for (const text of texts) {
    if (typeof text !== 'string' || text === '') continue;
    for (const source of REDFLAG_PATTERN_SOURCES) {
      if (hits.includes(source)) continue;
      const re = new RegExp(source, 'gu');
      let match = re.exec(text);
      let matched = false;
      while (match !== null) {
        if (match[0] === '') {
          re.lastIndex += 1;
        } else if (!isNegatedMatch(text, match.index)) {
          matched = true;
          break;
        }
        match = re.exec(text);
      }
      if (matched) hits.push(source);
    }
  }
  return { hit: hits.length > 0, terms: hits };
}
