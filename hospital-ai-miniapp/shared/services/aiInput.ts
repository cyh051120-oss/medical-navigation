/**
 * shared/services/aiInput.ts — AI 请求体构造的纯函数（重构：从 pages/ai/ai.ts 抽出）。
 *
 * 设计约束：纯函数，不接触宿主接口、不读存储；调用方把当前页面状态（对话 / 档案 / 勾选 /
 * 记忆）作为显式参数传入，便于 node 端检查。发送范围与必填字段的语义与任务 25/28 契约一致。
 */

import type { AiMode, AskInput, ChatMessage, InterviewInput } from './aiClient';
import type { LocalProfile, MemoryItem } from './records';

/** `/api/ask` 请求体的构造上下文（由页面按当前状态提供）。 */
export interface AskInputContext {
  /** 当前对话历史（role/content）。 */
  messages: ChatMessage[];
  /** 当前个人档案（可为 null）。 */
  profile: LocalProfile | null;
  /** 是否带入档案摘要（仅 consult 生效）。 */
  includeProfile: boolean;
  /** 用户选定的记录摘录（仅 consult 生效）。 */
  excerpts: string[];
  /** 全部记忆（内部按 enabled 过滤）。 */
  memories: MemoryItem[];
}

/**
 * 构造 `/api/ask` 请求体：把本轮输入追加到对话尾部；档案/摘录仅 consult 生效；记忆恒带上。
 * 与旧 `buildInput` 行为逐字一致。
 */
export function buildAskInput(text: string, mode: AiMode, ctx: AskInputContext): AskInput {
  const messages = ctx.messages.concat([{ role: 'user', content: text }]);
  return {
    mode,
    messages,
    profile: mode === 'consult' && ctx.includeProfile ? ctx.profile : null,
    excerpts: mode === 'consult' ? ctx.excerpts : [],
    memories: ctx.memories,
  };
}

/** `/api/interview` 请求体的构造上下文。 */
export interface InterviewInputContext {
  /** 当前对话历史（role/content）。 */
  messages: ChatMessage[];
  /** 当前个人档案（可为 null）。 */
  profile: LocalProfile | null;
  /** 已完成的追问轮数。 */
  round: number;
  /** 全部记忆（内部按 enabled 过滤）。 */
  memories: MemoryItem[];
}

/** 构造 `/api/interview` 请求体：对话含本轮输入；记忆按启用项带入。与旧 `buildInterviewInput` 一致。 */
export function buildInterviewInput(text: string, ctx: InterviewInputContext): InterviewInput {
  const messages = ctx.messages.concat([{ role: 'user', content: text }]);
  return { messages, profile: ctx.profile, round: ctx.round, memories: ctx.memories };
}
