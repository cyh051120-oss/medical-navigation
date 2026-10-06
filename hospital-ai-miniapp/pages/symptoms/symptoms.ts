// pages/symptoms/symptoms.ts — 症状时间线（任务 17）。
//
// 单一职责：在本机记录、编辑、删除症状条目，并按发生时间倒序展示。
// 字段严格等于 records.SymptomEntry：发生时间 occurredAt（ISO；未知为 ''）/
//   occurredAtText（无法规范化的原话，如「昨天晚上」）/ 持续时长 duration /
//   原话 text（必填非空）/ 影响 impact / 标签 tags[] / 单附件 attachment（≤1，
//   string|null）。不新增任何判断类字段，界面亦不出现此类文案。
//
// 具体行为：
//   - 列表：records.symptoms.list() 后按发生时间倒序（不可解析时回退 createdAt；
//     同一时刻按 id 升序稳定排序）。
//   - 表单：新增与编辑共用；时间用日期+时间选择器拼成 ISO（UTC+8）。编辑时载入原值，
//     未改动时间则保存时省略 occurredAt（绝不静默改写为当前时刻）；改动但不完整时报错。
//   - 校验：原话 trim() 后为空时给出错误提示且不写入任何存储。
//   - 删除：弹出确认后经 attachments.deleteRecordWithAttachment 删除记录并同步删附件。
//   - 附件：最多 1 个。新增经 attachments.addWithAttachment；编辑选新附件时经
//     attachments.replaceAttachment（先存新文件、成功后才删旧文件）。两条路径都消费
//     返回的 notice/warning 并给出条件反馈，不再无条件谎报成功。
//   - 无障碍（任务 16 契约）：data 展开 A11Y_DATA，onShow 调 syncA11y，根节点消费
//     `--mhp-scale` 与 `is-hc`。

import { BUTTONS, EMPTY, SYMPTOMS } from '../../config/texts';
import { A11Y_DATA, syncA11y } from '../../shared/ui/a11y';
import { SIDEBAR_DATA, setSidebarCollapsed, syncSidebar } from '../../shared/ui/sidebar';
import { records } from '../../shared/services/records';
import {
  addWithAttachment,
  deleteRecordWithAttachment,
  replaceAttachment,
} from '../../shared/services/attachments';
import { formatStamp, isoToWallClock, wallClockToIso, nowWallClock } from '../../shared/utils/time';
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

function baseName(filePath: string): string {
  const slash = filePath.lastIndexOf('/');
  return slash === -1 ? filePath : filePath.slice(slash + 1);
}

/** 排序键：优先 occurredAt，不可解析时回退 createdAt，再不行回退 0。 */
function symptomSortMs(item: SymptomEntry): number {
  const occurred = Date.parse(item.occurredAt);
  if (Number.isFinite(occurred)) return occurred;
  const created = Date.parse(item.createdAt);
  return Number.isFinite(created) ? created : 0;
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

/** 展示用发生时间：ISO 本地化；否则显示用户原话 occurredAtText；都没有则空。 */
function occurredLabelOf(item: SymptomEntry): string {
  const stamp = formatStamp(item.occurredAt);
  if (stamp !== '') return stamp;
  return typeof item.occurredAtText === 'string' ? item.occurredAtText : '';
}

/** 读取列表并归一化为展示行，按发生时间倒序（不可解析回退 createdAt；同键按 id 升序）。 */
function buildRows(list: SymptomEntry[]): SymptomRow[] {
  const rows = list.map((item) => ({
    id: item.id,
    occurredLabel: occurredLabelOf(item),
    duration: item.duration,
    text: item.text,
    impact: item.impact,
    tags: Array.isArray(item.tags) ? item.tags.slice() : [],
    hasAttachment: typeof item.attachment === 'string' && item.attachment !== '',
    attachmentName:
      typeof item.attachment === 'string' && item.attachment !== '' ? baseName(item.attachment) : '',
    createdLabel: formatStamp(item.createdAt),
    updatedLabel: formatStamp(item.updatedAt),
    sortMs: symptomSortMs(item),
  }));
  rows.sort((a, b) => {
    if (a.sortMs !== b.sortMs) return a.sortMs > b.sortMs ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return rows.map(({ sortMs, ...row }) => row);
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
    initialDate: '',
    initialTime: '',
    pendingAttachment: '',
    existingAttachment: '',
    attachmentName: '',
    picking: false,
    errorText: '',
    copy: SYMPTOMS,
    buttons: BUTTONS,
    emptyText: EMPTY.symptoms,
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

  /** 重新读取本地症状记录并刷新列表（返回本页时也会触发）。 */
  refresh() {
    let rows: SymptomRow[] = [];
    try {
      rows = buildRows(records.symptoms.list());
    } catch (e) {
      rows = [];
    }
    this.setData({ rows, hasRecords: rows.length > 0 });
  },

  // ----- 表单 -----

  onAdd() {
    const now = nowWallClock();
    this.setData({
      formOpen: true,
      editingId: '',
      form: { date: now.date, time: now.time, duration: '', text: '', impact: '', tagsText: '' },
      initialDate: now.date,
      initialTime: now.time,
      pendingAttachment: '',
      existingAttachment: '',
      attachmentName: '',
      picking: false,
      errorText: '',
    });
  },

  onEdit(event: WechatMiniprogram.TouchEvent) {
    const id = event.currentTarget.dataset.id;
    if (typeof id !== 'string' || id === '') return;
    const record = records.symptoms.get(id);
    if (record === null) return;
    const parts = isoToWallClock(record.occurredAt);
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
      initialDate: parts.date,
      initialTime: parts.time,
      pendingAttachment: '',
      existingAttachment: attachment,
      attachmentName: attachment === '' ? '' : baseName(attachment),
      picking: false,
      errorText: '',
    });
    if (typeof wx.vibrateShort === 'function') wx.vibrateShort({ type: 'light' });
  },

  onCancelForm() {
    this.setData({
      formOpen: false,
      editingId: '',
      form: { ...EMPTY_FORM },
      initialDate: '',
      initialTime: '',
      pendingAttachment: '',
      existingAttachment: '',
      attachmentName: '',
      picking: false,
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

  /** 选择 1 个附件（图片）：仅记录临时路径，保存时才落盘；失败/结束都有可见反馈。 */
  onPickAttachment() {
    if (typeof wx.chooseMedia !== 'function') return;
    if (this.data.picking) return;
    this.setData({ picking: true });
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
      fail: () => {
        this.setData({ errorText: SYMPTOMS.attachmentPickFailed });
        if (typeof wx.showToast === 'function') {
          wx.showToast({ title: SYMPTOMS.attachmentPickFailed, icon: 'none' });
        }
      },
      complete: () => {
        this.setData({ picking: false });
      },
    });
  },

  /** 统一的 toast 封装：宿主缺失时静默跳过，不抛错。 */
  notify(title: string, icon: 'none' | 'success') {
    if (typeof wx.showToast === 'function') wx.showToast({ title, icon });
  },

  /** 成功/软警告反馈：warning 非空时以提示语气显示，否则显示成功。 */
  feedback(warning: string | undefined, successTitle: string) {
    if (warning === undefined) this.notify(successTitle, 'success');
    else this.notify(warning, 'none');
  },

  /**
   * 保存：原话 trim 后为空 -> 提示且不写入。编辑仅在时间被改动时写入 occurredAt
   * （绝不静默改为当前时刻）；更换附件经 replaceAttachment（先存新、成功后删旧），
   * 失败则整体不改并给出明确提示。新增经 addWithAttachment，附件失败仍会写入记录，
   * 但明确告知「记录已保存，但附件未保存」。
   */
  onSave() {
    const form = this.data.form;
    const text = form.text.trim();
    if (text === '') {
      this.setData({ errorText: SYMPTOMS.requiredHint });
      this.notify(SYMPTOMS.requiredHint, 'none');
      return;
    }

    const duration = form.duration.trim();
    const impact = form.impact.trim();
    const tags = splitTags(form.tagsText);
    const editing = this.data.editingId !== '';

    let occurredAt: string | undefined;
    if (editing) {
      const timeChanged =
        form.date !== this.data.initialDate || form.time !== this.data.initialTime;
      if (timeChanged) {
        const iso = wallClockToIso(form.date, form.time);
        if (iso === null) {
          this.setData({ errorText: SYMPTOMS.timeRequiredHint });
          this.notify(SYMPTOMS.timeRequiredHint, 'none');
          return;
        }
        occurredAt = iso;
      }
    } else {
      const iso = wallClockToIso(form.date, form.time);
      if (iso === null) {
        this.setData({ errorText: SYMPTOMS.timeRequiredHint });
        this.notify(SYMPTOMS.timeRequiredHint, 'none');
        return;
      }
      occurredAt = iso;
    }

    try {
      if (editing) {
        const id = this.data.editingId;
        const patch: Partial<SymptomInput> = { duration, text, impact, tags };
        if (occurredAt !== undefined) patch.occurredAt = occurredAt;

        if (this.data.pendingAttachment !== '') {
          const replaced = replaceAttachment(records.symptoms, id, this.data.pendingAttachment);
          if (!replaced.saved) {
            const reason = replaced.notice === undefined ? '' : `（${replaced.notice}）`;
            const message = `${SYMPTOMS.attachmentReplaceFailed}${reason}`;
            this.setData({ errorText: message });
            this.notify(message, 'none');
            return;
          }
          records.symptoms.update(id, patch);
          this.feedback(replaced.warning, SYMPTOMS.savedHint);
        } else {
          records.symptoms.update(id, {
            ...patch,
            attachment: this.data.existingAttachment === '' ? null : this.data.existingAttachment,
          });
          this.feedback(undefined, SYMPTOMS.savedHint);
        }
      } else {
        const input: SymptomInput = {
          occurredAt: occurredAt as string,
          duration,
          text,
          impact,
          tags,
          attachment: null,
        };
        const result = addWithAttachment(
          records.symptoms,
          input,
          this.data.pendingAttachment === '' ? null : this.data.pendingAttachment
        );
        if (result.notice !== undefined) {
          this.notify(`${SYMPTOMS.attachmentNotSaved}（${result.notice}）`, 'none');
        } else {
          this.feedback(result.warning, SYMPTOMS.savedHint);
        }
      }
    } catch (e) {
      this.setData({ errorText: SYMPTOMS.saveFailed });
      this.notify(SYMPTOMS.saveFailed, 'none');
      return;
    }

    this.closeForm();
    this.refresh();
    if (typeof wx.vibrateShort === 'function') wx.vibrateShort({ type: 'light' });
  },

  closeForm() {
    this.setData({
      formOpen: false,
      editingId: '',
      form: { ...EMPTY_FORM },
      initialDate: '',
      initialTime: '',
      pendingAttachment: '',
      existingAttachment: '',
      attachmentName: '',
      picking: false,
      errorText: '',
    });
  },

  /** 删除：确认后删除记录并同步删除其附件。 */
  onDelete(event: WechatMiniprogram.TouchEvent) {
    const id = event.currentTarget.dataset.id;
    if (typeof id !== 'string' || id === '') return;
    const doDelete = () => {
      try {
        deleteRecordWithAttachment(records.symptoms, id);
      } catch (e) {
        this.notify(SYMPTOMS.deleteFailed, 'none');
        return;
      }
      if (this.data.editingId === id) this.closeForm();
      this.refresh();
      this.notify(SYMPTOMS.deletedHint, 'none');
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
