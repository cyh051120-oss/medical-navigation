// shared/services/records.ts
// Local CRUD services for the six persisted entities.
//
// Layering: this module is the ONLY data layer above `../utils/storage`
// (namespaced `mhp_*`). It performs NO direct `wx.*` calls and NO network
// access. Runtime is the WeChat miniapp storage (or a Map shim in tests).
//
// Field mapping (derived from the consumer tasks; no extra fields invented):
//   LocalProfile     <- task 14 `pages/profile`: 称呼 name / 年龄段 ageRange /
//                      性别 gender (optional) / 过敏 allergies / 长期用药
//                      medications / 既往情况 history (+ createdAt/updatedAt).
//                      Singleton: `list()` returns 0..1 records.
//   SymptomEntry     <- task 17 `pages/symptoms`: 发生时间 occurredAt /
//                      持续时长 duration / 原话 text (required non-empty) /
//                      影响 impact / 标签 tags[] / 1 附件 attachment (path|null).
//                      NO severity field (无严重程度字段 — hard constraint).
//   DocumentNote     <- task 18 `pages/notes`: 名称 name / 摘录 excerpt /
//                      来源日期 sourceDate / 1 本地附件 attachment / 备注 remark.
//   QuestionList     <- task 19 `pages/questions` + task 30: a single 问题 entry
//                      text / done (勾选完成) / group (分组) /
//                      source ('ai'|'organizer'|'manual', optional). Dedupe
//                      bulk-import helper backs the 一键导入 flow.
//   VisitBrief       <- task 20 `pages/brief`: 摘要文本 content /
//                      sourceIds[] (来源记录 id) / exportedAt (导出时间|null).
//   MemoryItem       <- task 42 用户偏好记忆: 正文 text (required non-empty) /
//                      source ('manual'|'ai', default 'manual') /
//                      enabled (default true). No attachments. CRUD only;
//                      dedupe / server extraction are later tasks, not here.
//   AppPreferences   <- task 12 首启隐私 / task 16 fontSize / task 31
//                      aiEnabled+consentVersion / task 15 highContrast /
//                      task 42 autoMemory / task 32 demoMode:
//                      aiEnabled (default false) / consentVersion /
//                      fontSize (default 14, range 14-32) /
//                      highContrast (default false) /
//                      autoMemory (default true) /
//                      demoMode (default false, additive — missing => false).
//                      Singleton: `get()` returns defaults when unset.
//
// Task 8 (attachments + oplog) builds directly on these records. The
// `attachment` fields are plain local file path strings (path|null); the
// lifecycle (saveFile/unlink) is owned by task 8, not this layer.
//
// Storage keys (raw, with the `mhp_` namespace applied by storage.ts):
//   records_profile / records_symptoms / records_notes /
//   records_questions / records_briefs / records_memory / records_preferences
//
// IDs: `<prefix>_<ts>_<rand>`, e.g. `sym_1758899123456_x7k2p9` or
// `mem_1758899123456_x7k2p9`, matching `/^[a-z]+_\d+_[a-z0-9]+$/`
// (ts = Date.now(), rand = short base36).
//
// Timestamps: ISO strings via `new Date().toISOString()`. `updatedAt` is
// non-decreasing per record: if a freshly generated timestamp would sort
// before the previous `updatedAt`, the previous value is reused.

import * as storage from '../utils/storage';

/** Raw storage keys (without the `mhp_` namespace prefix). */
export const ENTITY_KEYS = {
  profile: 'records_profile',
  symptoms: 'records_symptoms',
  notes: 'records_notes',
  questions: 'records_questions',
  briefs: 'records_briefs',
  memory: 'records_memory',
  preferences: 'records_preferences',
} as const;

export const FONT_SIZE_MIN = 14;
export const FONT_SIZE_MAX = 32;
export const FONT_SIZE_DEFAULT = 14;

/** Common persisted identity/timestamp fields for list-backed records. */
export interface BaseRecord {
  id: string;
  createdAt: string;
  updatedAt: string;
}

/** Singleton personal profile (list length 0..1). Task 14. */
export interface LocalProfile extends BaseRecord {
  /** 称呼 */
  name: string;
  /** 年龄段 */
  ageRange: string;
  /** 性别 (optional) */
  gender?: string;
  /** 过敏 */
  allergies: string;
  /** 长期用药 */
  medications: string;
  /** 既往情况 */
  history: string;
}

/** Symptom timeline entry. Task 17. NO severity field by design. */
export interface SymptomEntry extends BaseRecord {
  /** 发生时间 (ISO) */
  occurredAt: string;
  /** 持续时长 */
  duration: string;
  /** 原话 (required, non-empty) */
  text: string;
  /** 影响 */
  impact: string;
  /** 标签 */
  tags: string[];
  /** 单附件本地路径 (≤1, null when absent) */
  attachment: string | null;
}

/** Document excerpt with a single local attachment. Task 18. */
export interface DocumentNote extends BaseRecord {
  /** 名称 */
  name: string;
  /** 摘录 */
  excerpt: string;
  /** 来源日期 */
  sourceDate: string;
  /** 单附件本地路径 (null when absent) */
  attachment: string | null;
  /** 备注 */
  remark: string;
}

/** Where an imported question came from. */
export type QuestionSource = 'ai' | 'organizer' | 'manual';

/** A single doctor-question entry. Task 19 / task 30. */
export interface QuestionList extends BaseRecord {
  /** 问题 */
  text: string;
  /** 勾选完成 */
  done: boolean;
  /** 分组 */
  group: string;
  /** 来源 (optional) */
  source?: QuestionSource;
}

/** Assembled visit brief. Task 20. */
export interface VisitBrief extends BaseRecord {
  /** 摘要文本 */
  content: string;
  /** 来源记录 id */
  sourceIds: string[];
  /** 导出时间 (null until exported) */
  exportedAt: string | null;
}

/** Where a memory item came from. */
export type MemorySource = 'manual' | 'ai';

/** A single user-preference memory item. Task 42. No attachments. */
export interface MemoryItem extends BaseRecord {
  /** 记忆正文 (required, non-empty) */
  text: string;
  /** 来源: 手动 | AI 提炼 (default 'manual') */
  source: MemorySource;
  /** 是否启用 (default true) */
  enabled: boolean;
}

/** Memory input; `text` is required, the rest default on write. */
export interface MemoryInput {
  text: string;
  source?: MemorySource;
  enabled?: boolean;
}

/** Singleton app preferences. Tasks 12/15/16/31/42. */
export interface AppPreferences {
  /** 外部 AI 调用开关 (default false) */
  aiEnabled: boolean;
  /** 已同意的隐私说明版本 (null when never consented) */
  consentVersion: number | null;
  /** 全局字号 (default 14, clamped to 14..32) */
  fontSize: number;
  /** 高对比 (default false) */
  highContrast: boolean;
  /** AI 记忆自动提炼开关 (default true) */
  autoMemory: boolean;
  /** 演示模式开关 (default false; missing => false, additive) */
  demoMode: boolean;
  /** 左侧导航栏是否收起 (default false = 展开; missing => false, additive) */
  sidebarCollapsed: boolean;
  updatedAt: string;
}

export const DEFAULT_PREFERENCES: AppPreferences = {
  aiEnabled: false,
  consentVersion: null,
  fontSize: FONT_SIZE_DEFAULT,
  highContrast: false,
  autoMemory: true,
  demoMode: false,
  sidebarCollapsed: false,
  updatedAt: '',
};

// ---------------------------------------------------------------------------
// Input types (server-assigned id/timestamps are omitted).
// ---------------------------------------------------------------------------

export type LocalProfileInput = Omit<LocalProfile, keyof BaseRecord>;
export type SymptomInput = Omit<SymptomEntry, keyof BaseRecord>;
export type DocumentNoteInput = Omit<DocumentNote, keyof BaseRecord>;
export type QuestionInput = Omit<QuestionList, keyof BaseRecord>;
export type VisitBriefInput = Omit<VisitBrief, keyof BaseRecord>;

export type PreferencesPatch = Partial<Omit<AppPreferences, 'updatedAt'>>;

// ---------------------------------------------------------------------------
// Internal helpers.
// ---------------------------------------------------------------------------

type Dict = Record<string, unknown>;

/** Deterministic id shape: `<prefix>_<ts>_<rand>`. */
export function makeId(prefix: string): string {
  const ts = Date.now();
  let rand = Math.random().toString(36).slice(2, 8);
  if (rand === '') rand = 'x0';
  return `${prefix}_${ts}_${rand}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Keep `updatedAt` non-decreasing: never return an earlier ISO than `prev`. */
function nonDecreasingTs(prev: string | undefined, next: string): string {
  if (prev !== undefined && next < prev) return prev;
  return next;
}

function readAll<T extends BaseRecord>(key: string): T[] {
  const val = storage.get<T[]>(key, []);
  return Array.isArray(val) ? val : [];
}

function writeAll<T extends BaseRecord>(key: string, list: T[]): void {
  storage.set(key, list);
}

function clampFontSize(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : FONT_SIZE_DEFAULT;
  if (n < FONT_SIZE_MIN) return FONT_SIZE_MIN;
  if (n > FONT_SIZE_MAX) return FONT_SIZE_MAX;
  return n;
}

function normalizeQuestionKey(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

// ---------------------------------------------------------------------------
// Generic CRUD store factory.
// ---------------------------------------------------------------------------

interface StoreSpec<T extends BaseRecord, D> {
  /** Entity name, used in error messages. */
  name: string;
  /** Raw storage key (without `mhp_`). */
  key: string;
  /** Id prefix. */
  prefix: string;
  /** Enforce 0..1 records (profile). */
  singleton?: boolean;
  /** Optional validator; called with the full data object after merge on update. */
  validate?: (data: Dict) => void;
}

/**
 * CRUD surface shared by every entity.
 * - `add(data)` returns the created (or, for singletons, replaced) record.
 * - `update(id, patch)` throws a clear Error when `id` is unknown and writes
 *   nothing in that case.
 * - `remove(id)` returns whether a record was removed.
 * - `get(id)` returns the record or `null`.
 * - `list()` returns every record in insertion order.
 */
export interface EntityStore<T extends BaseRecord, D> {
  add(data: D): T;
  update(id: string, patch: Partial<D>): T;
  remove(id: string): boolean;
  get(id: string): T | null;
  list(): T[];
}

function buildStore<T extends BaseRecord, D>(spec: StoreSpec<T, D>): EntityStore<T, D> {
  const { name, key, prefix, singleton, validate } = spec;

  function add(data: D): T {
    if (validate) validate(data as unknown as Dict);
    const ts = nowIso();
    const record = {
      ...(data as object),
      id: makeId(prefix),
      createdAt: ts,
      updatedAt: ts,
    } as unknown as T;
    const list = readAll<T>(key);
    writeAll<T>(key, singleton ? [record] : list.concat(record));
    return record;
  }

  function update(id: string, patch: Partial<D>): T {
    const list = readAll<T>(key);
    const index = list.findIndex((record) => record.id === id);
    if (index === -1) {
      throw new Error(
        `[records] ${name}: cannot update unknown id "${id}" (no record written)`
      );
    }
    const prev = list[index];
    const merged = { ...(prev as object), ...(patch as object) } as Dict;
    if (validate) validate(merged);
    const next = {
      ...merged,
      id: prev.id,
      createdAt: prev.createdAt,
      updatedAt: nonDecreasingTs(prev.updatedAt, nowIso()),
    } as unknown as T;
    const nextList = list.slice();
    nextList[index] = next;
    writeAll<T>(key, nextList);
    return next;
  }

  function remove(id: string): boolean {
    const list = readAll<T>(key);
    const nextList = list.filter((record) => record.id !== id);
    if (nextList.length === list.length) return false;
    writeAll<T>(key, nextList);
    return true;
  }

  function get(id: string): T | null {
    const found = readAll<T>(key).find((record) => record.id === id);
    return found === undefined ? null : found;
  }

  function list(): T[] {
    return readAll<T>(key).slice();
  }

  return { add, update, remove, get, list };
}

// ---------------------------------------------------------------------------
// Entity stores.
// ---------------------------------------------------------------------------

function validateSymptom(data: Dict): void {
  if (typeof data.text !== 'string' || data.text.trim() === '') {
    throw new Error('[records] symptoms: text (原话) is required and must be non-empty');
  }
}

export const symptoms = buildStore<SymptomEntry, SymptomInput>({
  name: 'symptoms',
  key: ENTITY_KEYS.symptoms,
  prefix: 'sym',
  validate: validateSymptom,
});

export const notes = buildStore<DocumentNote, DocumentNoteInput>({
  name: 'notes',
  key: ENTITY_KEYS.notes,
  prefix: 'note',
});

export const briefs = buildStore<VisitBrief, VisitBriefInput>({
  name: 'briefs',
  key: ENTITY_KEYS.briefs,
  prefix: 'brief',
});

/** Singleton profile: `list()` yields 0..1; `add` replaces any existing one. */
export const profile = buildStore<LocalProfile, LocalProfileInput>({
  name: 'profile',
  key: ENTITY_KEYS.profile,
  prefix: 'prof',
  singleton: true,
});

// ---------------------------------------------------------------------------
// QuestionList store + dedupe-aware bulk import (tasks 19 / 30).
// ---------------------------------------------------------------------------

const questionStore = buildStore<QuestionList, QuestionInput>({
  name: 'questions',
  key: ENTITY_KEYS.questions,
  prefix: 'ques',
});

export interface ImportResult {
  added: QuestionList[];
  skipped: number;
}

/**
 * Bulk-import questions, de-duplicating by normalized text (trim + collapse
 * whitespace + lowercase). Existing records and duplicates within the same
 * batch are skipped. Empty texts are skipped. Writes once.
 */
function importQuestions(items: QuestionInput[]): ImportResult {
  const existing = questionStore.list();
  const seen = new Set<string>();
  for (const record of existing) {
    seen.add(normalizeQuestionKey(record.text));
  }
  const added: QuestionList[] = [];
  let skipped = 0;
  for (const item of items) {
    const text = typeof item.text === 'string' ? item.text : '';
    const key = normalizeQuestionKey(text);
    if (key === '' || seen.has(key)) {
      skipped += 1;
      continue;
    }
    seen.add(key);
    added.push(
      questionStore.add({
        text: text.trim(),
        done: item.done === true,
        group: typeof item.group === 'string' ? item.group : '',
        ...(item.source === undefined ? {} : { source: item.source }),
      })
    );
  }
  return { added, skipped };
}

export interface QuestionStore extends EntityStore<QuestionList, QuestionInput> {
  importMany(items: QuestionInput[]): ImportResult;
}

export const questions: QuestionStore = {
  ...questionStore,
  importMany: importQuestions,
};

// ---------------------------------------------------------------------------
// MemoryItem store (task 42): CRUD only, defaults materialized on write.
// ---------------------------------------------------------------------------

function validateMemory(data: Dict): void {
  if (typeof data.text !== 'string' || data.text.trim() === '') {
    throw new Error('[records] memory: text (记忆) is required and must be non-empty');
  }
  if (data.source !== undefined && data.source !== 'manual' && data.source !== 'ai') {
    throw new Error('[records] memory: source must be "manual" or "ai"');
  }
}

function normalizeMemoryInput(data: MemoryInput): MemoryInput {
  return {
    text: typeof data.text === 'string' ? data.text.trim() : data.text,
    source: data.source === 'ai' ? 'ai' : 'manual',
    enabled: data.enabled === undefined ? true : data.enabled === true,
  };
}

function normalizeMemoryPatch(patch: Partial<MemoryInput>): Partial<MemoryInput> {
  const out: Partial<MemoryInput> = {};
  if (patch.text !== undefined) out.text = patch.text.trim();
  if (patch.source !== undefined) out.source = patch.source;
  if (patch.enabled !== undefined) out.enabled = patch.enabled === true;
  return out;
}

const memoryStore = buildStore<MemoryItem, MemoryInput>({
  name: 'memory',
  key: ENTITY_KEYS.memory,
  prefix: 'mem',
  validate: validateMemory,
});

/** Memory store: trims `text` and materializes `source`/`enabled` defaults. */
export const memory: EntityStore<MemoryItem, MemoryInput> = {
  add(data: MemoryInput): MemoryItem {
    return memoryStore.add(normalizeMemoryInput(data));
  },
  update(id: string, patch: Partial<MemoryInput>): MemoryItem {
    return memoryStore.update(id, normalizeMemoryPatch(patch));
  },
  remove(id: string): boolean {
    return memoryStore.remove(id);
  },
  get(id: string): MemoryItem | null {
    return memoryStore.get(id);
  },
  list(): MemoryItem[] {
    return memoryStore.list();
  },
};

// ---------------------------------------------------------------------------
// AppPreferences (singleton, key/value — not a record list).
// ---------------------------------------------------------------------------

function readPreferences(): AppPreferences {
  const raw = storage.get<Partial<AppPreferences>>(ENTITY_KEYS.preferences, null);
  if (raw === null || typeof raw !== 'object') {
    return { ...DEFAULT_PREFERENCES };
  }
  return {
    aiEnabled: raw.aiEnabled === true,
    consentVersion:
      typeof raw.consentVersion === 'number' ? raw.consentVersion : DEFAULT_PREFERENCES.consentVersion,
    fontSize: raw.fontSize === undefined ? FONT_SIZE_DEFAULT : clampFontSize(raw.fontSize),
    highContrast: raw.highContrast === true,
    autoMemory: raw.autoMemory !== false,
    demoMode: raw.demoMode === true,
    sidebarCollapsed: raw.sidebarCollapsed === true,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
  };
}

export interface PreferencesStore {
  /** Returns stored preferences, merged over defaults when unset. */
  get(): AppPreferences;
  /** Upserts: merges `patch` over the current (possibly default) values. */
  update(patch: PreferencesPatch): AppPreferences;
  /** Removes stored preferences; the next `get()` returns defaults. */
  remove(): void;
  /** Returns `[current]` when something was stored, else `[]`. */
  list(): AppPreferences[];
}

export const preferences: PreferencesStore = {
  get(): AppPreferences {
    return readPreferences();
  },

  update(patch: PreferencesPatch): AppPreferences {
    const current = readPreferences();
    const ts = nowIso();
    const next: AppPreferences = {
      aiEnabled: patch.aiEnabled === undefined ? current.aiEnabled : patch.aiEnabled === true,
      consentVersion:
        patch.consentVersion === undefined ? current.consentVersion : patch.consentVersion,
      fontSize: patch.fontSize === undefined ? current.fontSize : clampFontSize(patch.fontSize),
      highContrast:
        patch.highContrast === undefined ? current.highContrast : patch.highContrast === true,
      autoMemory: patch.autoMemory === undefined ? current.autoMemory : patch.autoMemory === true,
      demoMode: patch.demoMode === undefined ? current.demoMode : patch.demoMode === true,
      sidebarCollapsed:
        patch.sidebarCollapsed === undefined
          ? current.sidebarCollapsed
          : patch.sidebarCollapsed === true,
      updatedAt: nonDecreasingTs(current.updatedAt === '' ? undefined : current.updatedAt, ts),
    };
    storage.set(ENTITY_KEYS.preferences, next);
    return next;
  },

  remove(): void {
    storage.remove(ENTITY_KEYS.preferences);
  },

  list(): AppPreferences[] {
    const stored = storage.get<unknown>(ENTITY_KEYS.preferences, null);
    if (stored === null || stored === undefined) return [];
    return [readPreferences()];
  },
};

// ---------------------------------------------------------------------------
// Namespaced surface.
// ---------------------------------------------------------------------------

export const records = {
  profile,
  symptoms,
  notes,
  questions,
  briefs,
  memory,
  preferences,
};

/**
 * Clear every entity record. Delegates to `storage.clearAll()`, which removes
 * only `mhp_*` keys; non-`mhp_` keys are never touched. Note: the
 * `mhp_schema_version` meta key may also be cleared — that is acceptable
 * (it re-defaults on next read).
 */
export function deleteAll(): number {
  return storage.clearAll();
}

export default records;
