// pages/home/home.ts — 个人工作台（任务 13）。
//
// 信息架构（自上而下，视觉充实版）：
//   1. 问候：按本地小时确定性生成（早上好/中午好/下午好/晚上好/夜深了），
//      档案有称呼时拼接称呼；同行右侧给出本地日期（M月D日 周X）。
//   2. 准备总览：LocalProfile 核心字段（name/ageRange/allergies/medications/
//      history）已填写数 / 5 的大号数值 + 进度条 + 提示语，并提供前往档案页的 CTA。
//   3. 记录概览：症状 / 资料 / 待问三类记录的条数，点按进入对应页（只展示计数，不写入）。
//   4. 最近 5 条记录：合并 SymptomEntry + DocumentNote + QuestionList，按
//      updatedAt 倒序（同一时刻按 key 升序稳定排序），取前 5 条回显，每条含
//      类型标签 + 摘要 + 更新时间 + 前往所属页。
//      「记录」口径：以上三类均为用户手工录入的内容记录；VisitBrief 属于由记录
//      派生的导出产物，不计入最近记录。理由记录于本文件与任务 13 提交说明。
//   5. 使用提示：固定安全提示句 + 本地优先说明（来自 config/texts.ts）。
//   全局导航（含全部 8 个页面）仍由左侧栏 app-sidebar 承载，工作台不再重复列功能入口。
//
// 数据来源：shared/services/records（纯本地，无网络）。本页只读，不写入任何记录。

import { EMPTY, HOME, PRIVACY, SAFETY } from '../../config/texts';
import { A11Y_DATA, syncA11y } from '../../shared/ui/a11y';
import { SIDEBAR_DATA, setSidebarCollapsed, syncSidebar } from '../../shared/ui/sidebar';
import { records } from '../../shared/services/records';
import type {
  DocumentNote,
  LocalProfile,
  QuestionList,
  SymptomEntry,
} from '../../shared/services/records';

/** 最近记录的一行（跨实体归一化）。 */
interface RecentRow {
  key: string;
  label: string;
  summary: string;
  updatedLabel: string;
  route: string;
}

/** 三类记录的条目数概览。 */
interface Stats {
  symptoms: number;
  notes: number;
  questions: number;
}

/** 档案完整度：核心字段与已填数量。 */
interface Completeness {
  filled: number;
  total: number;
  text: string;
  percent: number;
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

Page({
  data: {
    ...A11Y_DATA,
    ...SIDEBAR_DATA,
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
  },

  onShow() {
    syncA11y(this);
    syncSidebar(this);
    if (typeof wx.setNavigationBarColor === 'function') {
      const hc = this.data.highContrast === true;
      wx.setNavigationBarColor({
        frontColor: hc ? '#ffffff' : '#000000',
        backgroundColor: hc ? '#000000' : '#ffffff',
      });
    }
    this.refresh();
  },

  /** 侧栏收起/展开：落盘偏好并回写 data。 */
  onSidebarToggle() {
    this.setData(setSidebarCollapsed(!this.data.sidebarCollapsed));
  },

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
    wx.navigateTo({ url: '/pages/profile/profile' });
  },

  /** 记录概览卡与最近记录行共用：按 data-route 跳转。 */
  onEntryTap(event: WechatMiniprogram.TouchEvent) {
    const route = event.currentTarget.dataset.route;
    if (typeof route === 'string' && route !== '') {
      wx.navigateTo({ url: '/' + route });
    }
  },
});
