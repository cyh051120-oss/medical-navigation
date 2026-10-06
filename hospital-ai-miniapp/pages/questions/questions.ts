// pages/questions/questions.ts — 待问清单（任务 19）。
//
// 单一职责：在本机记录、编辑、删除就诊前想问的问题，勾选是否已问，并按分组展示与筛选。
// 字段严格等于 records.QuestionList：问题 text / 勾选完成 done / 分组 group /
//   来源 source（'ai'|'organizer'|'manual'，可选）。不新增任何判断类字段，界面亦不出现
//   此类文案；本页只做记录、分组与勾选，不做任何医疗判断。
//
// 具体行为：
//   - 列表：records.questions.list() 后「待问在前、分组升序、id 升序」，可选按分组筛选。
//     每行展示：问题 / 完成勾选 / 分组 / 来源 / 创建与更新时间戳，以及 编辑 / 删除。
//   - 计数：hero 展示「已完成 doneCount/total」与「待问 pendingCount」；分组统计按分组列出
//     各自 done/total。每次增删改与勾选后都重新计算，保证与存储一致。
//   - 勾选：点击方框切换 done（经 records.questions.update 持久化）。
//   - 表单：新增与编辑共用；分组为文本输入 + 已有分组快捷填入。
//   - 校验：问题 trim() 后为空时给出提示且不写入任何存储。
//   - 删除：wx.showModal 确认后经 records.questions.remove 删除。
//   - 一键导入：把多行文本或程序化传入的问题交给 records.questions.importMany 去重后写入
//     （归一化 = trim + 折叠空白 + 小写，与数据层同一规则）。返回 {imported, skipped} 并展示
//     可见提示；全部重复时明确提示「没有新增」，绝不静默。此方法即 F 波 AI 页（任务 29-33）
//     的回流入口：可传字符串数组或 {text, group?, source?} 数组；数据层 importMany 是所有
//     来源共用的去重原语，本页不新增存储键、不自建影子存储。
//   - 无障碍（任务 16 契约）：data 展开 A11Y_DATA，onShow 调 syncA11y，根节点消费
//     `--mhp-scale` 与 `is-hc`。
//
// 数据层：只经 records.questions（纯本地，无网络）；不直接调用 storage，也不自建键。
//   所有写入走整对象 setData，便于 node 端页面逻辑检查驱动真实方法。

import { BUTTONS, EMPTY, QUESTIONS } from '../../config/texts';
import { A11Y_DATA, syncA11y } from '../../shared/ui/a11y';
import { SIDEBAR_DATA, setSidebarCollapsed, syncSidebar } from '../../shared/ui/sidebar';
import { records } from '../../shared/services/records';
import type { QuestionInput, QuestionList, QuestionSource } from '../../shared/services/records';

/** 表单字段。 */
interface QuestionForm {
  text: string;
  group: string;
}

/** 列表一行（归一化后的展示数据）。 */
interface QuestionRow {
  id: string;
  text: string;
  done: boolean;
  group: string;
  groupLabel: string;
  sourceLabel: string;
  createdLabel: string;
  updatedLabel: string;
}

/** 分组统计行。 */
interface GroupStat {
  group: string;
  label: string;
  total: number;
  done: number;
}

/** 一键导入的输入项：纯文本，或带分组/来源的结构化条目。 */
export type QuestionImportItem =
  | string
  | { text: string; group?: string; source?: QuestionSource };

/** 一键导入结果：新增与跳过的条数。 */
export interface QuestionImportReport {
  imported: number;
  skipped: number;
}

const EMPTY_FORM: QuestionForm = { text: '', group: '' };
const FILTER_ALL: string = '__all__';

function pad2(value: number): string {
  return value < 10 ? '0' + value : String(value);
}

/** ISO -> `YYYY-MM-DD HH:mm`（本地）；无法解析时返回空串（不伪造时间）。 */
function formatStamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  );
}

function sourceLabelOf(source: QuestionSource | undefined, copy: typeof QUESTIONS): string {
  if (source === 'ai') return copy.sourceAi;
  if (source === 'organizer') return copy.sourceOrganizer;
  return copy.sourceManual;
}

/** 把粘贴文本切成问题行：按行拆分、trim、去空行。 */
function splitImportText(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/**
 * 归一化导入项为 records.QuestionInput：逐项 trim，应用默认分组/来源。
 * 与数据层 importMany 的归一化规则一致（此处只负责组装，不重复去重逻辑）。
 */
function toImportInputs(
  items: QuestionImportItem[],
  defaultGroup: string,
  defaultSource: QuestionSource
): QuestionInput[] {
  const inputs: QuestionInput[] = [];
  for (const item of items) {
    if (typeof item === 'string') {
      inputs.push({ text: item, done: false, group: defaultGroup, source: defaultSource });
      continue;
    }
    inputs.push({
      text: item.text,
      done: false,
      group: typeof item.group === 'string' ? item.group : defaultGroup,
      source: item.source === undefined ? defaultSource : item.source,
    });
  }
  return inputs;
}

/** 选择器：按分组升序、再按 id 升序稳定排序（待问在前）。 */
function compareRows(a: QuestionRow, b: QuestionRow): number {
  if (a.done !== b.done) return a.done ? 1 : -1;
  if (a.group !== b.group) return a.group < b.group ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

Page({
  data: {
    ...A11Y_DATA,
    ...SIDEBAR_DATA,
    rows: [] as QuestionRow[],
    hasRecords: false,
    total: 0,
    doneCount: 0,
    pendingCount: 0,
    groupStats: [] as GroupStat[],
    hasGroups: false,
    groupChips: [] as string[],
    filterOptions: [QUESTIONS.filterAll as string] as string[],
    filterIndex: 0,
    filterValue: FILTER_ALL,
    filterLabel: QUESTIONS.filterAll as string,
    formOpen: false,
    editingId: '',
    form: { ...EMPTY_FORM } as QuestionForm,
    errorText: '',
    importOpen: false,
    importText: '',
    importGroup: '',
    importHint: '',
    importReport: null as QuestionImportReport | null,
    copy: QUESTIONS,
    buttons: BUTTONS,
    emptyText: EMPTY.questions,
  },

  onShow() {
    syncA11y(this);
    syncSidebar(this);
    this.refresh();
  },

  /** 侧栏收起/展开：落盘偏好并回写 data。 */
  onSidebarToggle() {
    this.setData(setSidebarCollapsed(!this.data.sidebarCollapsed));
  },

  /** 重新读取本地问题并刷新列表、计数与分组统计（返回本页时也会触发）。 */
  refresh() {
    const all = records.questions.list();
    const copy = this.data.copy;

    const rows: QuestionRow[] = all.map((item) => {
      const group = typeof item.group === 'string' ? item.group : '';
      return {
        id: item.id,
        text: item.text,
        done: item.done === true,
        group,
        groupLabel: group === '' ? copy.noGroup : group,
        sourceLabel: sourceLabelOf(item.source, copy),
        createdLabel: formatStamp(item.createdAt),
        updatedLabel: formatStamp(item.updatedAt),
      };
    });

    const groupOrder: string[] = [];
    const groupMap: Record<string, GroupStat> = {};
    for (const row of rows) {
      if (groupMap[row.group] === undefined) {
        groupMap[row.group] = { group: row.group, label: row.groupLabel, total: 0, done: 0 };
        groupOrder.push(row.group);
      }
      groupMap[row.group].total += 1;
      if (row.done) groupMap[row.group].done += 1;
    }
    const groupStats = groupOrder
      .map((group) => groupMap[group])
      .sort((a, b) => (a.group < b.group ? -1 : a.group > b.group ? 1 : 0));

    const selectedFilter = this.data.filterValue;
    const filterValue = groupStats.some((stat) => stat.group === selectedFilter)
      ? selectedFilter
      : FILTER_ALL;
    const filterOptions: string[] = [copy.filterAll, ...groupStats.map((stat) => stat.label)];
    const filterIndex = filterValue === FILTER_ALL
      ? 0
      : groupStats.map((stat) => stat.group).indexOf(filterValue) + 1;

    const visible = rows
      .filter((row) => filterValue === FILTER_ALL || row.group === filterValue)
      .sort(compareRows);

    const doneCount = rows.filter((row) => row.done).length;
    const groupChips = groupStats.map((stat) => stat.group).filter((group) => group !== '');

    this.setData({
      rows: visible,
      hasRecords: rows.length > 0,
      total: rows.length,
      doneCount,
      pendingCount: rows.length - doneCount,
      groupStats,
      hasGroups: groupStats.length > 0,
      groupChips,
      filterOptions,
      filterIndex,
      filterValue,
      filterLabel: groupStats.some((stat) => stat.group === filterValue)
        ? groupStats[groupStats.map((stat) => stat.group).indexOf(filterValue)].label
        : copy.filterAll,
    });
  },

  // ----- 表单 -----

  onAdd() {
    this.setData({
      formOpen: true,
      editingId: '',
      form: { ...EMPTY_FORM },
      errorText: '',
    });
  },

  onEdit(event: WechatMiniprogram.TouchEvent) {
    const id = event.currentTarget.dataset.id;
    if (typeof id !== 'string' || id === '') return;
    const record = records.questions.get(id);
    if (record === null) return;
    this.setData({
      formOpen: true,
      editingId: record.id,
      form: { text: record.text, group: record.group },
      errorText: '',
    });
    if (typeof wx.vibrateShort === 'function') wx.vibrateShort({ type: 'light' });
  },

  onCancelForm() {
    this.setData({
      formOpen: false,
      editingId: '',
      form: { ...EMPTY_FORM },
      errorText: '',
    });
  },

  onTextInput(event: WechatMiniprogram.TextareaInput) {
    this.setData({ form: { ...this.data.form, text: event.detail.value }, errorText: '' });
  },

  onGroupInput(event: WechatMiniprogram.Input) {
    this.setData({ form: { ...this.data.form, group: event.detail.value }, errorText: '' });
  },

  /** 已有分组快捷填入表单。 */
  onGroupChipPick(event: WechatMiniprogram.TouchEvent) {
    const value = event.currentTarget.dataset.value;
    if (typeof value !== 'string') return;
    this.setData({ form: { ...this.data.form, group: value }, errorText: '' });
  },

  /** 保存：问题 trim 后为空 -> 提示且不写入。编辑走 update，新增走 add（来源=手动）。 */
  onSave() {
    const form = this.data.form;
    const text = form.text.trim();
    if (text === '') {
      this.setData({ errorText: this.data.copy.requiredHint });
      if (typeof wx.showToast === 'function') {
        wx.showToast({ title: this.data.copy.requiredHint, icon: 'none' });
      }
      return;
    }

    const group = form.group.trim();
    if (this.data.editingId !== '') {
      records.questions.update(this.data.editingId, { text, group });
    } else {
      const input: QuestionInput = { text, done: false, group, source: 'manual' };
      records.questions.add(input);
    }

    this.setData({
      formOpen: false,
      editingId: '',
      form: { ...EMPTY_FORM },
      errorText: '',
    });
    this.refresh();
    if (typeof wx.vibrateShort === 'function') wx.vibrateShort({ type: 'light' });
    if (typeof wx.showToast === 'function') {
      wx.showToast({ title: this.data.copy.savedHint, icon: 'success' });
    }
  },

  // ----- 勾选 / 删除 / 筛选 -----

  /** 勾选切换 done 状态并持久化。 */
  onToggleDone(event: WechatMiniprogram.TouchEvent) {
    const id = event.currentTarget.dataset.id;
    if (typeof id !== 'string' || id === '') return;
    const record = records.questions.get(id);
    if (record === null) return;
    records.questions.update(id, { done: record.done !== true });
    this.refresh();
  },

  /** 删除：确认后删除记录。 */
  onDelete(event: WechatMiniprogram.TouchEvent) {
    const id = event.currentTarget.dataset.id;
    if (typeof id !== 'string' || id === '') return;
    const doDelete = () => {
      records.questions.remove(id);
      if (this.data.editingId === id) {
        this.setData({
          formOpen: false,
          editingId: '',
          form: { ...EMPTY_FORM },
          errorText: '',
        });
      }
      this.refresh();
      if (typeof wx.showToast === 'function') {
        wx.showToast({ title: this.data.copy.deletedHint, icon: 'none' });
      }
    };

    if (typeof wx.showModal === 'function') {
      wx.showModal({
        title: this.data.copy.deleteTitle,
        content: this.data.copy.deleteConfirm,
        success: (res) => {
          if (res.confirm) doDelete();
        },
      });
    } else {
      doDelete();
    }
  },

  onFilterChange(event: WechatMiniprogram.PickerChange) {
    const index = Number(event.detail.value);
    const stats = this.data.groupStats;
    const nextIndex = Number.isFinite(index) && index >= 0 ? index : 0;
    const filterValue =
      nextIndex > 0 && nextIndex - 1 < stats.length ? stats[nextIndex - 1].group : FILTER_ALL;
    this.setData({ filterValue, filterIndex: nextIndex });
    this.refresh();
  },

  // ----- 一键导入（AI / 整理器回流入口）-----

  onToggleImport() {
    this.setData({ importOpen: !this.data.importOpen, importHint: '', importReport: null });
  },

  onImportTextInput(event: WechatMiniprogram.TextareaInput) {
    this.setData({ importText: event.detail.value, importHint: '', importReport: null });
  },

  onImportGroupInput(event: WechatMiniprogram.Input) {
    this.setData({ importGroup: event.detail.value });
  },

  onImportGroupChipPick(event: WechatMiniprogram.TouchEvent) {
    const value = event.currentTarget.dataset.value;
    if (typeof value !== 'string') return;
    this.setData({ importGroup: value });
  },

  /**
   * 一键导入入口。作为界面事件处理器时接收事件对象（读取粘贴文本）；程序化调用（AI 页回流）
   * 时可传字符串数组或 {text, group?, source?} 数组。经 records.questions.importMany 归一化
   * 去重，只写入新问题，返回 {imported, skipped} 并在页面展示可见提示（全部重复时明确提示）。
   */
  onImportQuestions(
    arg?: WechatMiniprogram.TouchEvent | QuestionImportItem[]
  ): QuestionImportReport {
    const copy = this.data.copy;
    let items: QuestionImportItem[];
    let group: string;
    let source: QuestionSource;

    if (Array.isArray(arg)) {
      items = arg;
      group = '';
      source = 'manual';
    } else {
      items = splitImportText(this.data.importText);
      group = this.data.importGroup.trim();
      source = 'manual';
    }

    if (items.length === 0) {
      this.setData({ importHint: copy.importEmpty, importReport: null });
      if (typeof wx.showToast === 'function') {
        wx.showToast({ title: copy.importEmpty, icon: 'none' });
      }
      return { imported: 0, skipped: 0 };
    }

    const result = records.questions.importMany(toImportInputs(items, group, source));
    const report: QuestionImportReport = { imported: result.added.length, skipped: result.skipped };

    let hint: string;
    if (report.imported === 0) {
      hint = copy.importAllDup;
    } else {
      hint =
        `${copy.importAddedPrefix} ${report.imported} 条，` +
        `${copy.importSkippedPrefix} ${report.skipped} 条`;
    }

    this.setData({
      importHint: hint,
      importReport: report,
      importText: '',
    });
    this.refresh();
    if (typeof wx.vibrateShort === 'function') wx.vibrateShort({ type: 'light' });

    return report;
  },
});
