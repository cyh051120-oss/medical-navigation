/**
 * shared/services/redflags.ts — 客户端红标（危险信号）确定性检测。
 *
 * 与 `server/redflags.ts` 是**同源孪生**：两侧导出同名的
 *   REDFLAG_PATTERN_SOURCES  /  NEGATION_PATTERN_SOURCES  /  NEG_FILLER_SOURCES
 * `scripts/check-demo.mjs` 会断言三组数组逐项深度相等（deep equality）。
 *
 * 设计约束：
 *   - 纯函数、无副作用、不读时钟/随机数、不接触任何宿主接口，可在 node 直接 import 检查。
 *   - 词表为**正则源码串**（非字面词）：覆盖计划要求的红标语义 + 常见口语同义表达。
 *   - 否定处理：命中位置前的短窗口若（去掉填充词/标点后）以否定词结尾
 *     （没有 / 无 / 不伴 / 未见 / 否认…），则该次命中不计入 —— 「没有胸痛」「未见明显抽搐」不再短路。
 *   - `demoAi.ts` 在演示模式下用同一份检测做短路，与服务端演示分支语义一致。
 */

/** 红标正则源码串（`new RegExp(source, 'g')` 编译）。 */
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

/** 否定词正则源码串；命中前短窗口以其中一项结尾则视为被否定。 */
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

export interface RedFlagScan {
  hit: boolean;
  /** 命中的类目正则源串（去重，保持类目顺序）。 */
  terms: string[];
}

/** 否定词与症状词之间允许出现的填充词（去尾匹配）。与服务端孪生同源，供 check-demo 深度比对。 */
export const NEG_FILLER_SOURCES: readonly string[] = ['明显', '任何', '其他', '特殊', '特别', '太', '的'];

/** 否定窗口：只看匹配词前最多 8 个字符。 */
const NEG_LOOKBEHIND = 8;

const NEGATION_SUFFIX_REGEXPS: readonly RegExp[] = NEGATION_PATTERN_SOURCES.map(
  (source) => new RegExp(`(?:${source})$`, 'u')
);

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
 * 对一组文本做确定性红标扫描（正则 + 否定抑制）。
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
