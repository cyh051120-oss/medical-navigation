// pages/brief/brief.ts — 就医摘要（任务 20）。
//
// 单一职责：让用户从本机已有记录中多选（症状 / 资料摘录 / 待问问题），用
// shared/services/brief.ts 的纯函数 build() 组装一份结构化纯文本摘要，允许编辑后
// 保存为 records.briefs 的 VisitBrief，或复制到剪贴板（图片导出见任务 21）。
//
// 区分「用户原话 / 整理内容 / 待医生确认」：
//   - build() 对「症状时间线」逐字保留用户填写的原话（symptom.text 不改写）；
//   - 页面在编辑区显式标注：原话逐字保留，其余为整理内容，就诊时请与医生确认；
//   - 本页不做任何医疗判断、不补写内容、不新增判断类字段。缺失字段由 build() 整体省略。
//
// 具体行为：
//   - 选择 / 生成 / 编辑：见原有契约。
//   - 保存：仅经 records.briefs.add/update 写入 VisitBrief（content / sourceIds /
//     exportedAt=null）。保存不代表导出，exportedAt 只在真正复制或导出图片后写入。
//   - 已保存摘要：列出本机已存摘要，可打开续编或单条删除（不再只能整包清除）。
//   - 图片导出：导出成功若内容被版式截断，页面显式提示（posterOverflow）。
//   - 无障碍（任务 16 契约）：data 展开 A11Y_DATA，onShow 调 syncA11y。

import { BRIEF, BUTTONS, EMPTY, POSTER } from '../../config/texts';
import { build, toClipboard } from '../../shared/services/brief';
import type { BriefSelection } from '../../shared/services/brief';
import { buildPosterPlan, drawPoster } from '../../shared/services/poster';
import type { PosterContext } from '../../shared/services/poster';
import { A11Y_DATA, syncA11y } from '../../shared/ui/a11y';
import { SIDEBAR_DATA, setSidebarCollapsed, syncSidebar } from '../../shared/ui/sidebar';
import { records } from '../../shared/services/records';
import { formatStamp } from '../../shared/utils/time';
import type { DocumentNote, LocalProfile, QuestionList, SymptomEntry } from '../../shared/services/records';

/** 一条可选记录在界面上的展示数据。 */
interface SelectRow {
  id: string;
  title: string;
  meta: string;
  selected: boolean;
}

/** 一条已保存摘要的展示数据。 */
interface SavedBriefRow {
  id: string;
  preview: string;
  savedLabel: string;
  exportedLabel: string;
}

/** 选择汇总（已选条数 + 是否非空）。 */
interface SelectionSummary {
  selectedCount: number;
  hasSelection: boolean;
}

/** `<canvas type="2d">` 节点所需的最小结构（selector query 返回）。 */
interface CanvasNode {
  width: number;
  height: number;
  getContext(type: '2d'): unknown;
}

/** selector query fields({node,size}) 结果的读法。 */
interface CanvasFieldsResult {
  node?: CanvasNode;
}

/** 导出图片的结果，便于检查脚本断言。 */
interface ImageExportResult {
  exported: boolean;
  path: string;
}

function isFilled(value: string): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

/** 已保存摘要的一行预览（取首行并截断，不改变原文）。 */
function previewOf(content: string): string {
  const line = content.split('\n').find((row) => row.trim() !== '') ?? '';
  const trimmed = line.trim();
  return trimmed.length > 24 ? `${trimmed.slice(0, 24)}…` : trimmed;
}

/**
 * 档案是否会在 build() 中产生内容：build() 只渲染非空的称呼/年龄段/长期用药/过敏/既往。
 * 全空档案不纳入，避免「空档案 + 空选择」被误认为可生成。
 */
function profileContributes(profile: LocalProfile | null): boolean {
  if (profile === null) return false;
  return (
    isFilled(profile.name) ||
    isFilled(profile.ageRange) ||
    isFilled(profile.medications) ||
    isFilled(profile.allergies) ||
    isFilled(profile.history)
  );
}

function flipRows(rows: SelectRow[], id: string): SelectRow[] {
  return rows.map((row) => (row.id === id ? { ...row, selected: !row.selected } : row));
}

function markRows(rows: SelectRow[], selected: boolean): SelectRow[] {
  return rows.map((row) => (row.selected === selected ? row : { ...row, selected }));
}

function summarize(symptoms: SelectRow[], notes: SelectRow[], questions: SelectRow[]): SelectionSummary {
  const selectedCount =
    symptoms.filter((row) => row.selected).length +
    notes.filter((row) => row.selected).length +
    questions.filter((row) => row.selected).length;
  return { selectedCount, hasSelection: selectedCount > 0 };
}

function symptomRow(symptom: SymptomEntry, copy: typeof BRIEF, selected: boolean): SelectRow {
  const stamp = formatStamp(symptom.occurredAt);
  const meta = stamp !== '' ? stamp : isFilled(symptom.occurredAtText ?? '') ? (symptom.occurredAtText as string) : copy.symptomsGroup;
  return { id: symptom.id, title: symptom.text, meta, selected };
}

function noteRow(note: DocumentNote, selected: boolean): SelectRow {
  const title = isFilled(note.name) ? note.name : note.excerpt;
  const meta = isFilled(note.name) ? note.excerpt : note.sourceDate;
  return { id: note.id, title, meta, selected };
}

function questionRow(question: QuestionList, copy: typeof BRIEF, selected: boolean): SelectRow {
  return { id: question.id, title: question.text, meta: question.done ? copy.questionsGroup + ' · 已问' : copy.questionsGroup, selected };
}

function buildSavedBriefRows(): SavedBriefRow[] {
  const rows = records.briefs.list().map((brief) => ({
    id: brief.id,
    preview: previewOf(brief.content),
    savedLabel: formatStamp(brief.createdAt),
    exportedLabel: brief.exportedAt === null ? '' : formatStamp(brief.exportedAt),
    sortMs: Date.parse(brief.createdAt),
  }));
  rows.sort((a, b) => {
    const left = Number.isFinite(a.sortMs) ? a.sortMs : 0;
    const right = Number.isFinite(b.sortMs) ? b.sortMs : 0;
    return right - left;
  });
  return rows.map(({ sortMs, ...row }) => row);
}

Page({
  data: {
    ...A11Y_DATA,
    ...SIDEBAR_DATA,
    profileAvailable: false,
    hasSourceRecords: false,
    symptomRows: [] as SelectRow[],
    noteRows: [] as SelectRow[],
    questionRows: [] as SelectRow[],
    selectedCount: 0,
    hasSelection: false,
    content: '',
    sourceIds: [] as string[],
    currentBriefId: '',
    savedAt: '',
    savedBriefs: [] as SavedBriefRow[],
    hasSavedBriefs: false,
    hint: '',
    errorText: '',
    previewPath: '',
    exporting: false,
    posterOverflow: false,
    copy: BRIEF,
    buttons: BUTTONS,
    poster: POSTER,
    emptyText: EMPTY.brief,
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

  /** 重新读取本地记录并刷新三类选择列表与已保存摘要；按 id 保留已勾选状态。 */
  refresh() {
    const prev: Record<string, boolean> = {};
    for (const row of this.data.symptomRows.concat(this.data.noteRows, this.data.questionRows)) {
      if (row.selected) prev[row.id] = true;
    }

    const symptoms = records.symptoms.list();
    const notes = records.notes.list();
    const questionLists = records.questions.list();
    const profile = records.profile.list();
    const profileRecord = profile.length > 0 ? profile[0] : null;

    const symptomRows = symptoms.map((item) => symptomRow(item, this.data.copy, prev[item.id] === true));
    const noteRows = notes.map((item) => noteRow(item, prev[item.id] === true));
    const questionRows = questionLists.map((item) => questionRow(item, this.data.copy, prev[item.id] === true));

    this.setData({
      profileAvailable: profileContributes(profileRecord),
      hasSourceRecords: symptoms.length + notes.length + questionLists.length > 0,
      symptomRows,
      noteRows,
      questionRows,
      ...summarize(symptomRows, noteRows, questionRows),
    });
    this.refreshSavedBriefs();
  },

  /** 仅刷新已保存摘要列表。 */
  refreshSavedBriefs() {
    let savedBriefs: SavedBriefRow[] = [];
    try {
      savedBriefs = buildSavedBriefRows();
    } catch (e) {
      savedBriefs = [];
    }
    this.setData({ savedBriefs, hasSavedBriefs: savedBriefs.length > 0 });
  },

  // ----- 选择 -----

  onToggleSymptom(event: WechatMiniprogram.TouchEvent) {
    const id = event.currentTarget.dataset.id;
    if (typeof id !== 'string' || id === '') return;
    const symptomRows = flipRows(this.data.symptomRows, id);
    this.setData({ symptomRows, ...summarize(symptomRows, this.data.noteRows, this.data.questionRows) });
  },

  onToggleNote(event: WechatMiniprogram.TouchEvent) {
    const id = event.currentTarget.dataset.id;
    if (typeof id !== 'string' || id === '') return;
    const noteRows = flipRows(this.data.noteRows, id);
    this.setData({ noteRows, ...summarize(this.data.symptomRows, noteRows, this.data.questionRows) });
  },

  onToggleQuestion(event: WechatMiniprogram.TouchEvent) {
    const id = event.currentTarget.dataset.id;
    if (typeof id !== 'string' || id === '') return;
    const questionRows = flipRows(this.data.questionRows, id);
    this.setData({ questionRows, ...summarize(this.data.symptomRows, this.data.noteRows, questionRows) });
  },

  onSelectAll() {
    const symptomRows = markRows(this.data.symptomRows, true);
    const noteRows = markRows(this.data.noteRows, true);
    const questionRows = markRows(this.data.questionRows, true);
    this.setData({ symptomRows, noteRows, questionRows, ...summarize(symptomRows, noteRows, questionRows) });
  },

  onClearSelection() {
    const symptomRows = markRows(this.data.symptomRows, false);
    const noteRows = markRows(this.data.noteRows, false);
    const questionRows = markRows(this.data.questionRows, false);
    this.setData({ symptomRows, noteRows, questionRows, ...summarize(symptomRows, noteRows, questionRows) });
  },

  /** 按当前勾选从数据层取出完整记录，组装 build() 的输入（含可用档案）。 */
  collectSelection(): BriefSelection {
    const symptoms: SymptomEntry[] = [];
    for (const row of this.data.symptomRows) {
      if (!row.selected) continue;
      const record = records.symptoms.get(row.id);
      if (record !== null) symptoms.push(record);
    }
    const notes: DocumentNote[] = [];
    for (const row of this.data.noteRows) {
      if (!row.selected) continue;
      const record = records.notes.get(row.id);
      if (record !== null) notes.push(record);
    }
    const questionLists: QuestionList[] = [];
    for (const row of this.data.questionRows) {
      if (!row.selected) continue;
      const record = records.questions.get(row.id);
      if (record !== null) questionLists.push(record);
    }
    const profileRecords = this.data.profileAvailable ? records.profile.list() : [];
    const profile = profileRecords.length > 0 ? profileRecords[0] : null;
    return { profile, symptoms, notes, questionLists };
  },

  // ----- 生成 -----

  /**
   * 生成摘要。空选择（无勾选且无可用档案）时提示且**不覆盖**已有编辑内容；否则用 build()
   * 覆盖编辑区并保留 build 的 sourceIds。返回是否生成及来源 id，便于检查脚本断言。
   */
  onGenerate(): { generated: boolean; sourceIds: string[] } {
    const copy = this.data.copy;
    const selection = this.collectSelection();
    const hasAny =
      (selection.profile !== null && selection.profile !== undefined) ||
      (selection.symptoms !== undefined && selection.symptoms.length > 0) ||
      (selection.notes !== undefined && selection.notes.length > 0) ||
      (selection.questionLists !== undefined && selection.questionLists.length > 0);

    if (!hasAny) {
      this.setData({ errorText: copy.generateEmpty, hint: '' });
      if (typeof wx.showToast === 'function') {
        wx.showToast({ title: copy.generateEmpty, icon: 'none' });
      }
      return { generated: false, sourceIds: [] };
    }

    const result = build(selection);
    this.setData({
      content: result.text,
      sourceIds: result.sourceIds,
      currentBriefId: '',
      savedAt: '',
      hint: '',
      errorText: '',
      previewPath: '',
      posterOverflow: false,
    });
    return { generated: true, sourceIds: result.sourceIds };
  },

  // ----- 编辑 / 保存 / 复制 -----

  onContentInput(event: WechatMiniprogram.TextareaInput) {
    this.setData({
      content: event.detail.value,
      currentBriefId: '',
      savedAt: '',
      hint: '',
      errorText: '',
      previewPath: '',
      posterOverflow: false,
    });
  },

  /**
   * 保存为 VisitBrief：写入 {content, sourceIds, exportedAt=null}。若当前正打开一条已保存
   * 摘要则更新它，否则新增。内容为空时拒绝。保存 ≠ 导出，exportedAt 只在真正导出后写入。
   */
  onSave(): { saved: boolean; exportedAt: string | null } {
    const copy = this.data.copy;
    const text = this.data.content;
    if (!isFilled(text)) {
      this.setData({ errorText: copy.saveEmpty, hint: '' });
      if (typeof wx.showToast === 'function') {
        wx.showToast({ title: copy.saveEmpty, icon: 'none' });
      }
      return { saved: false, exportedAt: null };
    }

    try {
      const existingId = this.data.currentBriefId;
      const record =
        existingId !== '' && records.briefs.get(existingId) !== null
          ? records.briefs.update(existingId, { content: text, sourceIds: this.data.sourceIds.slice() })
          : records.briefs.add({ content: text, sourceIds: this.data.sourceIds.slice(), exportedAt: null });
      this.setData({
        currentBriefId: record.id,
        savedAt: record.exportedAt === null ? '' : formatStamp(record.exportedAt),
        hint: copy.saveHint,
        errorText: '',
      });
      this.refreshSavedBriefs();
      if (typeof wx.vibrateShort === 'function') wx.vibrateShort({ type: 'light' });
      if (typeof wx.showToast === 'function') {
        wx.showToast({ title: copy.saveHint, icon: 'success' });
      }
      return { saved: true, exportedAt: record.exportedAt };
    } catch (e) {
      this.setData({ errorText: copy.saveFailed, hint: '' });
      if (typeof wx.showToast === 'function') {
        wx.showToast({ title: copy.saveFailed, icon: 'none' });
      }
      return { saved: false, exportedAt: null };
    }
  },

  // ----- 已保存摘要 -----

  /** 打开一条已保存摘要：载入内容与来源，成为当前编辑对象。 */
  onOpenBrief(event: WechatMiniprogram.TouchEvent) {
    const id = event.currentTarget.dataset.id;
    if (typeof id !== 'string' || id === '') return;
    const record = records.briefs.get(id);
    if (record === null) return;
    this.setData({
      content: record.content,
      sourceIds: record.sourceIds.slice(),
      currentBriefId: record.id,
      savedAt: record.exportedAt === null ? '' : formatStamp(record.exportedAt),
      hint: this.data.copy.openHint,
      errorText: '',
      previewPath: '',
      posterOverflow: false,
    });
  },

  /** 删除一条已保存摘要。 */
  onDeleteBrief(event: WechatMiniprogram.TouchEvent) {
    const id = event.currentTarget.dataset.id;
    if (typeof id !== 'string' || id === '') return;
    const copy = this.data.copy;
    const doDelete = () => {
      records.briefs.remove(id);
      if (this.data.currentBriefId === id) {
        this.setData({ currentBriefId: '', savedAt: '' });
      }
      this.refreshSavedBriefs();
      if (typeof wx.showToast === 'function') {
        wx.showToast({ title: copy.deleteSavedDone, icon: 'none' });
      }
    };
    if (typeof wx.showModal === 'function') {
      wx.showModal({
        title: copy.deleteSavedTitle,
        content: copy.deleteSavedConfirm,
        success: (res) => {
          if (res.confirm) doDelete();
        },
      });
    } else {
      doDelete();
    }
  },

  /** 真正发生导出（复制 / 生成图片）后，回写当前摘要的 exportedAt。 */
  markExported() {
    const id = this.data.currentBriefId;
    if (id === '' || !isFilled(this.data.content)) return;
    if (records.briefs.get(id) === null) return;
    try {
      const updated = records.briefs.update(id, { exportedAt: new Date().toISOString() });
      this.setData({ savedAt: updated.exportedAt === null ? '' : formatStamp(updated.exportedAt) });
      this.refreshSavedBriefs();
    } catch (e) {
      void e;
    }
  },

  /**
   * 复制到剪贴板。内容为空时提示；成功弹成功提示，失败（reject）展示错误提示且不弹成功。
   * 返回 Promise<boolean> 便于检查脚本等待结果，且避免未处理的 rejection。
   */
  onCopy(): Promise<boolean> {
    const copy = this.data.copy;
    const text = this.data.content;
    if (!isFilled(text)) {
      this.setData({ errorText: copy.copyEmpty, hint: '' });
      if (typeof wx.showToast === 'function') {
        wx.showToast({ title: copy.copyEmpty, icon: 'none' });
      }
      return Promise.resolve(false);
    }

    return toClipboard(text)
      .then(() => {
        this.setData({ hint: copy.copyDone, errorText: '' });
        if (typeof wx.showToast === 'function') {
          wx.showToast({ title: copy.copyDone, icon: 'success' });
        }
        this.markExported();
        return true;
      })
      .catch(() => {
        this.setData({ hint: '', errorText: copy.copyFailed });
        if (typeof wx.showToast === 'function') {
          wx.showToast({ title: copy.copyFailed, icon: 'none' });
        }
        return false;
      });
  },

  // ----- 图片导出 / 保存 / 分享（任务 21）-----

  /**
   * 生成摘要图片：把当前编辑区内容（用户确认后的摘要）按固定版式画到 750×1334 的
   * `<canvas type="2d">` 上，再经 wx.canvasToTempFilePath 导出为临时文件，存入
   * data.previewPath 供预览。内容为空或正在导出时拒绝，不伪成功。
   */
  onExportImage(): Promise<ImageExportResult> {
    const content = this.data.content;
    if (!isFilled(content)) {
      this.setData({ errorText: POSTER.exportEmpty, hint: '' });
      if (typeof wx.showToast === 'function') wx.showToast({ title: POSTER.exportEmpty, icon: 'none' });
      return Promise.resolve({ exported: false, path: '' });
    }
    if (this.data.exporting) return Promise.resolve({ exported: false, path: '' });

    this.setData({ exporting: true, errorText: '', hint: '', posterOverflow: false });
    if (typeof wx.showLoading === 'function') wx.showLoading({ title: POSTER.exporting, mask: true });

    const stamp = formatStamp(new Date().toISOString());
    const plan = buildPosterPlan({ body: content, generatedAt: stamp });

    return new Promise<ImageExportResult>((resolve) => {
      if (typeof wx.createSelectorQuery !== 'function') {
        this.finishExportError(POSTER.exportFailed);
        resolve({ exported: false, path: '' });
        return;
      }
      const query = wx.createSelectorQuery();
      query.select('#briefPoster').fields({ node: true, size: true });
      query.exec((res) => {
        const first = res && res[0] ? (res[0] as CanvasFieldsResult) : undefined;
        const canvas = first !== undefined && first.node !== undefined ? first.node : null;
        if (canvas === null || typeof canvas.getContext !== 'function') {
          this.finishExportError(POSTER.exportFailed);
          resolve({ exported: false, path: '' });
          return;
        }
        canvas.width = plan.width;
        canvas.height = plan.height;
        drawPoster(canvas.getContext('2d') as unknown as PosterContext, plan);
        wx.canvasToTempFilePath({
          canvas: canvas as unknown as WechatMiniprogram.IAnyObject,
          x: 0,
          y: 0,
          width: plan.width,
          height: plan.height,
          destWidth: plan.width,
          destHeight: plan.height,
          fileType: 'png',
          success: (result) => {
            if (typeof wx.hideLoading === 'function') wx.hideLoading();
            this.setData({ previewPath: result.tempFilePath, exporting: false, posterOverflow: plan.bodyOverflow, hint: POSTER.exportDone, errorText: '' });
            this.markExported();
            resolve({ exported: true, path: result.tempFilePath });
          },
          fail: () => {
            this.finishExportError(POSTER.exportFailed);
            resolve({ exported: false, path: '' });
          },
        });
      });
    });
  },

  /** 导出失败统一收尾：关 loading、清 exporting、给出错误提示。 */
  finishExportError(errorText: string) {
    if (typeof wx.hideLoading === 'function') wx.hideLoading();
    this.setData({ exporting: false, errorText, hint: '' });
    if (typeof wx.showToast === 'function') wx.showToast({ title: errorText, icon: 'none' });
  },

  /**
   * 保存到相册：wx.saveImageToPhotosAlbum；成功弹成功提示；权限被拒时弹设置引导
   * （wx.showModal → 确认后 wx.openSetting），其他失败只提示，不伪成功。
   */
  onSaveImage(): Promise<boolean> {
    const path = this.data.previewPath;
    if (!isFilled(path)) {
      this.setData({ errorText: POSTER.exportFirst, hint: '' });
      if (typeof wx.showToast === 'function') wx.showToast({ title: POSTER.exportFirst, icon: 'none' });
      return Promise.resolve(false);
    }
    return new Promise<boolean>((resolve) => {
      wx.saveImageToPhotosAlbum({
        filePath: path,
        success: () => {
          this.setData({ hint: POSTER.saveImageDone, errorText: '' });
          if (typeof wx.showToast === 'function') wx.showToast({ title: POSTER.saveImageDone, icon: 'success' });
          resolve(true);
        },
        fail: (error) => {
          const message = error !== undefined && error !== null && typeof error.errMsg === 'string' ? error.errMsg : '';
          if (/auth deny|auth denied|authorize|permission/i.test(message)) {
            this.setData({ errorText: POSTER.permissionHint, hint: '' });
            if (typeof wx.showModal === 'function') {
              wx.showModal({
                title: POSTER.permissionTitle,
                content: POSTER.permissionContent,
                confirmText: POSTER.permissionConfirm,
                success: (modal) => {
                  if (modal.confirm === true && typeof wx.openSetting === 'function') wx.openSetting({});
                },
              });
            }
            resolve(false);
            return;
          }
          if (/cancel/i.test(message)) {
            resolve(false);
            return;
          }
          this.setData({ errorText: POSTER.saveImageFailed, hint: '' });
          if (typeof wx.showToast === 'function') wx.showToast({ title: POSTER.saveImageFailed, icon: 'none' });
          resolve(false);
        },
      });
    });
  },

  /** 分享：open-type="share" 触发；分享本工具入口，不携带任何本地记录。 */
  onShareAppMessage() {
    return { title: POSTER.shareTitle, path: '/pages/brief/brief' };
  },
});
