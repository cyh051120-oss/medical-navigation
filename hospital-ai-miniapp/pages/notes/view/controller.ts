// pages/notes/view/controller.ts — 资料摘录（任务 18）的纯逻辑单源。
//
// 双宿主契约：本模块只导出两个纯对象工厂（notesData / notesMethods），模块求值时无副作用、
// 无平台生命周期，也不使用平台 behaviors——wrapper 页与 workspace section 组件各自把工厂
// 返回的对象展开进自己的配置，从而保证「面契约」（data 键集 / 方法名集）在两条宿主上一致。
//
// 单一职责：在本机记录、编辑、删除资料摘录，并按来源日期倒序展示。
// 字段严格等于 records.DocumentNote：名称 name / 摘录 excerpt / 来源日期 sourceDate /
//   单附件 attachment（≤1，string|null）/ 备注 remark。不新增任何判断类字段，界面亦
//   不出现此类文案；附件仅本地保存与展示，不做任何判读。
//
// 具体行为：列表按来源日期倒序（同日按 id 升序稳定）；表单新增/编辑共用；名称 trim() 后
//   为空时不写入；删除经 attachments.deleteRecordWithAttachment 同步删附件；附件新增经
//   attachments.addWithAttachment、编辑换图经 attachments.replaceAttachment。
//
// 数据层：只经 records.notes（纯本地），不直接读写 storage，也不自建键。

import { BUTTONS, EMPTY, NOTES } from '../../../config/texts';
import { records } from '../../../shared/services/records';
import {
  addWithAttachment,
  deleteRecordWithAttachment,
  replaceAttachment,
} from '../../../shared/services/attachments';
import { formatStamp } from '../../../shared/utils/time';
import type { DocumentNote, DocumentNoteInput } from '../../../shared/services/records';

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

/** 资料摘录初始 data（面契约）：wrapper 与 workspace section 共用。 */
export function notesData() {
  return {
    rows: [] as NoteRow[],
    hasRecords: false,
    formOpen: false,
    editingId: '',
    form: { ...EMPTY_FORM } as NoteForm,
    pendingAttachment: '',
    existingAttachment: '',
    attachmentName: '',
    existingAttachmentMissing: false,
    picking: false,
    previewPath: '',
    previewHint: '',
    errorText: '',
    copy: NOTES,
    buttons: BUTTONS,
    emptyText: EMPTY.notes,
  };
}

/** notesData 返回的 data 形状（供实例面类型引用）。 */
type NotesData = ReturnType<typeof notesData>;

/** notesMethods 工厂内 `this` 需要的最小实例面（setData 由 Page / Component 提供）。 */
interface NotesSectionInstance {
  data: NotesData;
  setData(patch: Record<string, unknown>): void;
  refresh(): void;
  closeForm(): void;
  notify(title: string, icon: 'none' | 'success'): void;
  feedback(warning: string | undefined, successTitle: string): void;
}

/** 资料摘录可调用方法名（面契约）：与重构前 pages/notes/notes.ts 逐一相同。 */
export interface NotesMethods {
  refresh(): void;
  onAdd(): void;
  onEdit(event: WechatMiniprogram.TouchEvent): void;
  onCancelForm(): void;
  closeForm(): void;
  onNameInput(event: WechatMiniprogram.Input): void;
  onExcerptInput(event: WechatMiniprogram.TextareaInput): void;
  onSourceDateChange(event: WechatMiniprogram.PickerChange): void;
  onRemarkInput(event: WechatMiniprogram.Input): void;
  onPickAttachment(): void;
  notify(title: string, icon: 'none' | 'success'): void;
  feedback(warning: string | undefined, successTitle: string): void;
  onPreview(event: WechatMiniprogram.TouchEvent): void;
  onSave(): void;
  onDelete(event: WechatMiniprogram.TouchEvent): void;
}

/** 资料摘录可调用方法（面契约）：wrapper 与 workspace section 共用。 */
export function notesMethods(): NotesMethods & ThisType<NotesSectionInstance> {
  return {
    /** 重新读取本地资料摘录并刷新列表（返回本页时也会触发）。 */
    refresh() {
      let rows: NoteRow[] = [];
      try {
        rows = buildRows(records.notes.list());
      } catch (e) {
        rows = [];
      }
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
        picking: false,
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
        picking: false,
        previewPath: '',
        previewHint: '',
        errorText: '',
      });
      if (typeof wx.vibrateShort === 'function') wx.vibrateShort({ type: 'light' });
    },

    onCancelForm() {
      this.closeForm();
    },

    closeForm() {
      this.setData({
        formOpen: false,
        editingId: '',
        form: { ...EMPTY_FORM },
        pendingAttachment: '',
        existingAttachment: '',
        attachmentName: '',
        existingAttachmentMissing: false,
        picking: false,
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
          this.setData({ errorText: this.data.copy.attachmentPickFailed });
          if (typeof wx.showToast === 'function') {
            wx.showToast({ title: this.data.copy.attachmentPickFailed, icon: 'none' });
          }
        },
        complete: () => {
          this.setData({ picking: false });
        },
      });
    },

    notify(title: string, icon: 'none' | 'success') {
      if (typeof wx.showToast === 'function') wx.showToast({ title, icon });
    },

    feedback(warning: string | undefined, successTitle: string) {
      if (warning === undefined) this.notify(successTitle, 'success');
      else this.notify(warning, 'none');
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
        this.notify(this.data.copy.attachmentMissing, 'none');
        return;
      }
      this.setData({ previewPath: row.attachment, previewHint: '' });
      if (typeof wx.previewImage === 'function') {
        wx.previewImage({ urls: [row.attachment], current: row.attachment });
      }
    },

    /**
     * 保存：名称 trim 后为空 -> 提示且不写入。编辑选新附件时经 replaceAttachment
     * （先存新、成功后删旧），失败则整体不改并给出明确提示。新增经 addWithAttachment，
     * 附件失败仍会写入记录，但明确告知「记录已保存，但附件未保存」。
     */
    onSave() {
      const form = this.data.form;
      const copy = this.data.copy;
      const name = form.name.trim();
      if (name === '') {
        this.setData({ errorText: copy.requiredHint });
        this.notify(copy.requiredHint, 'none');
        return;
      }

      const excerpt = form.excerpt.trim();
      const sourceDate = form.sourceDate;
      const remark = form.remark.trim();

      try {
        if (this.data.editingId !== '') {
          const id = this.data.editingId;
          const patch: Partial<DocumentNoteInput> = { name, excerpt, sourceDate, remark };
          if (this.data.pendingAttachment !== '') {
            const replaced = replaceAttachment(records.notes, id, this.data.pendingAttachment);
            if (!replaced.saved) {
              const reason = replaced.notice === undefined ? '' : `（${replaced.notice}）`;
              const message = `${copy.attachmentReplaceFailed}${reason}`;
              this.setData({ errorText: message });
              this.notify(message, 'none');
              return;
            }
            records.notes.update(id, patch);
            this.feedback(replaced.warning, copy.savedHint);
          } else {
            records.notes.update(id, {
              ...patch,
              attachment: this.data.existingAttachment === '' ? null : this.data.existingAttachment,
            });
            this.feedback(undefined, copy.savedHint);
          }
        } else {
          const input: DocumentNoteInput = {
            name,
            excerpt,
            sourceDate,
            remark,
            attachment: null,
          };
          const result = addWithAttachment(
            records.notes,
            input,
            this.data.pendingAttachment === '' ? null : this.data.pendingAttachment
          );
          if (result.notice !== undefined) {
            this.notify(`${copy.attachmentNotSaved}（${result.notice}）`, 'none');
          } else {
            this.feedback(result.warning, copy.savedHint);
          }
        }
      } catch (e) {
        this.setData({ errorText: copy.saveFailed });
        this.notify(copy.saveFailed, 'none');
        return;
      }

      this.closeForm();
      this.refresh();
      if (typeof wx.vibrateShort === 'function') wx.vibrateShort({ type: 'light' });
    },

    /** 删除：确认后删除记录并同步删除其附件。 */
    onDelete(event: WechatMiniprogram.TouchEvent) {
      const id = event.currentTarget.dataset.id;
      if (typeof id !== 'string' || id === '') return;
      const doDelete = () => {
        try {
          deleteRecordWithAttachment(records.notes, id);
        } catch (e) {
          this.notify(this.data.copy.deleteFailed, 'none');
          return;
        }
        if (this.data.editingId === id) this.closeForm();
        this.refresh();
        this.notify(this.data.copy.deletedHint, 'none');
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
  };
}
