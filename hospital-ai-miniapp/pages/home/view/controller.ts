// pages/home/view/controller.ts — 个人工作台（任务 13）的纯逻辑单源。
//
// 双宿主契约：本模块只导出两个纯对象工厂（homeData / homeMethods），模块求值时无副作用、
// 无平台生命周期，也不使用平台 behaviors——wrapper 页与 workspace section 组件各自把工厂
// 返回的对象展开进自己的配置，从而保证「面契约」（data 键集 / 方法名集）在两条宿主上一致。
//
// 信息架构与记录口径同原 pages/home/home.ts：问候 → 准备总览 → 记录概览 → 最近记录 →
// 使用提示。数据来源 shared/services/records（纯本地）；本模块只读，不写入任何记录。
//
// 导航 seam：controller 内的路由跳转统一经 hostNavigate（见 SectionHost），缺省回落到
// wx.navigateTo，writer wrapper 因此行为与重构前一致；workspace section 可注入内存切换实现。

import { EMPTY, HOME, PRIVACY, SAFETY } from '../../../config/texts';
import { records } from '../../../shared/services/records';
import type {
  DocumentNote,
  LocalProfile,
  QuestionList,
  SymptomEntry,
} from '../../../shared/services/records';

/** 最近记录的一行（跨实体归一化）。 */
export interface RecentRow {
  key: string;
  label: string;
  summary: string;
  updatedLabel: string;
  route: string;
}

/** 三类记录的条目数概览。 */
export interface Stats {
  symptoms: number;
  notes: number;
  questions: number;
}

/** 档案完整度：核心字段与已填数量。 */
export interface Completeness {
  filled: number;
  total: number;
  text: string;
  percent: number;
}

/**
 * section 的最小宿主契约：可选提供内存内导航（workspace 单页宿主注入）。
 * 未实现时路由跳转回落到 wx.navigateTo（wrapper 页的既有行为）。
 */
export interface SectionHost {
  hostNavigate?: (route: string) => void;
}

/** homeMethods 工厂内 `this` 需要的最小实例面（setData 由 Page / Component 提供）。 */
interface HomeSectionInstance extends SectionHost {
  setData(patch: Record<string, unknown>): void;
}

/** home section 可调用方法名（面契约）：与重构前 pages/home/home.ts 逐一相同。 */
export interface HomeMethods {
  refresh(): void;
  onProfileTap(): void;
  onEntryTap(event: WechatMiniprogram.TouchEvent): void;
}

/**
 * 档案核心字段（不含可选 gender）。
 * 完整度 = 已填核心字段数 / 5；空串与纯空白视为未填。
 */
const PROFILE_CORE_FIELDS = ['name', 'ageRange', 'allergies', 'medications', 'history'] as const;

const RECENT_LIMIT = 5;

/**
 * config/texts.ts 的 LABELS 未定义记录类型标签，故此处使用极短的类型标记；
 * 属于界面微文案，不构成需要集中的长文案。
 */
const RECORD_META = {
  symptom: { label: '症状', route: 'pages/symptoms/symptoms' },
  note: { label: '资料', route: 'pages/notes/notes' },
  question: { label: '待问', route: 'pages/questions/questions' },
} as const;

/** 按本地小时确定性生成问候语（无随机）。 */
function greetingFor(hour: number): string {
  if (hour >= 5 && hour < 11) return '早上好';
  if (hour >= 11 && hour < 13) return '中午好';
  if (hour >= 13 && hour < 18) return '下午好';
  if (hour >= 18 && hour < 23) return '晚上好';
  return '夜深了';
}

/** 本地日期标签 `M月D日 周X`（确定性，无随机）。 */
const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'] as const;

function todayLabelFor(date: Date): string {
  return `${date.getMonth() + 1}月${date.getDate()}日 周${WEEKDAY_LABELS[date.getDay()]}`;
}

/** 截断摘要，超出加省略号。 */
function shorten(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max) + '…';
}

function pad2(value: number): string {
  return value < 10 ? '0' + value : String(value);
}

/** ISO -> `MM-DD HH:mm`；无法解析时返回空串（不伪造时间）。 */
function formatStamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** 合并三类记录，按 updatedAt 倒序 + key 升序稳定排序，取前 5。 */
function buildRecentRecords(
  symptoms: SymptomEntry[],
  notes: DocumentNote[],
  questions: QuestionList[]
): RecentRow[] {
  const stamped: { row: RecentRow; updatedAt: string }[] = [];
  for (const item of symptoms) {
    stamped.push({
      updatedAt: item.updatedAt,
      row: {
        key: `symptom:${item.id}`,
        label: RECORD_META.symptom.label,
        summary: shorten(item.text, 22),
        updatedLabel: formatStamp(item.updatedAt),
        route: RECORD_META.symptom.route,
      },
    });
  }
  for (const item of notes) {
    stamped.push({
      updatedAt: item.updatedAt,
      row: {
        key: `note:${item.id}`,
        label: RECORD_META.note.label,
        summary: shorten(item.name !== '' ? item.name : item.excerpt, 22),
        updatedLabel: formatStamp(item.updatedAt),
        route: RECORD_META.note.route,
      },
    });
  }
  for (const item of questions) {
    stamped.push({
      updatedAt: item.updatedAt,
      row: {
        key: `question:${item.id}`,
        label: RECORD_META.question.label,
        summary: shorten(item.text, 22),
        updatedLabel: formatStamp(item.updatedAt),
        route: RECORD_META.question.route,
      },
    });
  }
  stamped.sort((a, b) => {
    if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
    return a.row.key < b.row.key ? -1 : a.row.key > b.row.key ? 1 : 0;
  });
  return stamped.slice(0, RECENT_LIMIT).map((item) => item.row);
}

/** 计算档案完整度。 */
function computeCompleteness(profile: LocalProfile | null): Completeness {
  const total = PROFILE_CORE_FIELDS.length;
  let filled = 0;
  if (profile !== null) {
    for (const field of PROFILE_CORE_FIELDS) {
      if (profile[field].trim() !== '') filled += 1;
    }
  }
  return {
    filled,
    total,
    text: `已完善 ${filled}/${total}`,
    percent: Math.round((filled / total) * 100),
  };
}

/** 工作台初始 data（面契约）：wrapper 与 workspace section 共用。 */
export function homeData() {
  return {
    greeting: '',
    profileName: '',
    completeness: { filled: 0, total: PROFILE_CORE_FIELDS.length, text: '', percent: 0 } as Completeness,
    home: HOME,
    profileLinkLabel: HOME.profilePending as string,
    todayLabel: '' as string,
    stats: { symptoms: 0, notes: 0, questions: 0 } as Stats,
    profileHint: HOME.profileTodoHint as string,
    safetyFixed: SAFETY.fixed as string,
    privacyFixed: PRIVACY.localFirst as string,
    recentRecords: [] as RecentRow[],
    hasRecords: false,
    emptyRecordsText: EMPTY.records,
  };
}

/** 工作台可调用方法（面契约）：wrapper 与 workspace section 共用。 */
export function homeMethods(): HomeMethods & ThisType<HomeSectionInstance> {
  return {
    /** 重新读取本地记录并刷新工作台（返回到本页时也会触发，保证数据新鲜）。 */
    refresh() {
      const profiles = records.profile.list();
      const profile: LocalProfile | null = profiles.length > 0 ? profiles[0] : null;
      const symptoms = records.symptoms.list();
      const notes = records.notes.list();
      const questions = records.questions.list();
      const recentRecords = buildRecentRecords(symptoms, notes, questions);
      const completeness = computeCompleteness(profile);
      this.setData({
        greeting: greetingFor(new Date().getHours()),
        profileName: profile !== null ? profile.name.trim() : '',
        completeness,
        todayLabel: todayLabelFor(new Date()),
        stats: { symptoms: symptoms.length, notes: notes.length, questions: questions.length },
        // 档案齐全后「去完善」不再成立，改为「去看看」（不骗用户点一个没有意义的动作）。
        profileLinkLabel:
          completeness.filled >= completeness.total ? HOME.profileDone : HOME.profilePending,
        profileHint:
          completeness.filled >= completeness.total ? HOME.profileReadyHint : HOME.profileTodoHint,
        recentRecords,
        hasRecords: recentRecords.length > 0,
      });
    },

    onProfileTap() {
      const host = this as unknown as SectionHost;
      const route = 'pages/profile/profile';
      host.hostNavigate ? host.hostNavigate(route) : wx.navigateTo({ url: '/' + route });
    },

    /** 记录概览卡与最近记录行共用：按 data-route 跳转。 */
    onEntryTap(event: WechatMiniprogram.TouchEvent) {
      const route = event.currentTarget.dataset.route;
      if (typeof route === 'string' && route !== '') {
        const host = this as unknown as SectionHost;
        host.hostNavigate ? host.hostNavigate(route) : wx.navigateTo({ url: '/' + route });
      }
    },
  };
}
