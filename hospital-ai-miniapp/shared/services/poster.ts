/**
 * shared/services/poster.ts — 就医摘要图片的绘制计划（任务 21）。
 *
 * 把用户确认后的摘要文本转成一份**纯数据**的绘制计划（command list），供页面在
 * `<canvas type="2d">` 上渲染并导出为 750×1334 的图片。
 *
 * 设计约束：
 *   - `buildPosterPlan()` / `wrapBodyLines()` / `drawPoster()` 均为纯函数：
 *     同一输入恒得同一输出；不读时钟、不用随机数、不访问宿主接口（wx）。
 *   - 文本换行用**固定字数预算**（由 `floor(可用宽度 / 字号)` 得到每行码位上限），
 *     不依赖 canvas 的 `measureText`——node 检查环境与真机字体度量可能不同，
 *     计划必须与渲染器无关、可确定性断言。
 *   - 正文从候选字号里选第一个能容纳全部内容的字号；只有极长内容才在最小字号下截断
 *     （`bodyOverflow = true`），从而保证「内容 = 用户确认后的摘要」。
 *   - 换行按「码位」切分（`Array.from`），不会把代理对（emoji 等）从中间劈开；
 *     连续的西文/数字串整体作为一词，不会被拆成半个单词。
 *   - 文案唯一来源为 `config/texts.ts` 的 `POSTER` 段；本文件只做排版，不生成新内容。
 *
 * 计划内容（固定）：
 *   - 背景（整幅底色）+ 白色卡片；
 *   - 页眉：「就医准备助手」；
 *   - 正文：当前编辑区内容（用户确认后的摘要），按所选字号的预算换行；
 *   - 页脚：生成时间 +「用户自述 / 待医生确认」。
 *
 * 本文件只做忠实排版：不给出结论、不使用医疗等级措辞、也不涉及任何用药建议。
 */

import { POSTER } from '../../config/texts';

/** 导出图片的固定像素尺寸（任务 21 验收：750×1334）。 */
export const POSTER_WIDTH = 750;
export const POSTER_HEIGHT = 1334;

/**
 * 正文候选字号（由大到小）：选第一个能把全部正文放进版面的字号，保证
 * 「内容 = 用户确认后的摘要」——只有极长内容才会退化到最小字号并截断。
 */
export const BODY_FONT_CANDIDATES = [30, 28, 26, 24, 22, 20, 18] as const;

/** 正文行高 = 字号 × 此比例（取整，稳定性由字号决定）。 */
export const BODY_LINE_RATIO = 1.55;

/** 版式常量（像素）。 */
const LAYOUT = {
  padX: 68,
  cardX: 28,
  cardY: 28,
  cardWidth: 694,
  cardHeight: 1278,
  cardRadius: 36,
  headerHeight: 150,
  headerFont: 'bold 42px sans-serif',
  headerBaseline: 118,
  ruleY: 222,
  bodyTop: 268,
  bodyBottom: 1128,
  footerRuleY: 1148,
  footerTimeY: 1196,
  footerNoticeY: 1244,
  footerTimeFont: '22px sans-serif',
  footerNoticeFont: 'bold 26px sans-serif',
  ruleWidth: 2,
} as const;

/** 固定配色（canvas 无法读取 CSS 变量，取 app.wxss 设计令牌的字面值）。 */
const COLORS = {
  background: '#F4F6F9',
  card: '#FFFFFF',
  header: '#2A4FD7',
  headerText: '#FFFFFF',
  body: '#1D2129',
  rule: '#E5E6EB',
  footerNotice: '#2A4FD7',
  footerMeta: '#86909C',
} as const;

/** 绘制命令：渲染器逐条执行，计划本身不含任何宿主能力。 */
export type PosterCommand =
  | { op: 'fillRect'; x: number; y: number; width: number; height: number; color: string }
  | { op: 'roundRect'; x: number; y: number; width: number; height: number; radius: number; color: string }
  | { op: 'text'; text: string; x: number; y: number; font: string; color: string; align: 'left' | 'center' | 'right' }
  | { op: 'line'; x1: number; y1: number; x2: number; y2: number; color: string; width: number };

/** `buildPosterPlan()` 的输入。 */
export interface PosterInput {
  /** 当前编辑区内容（用户确认后的摘要）。 */
  body: string;
  /** 已格式化的生成时间（如 `2026-09-27 03:30`）；本函数原样引用，不读时钟。 */
  generatedAt: string;
}

/** 页脚内容。 */
export interface PosterFooter {
  /** 生成时间标签（含前缀），如 `生成时间：2026-09-27 03:30`。 */
  generatedAt: string;
  /** 固定声明：用户自述 / 待医生确认。 */
  notice: string;
}

/** 绘制计划（纯数据）。 */
export interface PosterPlan {
  width: number;
  height: number;
  header: string;
  footer: PosterFooter;
  /** 换行后的正文行（按所选字号的每行预算切分；仅极长内容截断）。 */
  bodyLines: string[];
  /** 正文是否因放大后仍放不下而被截断。 */
  bodyOverflow: boolean;
  /** 正文实际使用字号（px）。 */
  bodyFontPx: number;
  /** 正文实际行高（px）。 */
  bodyLineHeight: number;
  commands: PosterCommand[];
}

/** 渲染器需要的最小 canvas 2d 上下文契约（与真机 ctx 结构兼容）。 */
export interface PosterContext {
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  font: string;
  textAlign: 'left' | 'center' | 'right';
  textBaseline: 'top' | 'middle' | 'bottom' | 'alphabetic';
  fillRect(x: number, y: number, width: number, height: number): void;
  fillText(text: string, x: number, y: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arcTo(x1: number, y1: number, x2: number, y2: number, radius: number): void;
  closePath(): void;
  fill(): void;
  stroke(): void;
}

function isWordChar(ch: string): boolean {
  return /[A-Za-z0-9]/.test(ch);
}

/**
 * 把一段文本切成「词元」：连续西文/数字为一元，其余每个码位各自为一元。
 * 这样换行不会把英文单词或代理对从中间劈开。
 */
function tokenize(paragraph: string): string[] {
  const tokens: string[] = [];
  let buffer = '';
  for (const cp of Array.from(paragraph)) {
    if (isWordChar(cp)) {
      buffer += cp;
    } else {
      if (buffer !== '') {
        tokens.push(buffer);
        buffer = '';
      }
      tokens.push(cp);
    }
  }
  if (buffer !== '') tokens.push(buffer);
  return tokens;
}

/** 把一个超长词元按码位硬切成 ≤ maxChars 的片段（仅当单个词元本身超预算时）。 */
function hardSplit(token: string, maxChars: number): string[] {
  const chunks: string[] = [];
  let chunk = '';
  for (const cp of Array.from(token)) {
    if (chunk !== '' && chunk.length + cp.length > maxChars) {
      chunks.push(chunk);
      chunk = '';
    }
    chunk += cp;
  }
  if (chunk !== '') chunks.push(chunk);
  return chunks;
}

/**
 * 确定性换行：按码位预算 `maxChars` 折行，保留原文显式换行。
 * 规则：逐个词元累加，加上下一个会超预算时先换行；单个超长词元按码位硬切。
 * 不调用任何字体度量，故 node 检查与真机渲染得到同一组行。
 */
export function wrapBodyLines(text: string, maxChars: number): string[] {
  const budget = maxChars >= 1 ? Math.floor(maxChars) : 1;
  const normalized = text.replace(/\r\n?/g, '\n');
  const lines: string[] = [];
  for (const paragraph of normalized.split('\n')) {
    if (paragraph === '') {
      lines.push('');
      continue;
    }
    let current = '';
    for (const token of tokenize(paragraph)) {
      if (token.length > budget) {
        // 单个词元超预算：先冲掉当前行，再按码位硬切。
        if (current !== '') {
          lines.push(current);
          current = '';
        }
        const chunks = hardSplit(token, budget);
        for (let i = 0; i < chunks.length - 1; i += 1) lines.push(chunks[i]);
        current = chunks[chunks.length - 1];
        continue;
      }
      if (current === '') {
        current = token;
      } else if (current.length + token.length <= budget) {
        current += token;
      } else {
        lines.push(current);
        current = token;
      }
    }
    lines.push(current);
  }
  return lines;
}

/** 把命令列表外的纯文本命令抽出来（供检查脚本核对「全部文字」）。 */
export function planTexts(plan: PosterPlan): string[] {
  return plan.commands
    .filter((cmd): cmd is Extract<PosterCommand, { op: 'text' }> => cmd.op === 'text')
    .map((cmd) => cmd.text);
}

interface BodyFit {
  fontPx: number;
  lineHeight: number;
  lines: string[];
  overflow: boolean;
}

/**
 * 选择能容纳全部正文的最大候选字号；确定性（纯函数）。每个候选字号先由
 * `floor(可用宽度 / 字号)` 得到每行码位预算，再按预算换行；行数不超可用行高即选定。
 * 所有候选都放不下时取最小候选并截断（`overflow = true`）。
 */
function fitBody(body: string): BodyFit {
  const contentWidth = POSTER_WIDTH - LAYOUT.padX * 2;
  const available = LAYOUT.bodyBottom - LAYOUT.bodyTop;
  let smallest: BodyFit | null = null;
  for (const size of BODY_FONT_CANDIDATES) {
    const charsPerLine = Math.max(1, Math.floor(contentWidth / size));
    const lineHeight = Math.round(size * BODY_LINE_RATIO);
    const lines = wrapBodyLines(body, charsPerLine);
    const maxLines = Math.max(1, Math.floor(available / lineHeight));
    if (lines.length <= maxLines) {
      return { fontPx: size, lineHeight, lines, overflow: false };
    }
    smallest = { fontPx: size, lineHeight, lines: lines.slice(0, maxLines), overflow: true };
  }
  const fit = smallest ?? { fontPx: BODY_FONT_CANDIDATES[0], lineHeight: Math.round(BODY_FONT_CANDIDATES[0] * BODY_LINE_RATIO), lines: [], overflow: false };
  if (fit.lines.length > 0) {
    const last = fit.lines[fit.lines.length - 1];
    const budget = Math.max(1, Math.floor((POSTER_WIDTH - LAYOUT.padX * 2) / fit.fontPx));
    fit.lines[fit.lines.length - 1] = last.length >= budget ? last.slice(0, -1) + '…' : last + '…';
  }
  return fit;
}

/**
 * 组装绘制计划。纯函数：同一 `input` 恒得同一 `plan`。
 * 页眉/页脚文案来自 `config/texts.ts` 的 `POSTER` 段；正文来自 `input.body`。
 */
export function buildPosterPlan(input: PosterInput): PosterPlan {
  const body = fitBody(input.body);

  const header = POSTER.header;
  const footer: PosterFooter = {
    generatedAt: `${POSTER.generatedAtPrefix}：${input.generatedAt}`,
    notice: POSTER.footerNotice,
  };

  const commands: PosterCommand[] = [];
  // 背景 + 卡片 + 页眉色带
  commands.push({ op: 'fillRect', x: 0, y: 0, width: POSTER_WIDTH, height: POSTER_HEIGHT, color: COLORS.background });
  commands.push({ op: 'roundRect', x: LAYOUT.cardX, y: LAYOUT.cardY, width: LAYOUT.cardWidth, height: LAYOUT.cardHeight, radius: LAYOUT.cardRadius, color: COLORS.card });
  commands.push({ op: 'roundRect', x: LAYOUT.cardX, y: LAYOUT.cardY, width: LAYOUT.cardWidth, height: LAYOUT.headerHeight, radius: LAYOUT.cardRadius, color: COLORS.header });
  // 页眉标题
  commands.push({ op: 'text', text: header, x: POSTER_WIDTH / 2, y: LAYOUT.headerBaseline, font: LAYOUT.headerFont, color: COLORS.headerText, align: 'center' });
  // 页眉下分割线
  commands.push({ op: 'line', x1: LAYOUT.padX, y1: LAYOUT.ruleY, x2: POSTER_WIDTH - LAYOUT.padX, y2: LAYOUT.ruleY, color: COLORS.rule, width: LAYOUT.ruleWidth });
  // 正文：按所选字号绘制（行高由 fitBody 决定）
  const bodyFont = `${body.fontPx}px sans-serif`;
  for (let i = 0; i < body.lines.length; i += 1) {
    commands.push({ op: 'text', text: body.lines[i], x: LAYOUT.padX, y: LAYOUT.bodyTop + i * body.lineHeight, font: bodyFont, color: COLORS.body, align: 'left' });
  }
  // 页脚：分割线 + 生成时间 + 固定声明
  commands.push({ op: 'line', x1: LAYOUT.padX, y1: LAYOUT.footerRuleY, x2: POSTER_WIDTH - LAYOUT.padX, y2: LAYOUT.footerRuleY, color: COLORS.rule, width: LAYOUT.ruleWidth });
  commands.push({ op: 'text', text: footer.generatedAt, x: POSTER_WIDTH / 2, y: LAYOUT.footerTimeY, font: LAYOUT.footerTimeFont, color: COLORS.footerMeta, align: 'center' });
  commands.push({ op: 'text', text: footer.notice, x: POSTER_WIDTH / 2, y: LAYOUT.footerNoticeY, font: LAYOUT.footerNoticeFont, color: COLORS.footerNotice, align: 'center' });

  return {
    width: POSTER_WIDTH,
    height: POSTER_HEIGHT,
    header,
    footer,
    bodyLines: body.lines,
    bodyOverflow: body.overflow,
    bodyFontPx: body.fontPx,
    bodyLineHeight: body.lineHeight,
    commands,
  };
}

/** 曲线圆角矩形路径（仅路径，不 fill；由 drawPoster 统一 fill）。 */
function roundRectPath(ctx: PosterContext, x: number, y: number, width: number, height: number, radius: number): void {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

/** 按计划把内容画到给定的 2d 上下文上（纯函数：仅写 ctx，不读环境）。 */
export function drawPoster(ctx: PosterContext, plan: PosterPlan): void {
  for (const cmd of plan.commands) {
    if (cmd.op === 'fillRect') {
      ctx.fillStyle = cmd.color;
      ctx.fillRect(cmd.x, cmd.y, cmd.width, cmd.height);
    } else if (cmd.op === 'roundRect') {
      ctx.fillStyle = cmd.color;
      roundRectPath(ctx, cmd.x, cmd.y, cmd.width, cmd.height, cmd.radius);
      ctx.fill();
    } else if (cmd.op === 'text') {
      ctx.fillStyle = cmd.color;
      ctx.font = cmd.font;
      ctx.textAlign = cmd.align;
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(cmd.text, cmd.x, cmd.y);
    } else {
      ctx.strokeStyle = cmd.color;
      ctx.lineWidth = cmd.width;
      ctx.beginPath();
      ctx.moveTo(cmd.x1, cmd.y1);
      ctx.lineTo(cmd.x2, cmd.y2);
      ctx.stroke();
    }
  }
}
