// server/redflags.ts
// 红标（危险信号）确定性检测 + 固定安全提示句（任务 25）。
//
// 契约：
//   - RED_FLAG_TERMS：受限词表（覆盖计划要求的 8 条 + 同精神补充）。
//   - SAFETY_NOTICE：命中即强制返回的固定安全提示句。
//       它不含任何科室名、健康方向、病情名、引用，也不含任何红标词本身。
//   - detectRedFlag(texts)：对给定文本做确定性子串扫描，返回 { hit, terms }。
//     大小写敏感、无正则、无外部依赖；绝不修改/回显输入。
//
// 本模块纯函数、无副作用、无网络、无磁盘 I/O。
// 约束：可擦除语法；仅类型导入使用 `import type`（本文件无）。

/**
 * 受限红标词表。前 8 条对应计划要求：
 * 胸痛 / 胸闷伴大汗 / 呼吸困难 / 意识障碍 / 大出血 / 中风征象 / 晕厥 / 剧烈头痛；
 * 其余为同精神补充（窒息/抽搐/咯血/吐血/便血/言语不清/一侧无力）。
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
 * 命中红标时强制返回的固定安全提示句。
 * 不含科室名、健康方向、病情名、引用，也不含任何红标词。
 */
export const SAFETY_NOTICE =
  '您描述的情况可能需要尽快就医。本助手不提供任何医疗判断或建议，请立即联系医生或前往就近医疗机构。';

export type RedFlagScan = {
  hit: boolean;
  /** 命中的词表项（去重，保持词表顺序）。 */
  terms: string[];
};

/**
 * 对一组文本做确定性红标扫描（子串匹配）。
 * 命中任意受限词即 `hit: true`；非字符串/空串直接跳过。
 */
export function detectRedFlag(texts: readonly string[]): RedFlagScan {
  const hits: string[] = [];
  for (const text of texts) {
    if (typeof text !== 'string' || text === '') continue;
    for (const term of RED_FLAG_TERMS) {
      if (text.includes(term) && !hits.includes(term)) hits.push(term);
    }
  }
  return { hit: hits.length > 0, terms: hits };
}
