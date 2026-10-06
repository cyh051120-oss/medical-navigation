// pages/notes/notes.ts — 资料摘录（任务 18）。
//
// 单一职责：在本机记录、编辑、删除资料摘录，并按来源日期倒序展示。
// 字段严格等于 records.DocumentNote：名称 name / 摘录 excerpt / 来源日期 sourceDate /
//   单附件 attachment（≤1，string|null）/ 备注 remark。不新增任何判断类字段，界面亦不
//   出现此类文案；附件仅本地保存与展示，不做任何判读。
//
// 具体行为：
//   - 列表：records.notes.list() 后按来源日期 sourceDate 倒序（同日按 id 升序稳定）。
//     每行展示：名称 / 摘录 / 来源日期 / 备注 / 附件指示（含缺失占位）/ 创建与更新时间戳。
//   - 附件预览：附件可读时经 wx.previewImage（宿主提供时）预览；附件文件缺失或不可读时以
//     占位提示「附件缺失，无法预览」呈现，且绝不抛错（见 attachmentIsReadable 的守卫）。
//   - 表单：新增与编辑共用；来源日期用日期选择器，新增默认当天。编辑时载入原值。
//   - 校验：名称 trim() 后为空时给出提示且不写入任何存储。
//   - 删除：确认后经 attachments.deleteRecordWithAttachment 删除记录并同步删附件。
//   - 附件：最多 1 个。新增经 attachments.addWithAttachment；编辑选新附件时经
//     attachments.replaceAttachment（替换即先删旧文件）。attachments 层没有「仅解绑单个附件」
//     原语，故本页不提供单独移除入口，也不自造影子存储或手写存储键（与任务 17 同决策）。
//   - 无障碍（任务 16 契约）：data 展开 A11Y_DATA，onShow 调 syncA11y，根节点消费
//     `--mhp-scale` 与 `is-hc`。
//
// 数据层：只经 records.notes 与 attachments（均纯本地，无网络）；不直接调用 storage，
//   也不自建键。所有写入走整对象 setData，便于 node 端页面逻辑检查驱动真实方法。

import { BUTTONS, EMPTY, NOTES } from '../../config/texts';
import { A11Y_DATA, syncA11y } from '../../shared/ui/a11y';
import { SIDEBAR_DATA, setSidebarCollapsed, syncSidebar } from '../../shared/ui/sidebar';
import { records } from '../../shared/services/records';
import {
  addWithAttachment,
  deleteRecordWithAttachment,
  replaceAttachment,
} from '../../shared/services/attachments';
import type { DocumentNote, DocumentNoteInput } from '../../shared/services/records';

/** 表单字段；来源日期为 `YYYY-MM-DD`。 */
interface NoteForm {
  name: string;
  excerpt: string;
  sourceDate: string;
  remark: string;
}

/** 列表一行（归一化后的展示数据）。 */
interface NoteRow {
  id: string;
  name: string;
  excerpt: string;
  sourceDate: string;
  remark: string;
  attachment: string;
  hasAttachment: boolean;
  attachmentName: string;
  attachmentMissing: boolean;
  createdLabel: string;
  updatedLabel: string;
}

const EMPTY_FORM: NoteForm = { name: '', excerpt: '', sourceDate: '', remark: '' };

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

/** 当前本地日期 `YYYY-MM-DD`（新增时的来源日期默认值）。 */
function todayDate(): string {
  const date = new Date();
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/**
 * 附件文件是否可读（存在且可 stat）。任何文件系统异常都归一为「不可读」，
 * 绝不向上抛，保证损坏附件只影响该行的展示状态、不会让整页崩溃。
 */
function attachmentIsReadable(filePath: string): boolean {
  if (typeof wx.getFileSystemManager !== 'function') return true;
  try {
    wx.getFileSystemManager().statSync(filePath);
    return true;
  } catch (e) {
    return false;
  }
}

/** 读取列表并归一化为展示行，按来源日期倒序（同日按 id 升序稳定）。 */
function buildRows(list: DocumentNote[]): NoteRow[] {
  const rows = list.map((item) => {
    const attachment = typeof item.attachment === 'string' ? item.attachment : '';
    const hasAttachment = attachment !== '';
    return {
      id: item.id,
      name: item.name,
      excerpt: item.excerpt,
      sourceDate: item.sourceDate,
      remark: item.remark,
      attachment,
      hasAttachment,
      attachmentName: hasAttachment ? baseName(attachment) : '',
      attachmentMissing: hasAttachment ? !attachmentIsReadable(attachment) : false,
      createdLabel: formatStamp(item.createdAt),
      updatedLabel: formatStamp(item.updatedAt),
    };
  });
  rows.sort((a, b) => {
    if (a.sourceDate !== b.sourceDate) return a.sourceDate < b.sourceDate ? 1 : -1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return rows;
}

Page({
  data: {
    ...A11Y_DATA,
    ...SIDEBAR_DATA,
    rows: [] as NoteRow[],
    hasRecords: false,
    formOpen: false,
    editingId: '',
    form: { ...EMPTY_FORM } as NoteForm,
    pendingAttachment: '',
    existingAttachment: '',
    attachmentName: '',
    existingAttachmentMissing: false,
    previewPath: '',
    previewHint: '',
    errorText: '',
    copy: NOTES,
    buttons: BUTTONS,
    emptyText: EMPTY.notes,
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

  /** 重新读取本地资料摘录并刷新列表（返回本页时也会触发）。 */
  refresh() {
    const rows = buildRows(records.notes.list());
    this.setData({ rows, hasRecords: rows.length > 0 });
  },

  // ----- 表单 -----

  onAdd() {
    this.setData({
      formOpen: true,
      editingId: '',
      form: { name: '', excerpt: '', sourceDate: todayDate(), remark: '' },
      pendingAttachment: '',
      existingAttachment: '',
      attachmentName: '',
      existingAttachmentMissing: false,
      previewPath: '',
      previewHint: '',
      errorText: '',
    });
  },

  onEdit(event: WechatMiniprogram.TouchEvent) {
    const id = event.currentTarget.dataset.id;
    if (typeof id !== 'string' || id === '') return;
    const record = records.notes.get(id);
    if (record === null) return;
    const attachment = typeof record.attachment === 'string' ? record.attachment : '';
    this.setData({
      formOpen: true,
      editingId: record.id,
      form: {
        name: record.name,
        excerpt: record.excerpt,
        sourceDate: record.sourceDate,
        remark: record.remark,
      },
      pendingAttachment: '',
      existingAttachment: attachment,
      attachmentName: attachment === '' ? '' : baseName(attachment),
      existingAttachmentMissing: attachment === '' ? false : !attachmentIsReadable(attachment),
      previewPath: '',
      previewHint: '',
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
      existingAttachmentMissing: false,
      previewPath: '',
      previewHint: '',
      errorText: '',
    });
  },

  onNameInput(event: WechatMiniprogram.Input) {
    this.setData({ form: { ...this.data.form, name: event.detail.value }, errorText: '' });
  },

  onExcerptInput(event: WechatMiniprogram.TextareaInput) {
    this.setData({ form: { ...this.data.form, excerpt: event.detail.value }, errorText: '' });
  },

  onSourceDateChange(event: WechatMiniprogram.PickerChange) {
    this.setData({ form: { ...this.data.form, sourceDate: String(event.detail.value) }, errorText: '' });
  },

  onRemarkInput(event: WechatMiniprogram.Input) {
    this.setData({ form: { ...this.data.form, remark: event.detail.value }, errorText: '' });
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
   * 预览附件：可读时经宿主 previewImage 打开；缺失/不可读时只给占位提示，
   * 不调用预览接口，也不抛错。
   */
  onPreview(event: WechatMiniprogram.TouchEvent) {
    const id = event.currentTarget.dataset.id;
    if (typeof id !== 'string' || id === '') return;
    const row = this.data.rows.filter((item) => item.id === id)[0];
    if (row === undefined || !row.hasAttachment) return;
    if (row.attachmentMissing) {
      this.setData({ previewPath: '', previewHint: this.data.copy.attachmentMissing });
      if (typeof wx.showToast === 'function') {
        wx.showToast({ title: this.data.copy.attachmentMissing, icon: 'none' });
      }
      return;
    }
    this.setData({ previewPath: row.attachment, previewHint: '' });
    if (typeof wx.previewImage === 'function') {
      wx.previewImage({ urls: [row.attachment], current: row.attachment });
    }
  },

  /**
   * 保存：名称 trim 后为空 -> 提示且不写入。编辑走 update（更换附件时另经
   * replaceAttachment），新增走 addWithAttachment。成功后刷新列表并关闭表单。
   */
  onSave() {
    const form = this.data.form;
    const name = form.name.trim();
    if (name === '') {
      this.setData({ errorText: this.data.copy.requiredHint });
      if (typeof wx.showToast === 'function') {
        wx.showToast({ title: this.data.copy.requiredHint, icon: 'none' });
      }
      return;
    }

    const excerpt = form.excerpt.trim();
    const sourceDate = form.sourceDate;
    const remark = form.remark.trim();

    if (this.data.editingId !== '') {
      const id = this.data.editingId;
      const patch: Partial<DocumentNoteInput> = { name, excerpt, sourceDate, remark };
      if (this.data.pendingAttachment !== '') {
        records.notes.update(id, patch);
        replaceAttachment(records.notes, id, this.data.pendingAttachment);
      } else {
        records.notes.update(id, {
          ...patch,
          attachment: this.data.existingAttachment === '' ? null : this.data.existingAttachment,
        });
      }
    } else {
      const input: DocumentNoteInput = {
        name,
        excerpt,
        sourceDate,
        remark,
        attachment: null,
      };
      addWithAttachment(
        records.notes,
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
      existingAttachmentMissing: false,
      previewPath: '',
      previewHint: '',
      errorText: '',
    });
    this.refresh();
    if (typeof wx.vibrateShort === 'function') wx.vibrateShort({ type: 'light' });
    if (typeof wx.showToast === 'function') {
      wx.showToast({ title: this.data.copy.savedHint, icon: 'success' });
    }
  },

  /** 删除：确认后删除记录并同步删除其附件。 */
  onDelete(event: WechatMiniprogram.TouchEvent) {
    const id = event.currentTarget.dataset.id;
    if (typeof id !== 'string' || id === '') return;
    const doDelete = () => {
      deleteRecordWithAttachment(records.notes, id);
      if (this.data.editingId === id) {
        this.setData({
          formOpen: false,
          editingId: '',
          form: { ...EMPTY_FORM },
          pendingAttachment: '',
          existingAttachment: '',
          attachmentName: '',
          existingAttachmentMissing: false,
          previewPath: '',
          previewHint: '',
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
});
