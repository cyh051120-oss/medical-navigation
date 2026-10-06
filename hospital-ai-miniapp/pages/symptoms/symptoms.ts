// pages/symptoms/symptoms.ts — 症状时间线（任务 17）。
//
// 单一职责：在本机记录、编辑、删除症状条目，并按发生时间倒序展示。
// 字段严格等于 records.SymptomEntry：发生时间 occurredAt（ISO）/ 持续时长 duration /
//   原话 text（必填非空）/ 影响 impact / 标签 tags[] / 单附件 attachment（≤1，
//   string|null）。不新增任何判断类字段，界面亦不出现此类文案。
//
// 具体行为：
//   - 列表：records.symptoms.list() 后按 occurredAt 倒序（同一时刻按 id 升序稳定排序）。
//     每行展示：发生时间 / 持续时长 / 原话 / 影响 / 标签 / 附件指示 / 创建与更新时间戳。
//   - 表单：新增与编辑共用；时间用日期+时间选择器拼成 ISO；标签以逗号分隔文本录入，
//     保存时切分为字符串数组（去空、去重、保序）。编辑时载入原值，可整条保存。
//   - 校验：原话 trim() 后为空时给出错误提示且不写入任何存储（记录层亦会拒绝）。
//   - 删除：弹出确认后经 attachments.deleteRecordWithAttachment 删除记录并同步删附件。
//   - 附件：最多 1 个。新增经 attachments.addWithAttachment；编辑选新附件时经
//     attachments.replaceAttachment（替换即先删旧文件）。附件仅本地保存与展示，不判读。
//   - 无障碍（任务 16 契约）：data 展开 A11Y_DATA，onShow 调 syncA11y，根节点消费
//     `--mhp-scale` 与 `is-hc`。
//
// 数据层：只经 records.symptoms 与 attachments（均纯本地，无网络）；不直接调用
//   storage，也不自建键。所有写入走整对象 setData，便于 node 端页面逻辑检查驱动真实方法。

import { BUTTONS, EMPTY, SYMPTOMS } from '../../config/texts';
import { A11Y_DATA, syncA11y } from '../../shared/ui/a11y';
import { SIDEBAR_DATA, setSidebarCollapsed, syncSidebar } from '../../shared/ui/sidebar';
import { records } from '../../shared/services/records';
import {
  addWithAttachment,
  deleteRecordWithAttachment,
  replaceAttachment,
} from '../../shared/services/attachments';
import type { SymptomEntry, SymptomInput } from '../../shared/services/records';

/** 表单字段；时间拆成日期与时间两段便于 picker 绑定。 */
interface SymptomForm {
  date: string;
  time: string;
  duration: string;
  text: string;
  impact: string;
  tagsText: string;
}

/** 时间线一行（跨实体归一化后的展示数据）。 */
interface SymptomRow {
  id: string;
  occurredAt: string;
  occurredLabel: string;
  duration: string;
  text: string;
  impact: string;
  tags: string[];
  hasAttachment: boolean;
  attachmentName: string;
  createdLabel: string;
  updatedLabel: string;
}

const EMPTY_FORM: SymptomForm = {
  date: '',
  time: '',
  duration: '',
  text: '',
  impact: '',
  tagsText: '',
};

function pad2(value: number): string {
  return value < 10 ? '0' + value : String(value);
}

function baseName(filePath: string): string {
  const slash = filePath.lastIndexOf('/');
  return slash === -1 ? filePath : filePath.slice(slash + 1);
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

/** ISO -> picker 的 { date: 'YYYY-MM-DD', time: 'HH:mm' }（本地）。 */
function isoToParts(iso: string): { date: string; time: string } {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return { date: '', time: '' };
  return {
    date: `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`,
    time: `${pad2(date.getHours())}:${pad2(date.getMinutes())}`,
  };
}

/** 当前本地时间的 picker 片段。 */
function nowParts(): { date: string; time: string } {
  return isoToParts(new Date().toISOString());
}

/** 日期 + 时间 -> ISO；任一段缺失或非法时回退到当前时刻。 */
function toIso(date: string, time: string): string {
  if (date === '' || time === '') return new Date().toISOString();
  const parsed = new Date(`${date}T${time}:00`);
  if (Number.isNaN(parsed.getTime())) return new Date().toISOString();
  return parsed.toISOString();
}

/** 逗号分隔文本 -> 标签数组（去空、去重、保序）。中英文逗号/顿号/换行均作分隔符。 */
function splitTags(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const piece of text.split(/[,，、\n]+/)) {
    const tag = piece.trim();
    if (tag === '' || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

function joinTags(tags: string[]): string {
  return tags.join(', ');
}

/** 读取列表并归一化为展示行，按发生时间倒序（同一时刻按 id 升序稳定）。 */
function buildRows(list: SymptomEntry[]): SymptomRow[] {
  const rows = list.map((item) => ({
    id: item.id,
    occurredAt: item.occurredAt,
    occurredLabel: formatStamp(item.occurredAt),
    duration: item.duration,
    text: item.text,
    impact: item.impact,
    tags: Array.isArray(item.tags) ? item.tags.slice() : [],
    hasAttachment: typeof item.attachment === 'string' && item.attachment !== '',
    attachmentName:
      typeof item.attachment === 'string' && item.attachment !== '' ? baseName(item.attachment) : '',
    createdLabel: formatStamp(item.createdAt),
    updatedLabel: formatStamp(item.updatedAt),
  }));
  rows.sort((a, b) => {
    if (a.occurredAt !== b.occurredAt) return a.occurredAt < b.occurredAt ? 1 : -1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return rows;
}

Page({
  data: {
    ...A11Y_DATA,
    ...SIDEBAR_DATA,
    rows: [] as SymptomRow[],
    hasRecords: false,
    formOpen: false,
    editingId: '',
    form: { ...EMPTY_FORM } as SymptomForm,
    pendingAttachment: '',
    existingAttachment: '',
    attachmentName: '',
    errorText: '',
    copy: SYMPTOMS,
    buttons: BUTTONS,
    emptyText: EMPTY.symptoms,
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

  /** 重新读取本地症状记录并刷新列表（返回本页时也会触发）。 */
  refresh() {
    const rows = buildRows(records.symptoms.list());
    this.setData({ rows, hasRecords: rows.length > 0 });
  },

  // ----- 表单 -----

  onAdd() {
    const now = nowParts();
    this.setData({
      formOpen: true,
      editingId: '',
      form: { date: now.date, time: now.time, duration: '', text: '', impact: '', tagsText: '' },
      pendingAttachment: '',
      existingAttachment: '',
      attachmentName: '',
      errorText: '',
    });
  },

  onEdit(event: WechatMiniprogram.TouchEvent) {
    const id = event.currentTarget.dataset.id;
    if (typeof id !== 'string' || id === '') return;
    const record = records.symptoms.get(id);
    if (record === null) return;
    const parts = isoToParts(record.occurredAt);
    const attachment = typeof record.attachment === 'string' ? record.attachment : '';
    this.setData({
      formOpen: true,
      editingId: record.id,
      form: {
        date: parts.date,
        time: parts.time,
        duration: record.duration,
        text: record.text,
        impact: record.impact,
        tagsText: joinTags(record.tags),
      },
      pendingAttachment: '',
      existingAttachment: attachment,
      attachmentName: attachment === '' ? '' : baseName(attachment),
      errorText: '',
    });
    if (typeof wx.vibrateShort === 'function') wx.vibrateShort({ type: 'light' });
  },

  onCancelForm() {
    this.setData({
      formOpen: false,
      editingId: '',
      form: { ...EMPTY_FORM },
      pendingAttachment: '',
      existingAttachment: '',
      attachmentName: '',
      errorText: '',
    });
  },

  onDateChange(event: WechatMiniprogram.PickerChange) {
    const value = String(event.detail.value);
    this.setData({ form: { ...this.data.form, date: value }, errorText: '' });
  },

  onTimeChange(event: WechatMiniprogram.PickerChange) {
    const value = String(event.detail.value);
    this.setData({ form: { ...this.data.form, time: value }, errorText: '' });
  },

  onTextInput(event: WechatMiniprogram.TextareaInput) {
    this.setData({ form: { ...this.data.form, text: event.detail.value }, errorText: '' });
  },

  onDurationInput(event: WechatMiniprogram.Input) {
    this.setData({ form: { ...this.data.form, duration: event.detail.value }, errorText: '' });
  },

  onImpactInput(event: WechatMiniprogram.Input) {
    this.setData({ form: { ...this.data.form, impact: event.detail.value }, errorText: '' });
  },

  onTagsInput(event: WechatMiniprogram.Input) {
    this.setData({ form: { ...this.data.form, tagsText: event.detail.value }, errorText: '' });
  },

  /** 选择 1 个附件（图片）：仅记录临时路径，保存时才落盘。 */
  onPickAttachment() {
    if (typeof wx.chooseMedia !== 'function') return;
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const files = res.tempFiles;
        const temp = files && files.length > 0 ? files[0].tempFilePath : '';
        if (typeof temp === 'string' && temp !== '') {
          this.setData({ pendingAttachment: temp, attachmentName: baseName(temp) });
        }
      },
    });
  },

  /**
   * 保存：原话 trim 后为空 -> 提示且不写入。编辑走 update（更换附件时另经
   * replaceAttachment），新增走 addWithAttachment。成功后刷新列表并关闭表单。
   */
  onSave() {
    const form = this.data.form;
    const text = form.text.trim();
    if (text === '') {
      this.setData({ errorText: SYMPTOMS.requiredHint });
      if (typeof wx.showToast === 'function') wx.showToast({ title: SYMPTOMS.requiredHint, icon: 'none' });
      return;
    }

    const occurredAt = toIso(form.date, form.time);
    const duration = form.duration.trim();
    const impact = form.impact.trim();
    const tags = splitTags(form.tagsText);

    if (this.data.editingId !== '') {
      const id = this.data.editingId;
      const patch: Partial<SymptomInput> = { occurredAt, duration, text, impact, tags };
      if (this.data.pendingAttachment !== '') {
        records.symptoms.update(id, patch);
        replaceAttachment(records.symptoms, id, this.data.pendingAttachment);
      } else {
        records.symptoms.update(id, {
          ...patch,
          attachment: this.data.existingAttachment === '' ? null : this.data.existingAttachment,
        });
      }
    } else {
      const input: SymptomInput = {
        occurredAt,
        duration,
        text,
        impact,
        tags,
        attachment: null,
      };
      addWithAttachment(
        records.symptoms,
        input,
        this.data.pendingAttachment === '' ? null : this.data.pendingAttachment
      );
    }

    this.setData({
      formOpen: false,
      editingId: '',
      form: { ...EMPTY_FORM },
      pendingAttachment: '',
      existingAttachment: '',
      attachmentName: '',
      errorText: '',
    });
    this.refresh();
    if (typeof wx.vibrateShort === 'function') wx.vibrateShort({ type: 'light' });
    if (typeof wx.showToast === 'function') wx.showToast({ title: SYMPTOMS.savedHint, icon: 'success' });
  },

  /** 删除：确认后删除记录并同步删除其附件。 */
  onDelete(event: WechatMiniprogram.TouchEvent) {
    const id = event.currentTarget.dataset.id;
    if (typeof id !== 'string' || id === '') return;
    const doDelete = () => {
      deleteRecordWithAttachment(records.symptoms, id);
      if (this.data.editingId === id) {
        this.setData({
          formOpen: false,
          editingId: '',
          form: { ...EMPTY_FORM },
          pendingAttachment: '',
          existingAttachment: '',
          attachmentName: '',
          errorText: '',
        });
      }
      this.refresh();
      if (typeof wx.showToast === 'function') wx.showToast({ title: SYMPTOMS.deletedHint, icon: 'none' });
    };

    if (typeof wx.showModal === 'function') {
      wx.showModal({
        title: SYMPTOMS.deleteTitle,
        content: SYMPTOMS.deleteConfirm,
        success: (res) => {
          if (res.confirm) doDelete();
        },
      });
    } else {
      doDelete();
    }
  },
});
