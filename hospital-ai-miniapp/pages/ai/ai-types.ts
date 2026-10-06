/**
 * pages/ai/ai-types.ts — AI 助手页的页面级类型（重构：从 pages/ai/ai.ts 抽出）。
 *
 * 纯类型定义 + `isAiMessage` 守卫；无运行时副作用，可在 node 环境直接 import 做检查。
 * 渲染块类型（AiBlock / AiBlockItem）由 shared/services/aiRender.ts 提供。
 */

import { isRecord } from '../../shared/services/aiRender';
import type { AiBlock } from '../../shared/services/aiRender';
import type { AiMode, ExcerptKind } from '../../shared/services/aiClient';

export type AiKind = 'text' | 'organize' | 'consult' | 'interview' | 'redflag' | 'local' | 'error';

/** 页面页签：`AiMode` 是 `/api/ask` 的契约；`interview` 走独立的 `/api/interview`。 */
export type AiTab = AiMode | 'interview';

/** 资料摘录草稿：保存前可编辑的名称/摘录/备注。 */
export interface DraftForm {
  name: string;
  excerpt: string;
  remark: string;
}

/** 症状记录草稿：追问结束后、保存前可编辑。 */
export interface InterviewDraft {
  text: string;
  occurredAt: string;
  duration: string;
  impact: string;
  tags: string;
}

export interface AiMessage {
  id: string;
  role: 'user' | 'assistant';
  mode: AiTab;
  kind: AiKind;
  content: string;
  memoryDraft: string;
  blocks: AiBlock[];
  disclaimer: string;
  errorText: string;
  canLocalOrganize: boolean;
  localText: string;
  createdAt: string;
}

export interface CandidateRow {
  id: string;
  kind: ExcerptKind;
  kindLabel: string;
  excerpt: string;
  selected: boolean;
}

export interface PreviewRow {
  key: string;
  title: string;
  text: string;
}

export interface AssistantDraft {
  kind: AiKind;
  mode: AiTab;
  content?: string;
  memoryDraft?: string;
  blocks?: AiBlock[];
  disclaimer?: string;
  errorText?: string;
  canLocalOrganize?: boolean;
  localText?: string;
}

export function isAiMessage(value: unknown): value is AiMessage {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    (value.role === 'user' || value.role === 'assistant') &&
    Array.isArray(value.blocks)
  );
}
