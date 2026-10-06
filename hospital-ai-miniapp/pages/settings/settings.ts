// pages/settings/settings.ts — 设置（任务 15）：隐私、AI 开关、导出、清除、AI 记忆。
//
// 单一职责：本页是本机数据与隐私的唯一控制台。
//   1. 显示与无障碍：全局字号滑条（14–32，写入 preferences.fontSize）本页用内联
//      `--mhp-scale` 立即生效（scale = fontSize / 14）；高对比开关写入
//      preferences.highContrast，并在本页根节点启用 app.wxss 的高对比变量。
//      任务 16 把同一缩放机制推广到全部 8 页。
//   2. AI 外部调用开关：默认关闭；开启前弹同意说明（发送范围来自 config/texts.ts），
//      仅在同意后写入 aiEnabled + consentVersion（=== app.ts 的 PRIVACY_NOTICE_VERSION）；
//      取消保持关闭；关闭立即生效、无需确认。
//   3. AI 记忆：列表（内容 / 来源 / 启停）、新增与编辑、单条删除、清空全部、
//      「AI 自动记忆」开关（preferences.autoMemory，默认开）。
//   4. 数据：导出全部（文字记录 + 附件名称/路径引用，写入 USER_DATA_PATH，无网络）
//      与清除所有本地资料（两步确认）。
//   5. 隐私说明 / 非医疗器械声明 / 关于。
//
// 数据层：只经 records.preferences / records.memory / records.deleteAll /
//   storage.purgeLegacy / attachments.clearAttachments / oplog.append 与宿主文件系统
//   接口；不直连网络。所有写入走整对象 setData，便于 node 端页面逻辑检查驱动真实方法。
//
// 清除语义：deleteAll()（mhp_*）+ purgeLegacy()（旧命名空间）+ clearAttachments()
//   （附件目录）三者完成后，再补一条 oplog 审计记录——因此清除后唯一存活的 mhp_ 键
//   是 mhp_oplog；用户记录与附件均已清空。任一步抛错即中止并保留现状（键级原子，
//   不存在半损坏键），可再次点击重试。

import { ABOUT, A11Y, BUTTONS, CONSENT, DEMO, DISCLAIMERS, EMPTY, EXPORT, LABELS, MEMORY, PRIVACY, WIPE } from '../../config/texts';
import { PRIVACY_NOTICE_VERSION } from '../../app';
import { records } from '../../shared/services/records';
import { deleteAll } from '../../shared/services/records';
import type { AppPreferences, MemoryItem } from '../../shared/services/records';
import { FONT_SIZE_DEFAULT, FONT_SIZE_MAX, FONT_SIZE_MIN } from '../../shared/services/records';
import * as storage from '../../shared/utils/storage';
import { attachmentsDir, clearAttachments } from '../../shared/services/attachments';
import * as oplog from '../../shared/services/oplog';
import { ACCENT, ACCENT_HC } from '../../shared/ui/theme';
import { SIDEBAR_DATA, setSidebarCollapsed, syncSidebar } from '../../shared/ui/sidebar';

type Dict = Record<string, unknown>;

interface MemoryRow {
  id: string;
  text: string;
  source: string;
  sourceLabel: string;
  enabled: boolean;
}

/** 原生 slider 不读取 CSS 变量，强调色统一取自 shared/ui/theme.ts 的 JS 镜像。 */
function accentColorFor(highContrast: boolean): string {
  return highContrast ? ACCENT_HC : ACCENT;
}

function toInt(value: unknown): number {
  const n = typeof value === 'number' ? value : parseInt(String(value), 10);
  return Number.isFinite(n) ? n : NaN;
}

function errorText(err: unknown): string {
  if (err && typeof err === 'object' && 'errMsg' in err) {
    const errMsg = (err as { errMsg?: unknown }).errMsg;
    if (typeof errMsg === 'string' && errMsg !== '') return errMsg;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

function baseName(filePath: string): string {
  const slash = filePath.lastIndexOf('/');
  return slash === -1 ? filePath : filePath.slice(slash + 1);
}

/** 演示模式开关仅在开发者工具（envVersion === 'develop'）可见；探测失败一律视为不可见。 */
function isDevelopEnv(): boolean {
  try {
    const info = wx.getAccountInfoSync();
    return info !== undefined && info.miniProgram !== undefined && info.miniProgram.envVersion === 'develop';
  } catch (e) {
    return false;
  }
}

function buildMemoryRows(list: MemoryItem[]): MemoryRow[] {
  return list.map((item) => ({
    id: item.id,
    text: item.text,
    source: item.source,
    sourceLabel: item.source === 'ai' ? MEMORY.sourceAi : MEMORY.sourceManual,
    enabled: item.enabled,
  }));
}

function consentStatusText(prefs: AppPreferences): string {
  if (typeof prefs.consentVersion === 'number') {
    return prefs.aiEnabled
      ? `已开启 · 同意说明版本 ${prefs.consentVersion}`
      : `已同意说明（版本 ${prefs.consentVersion}），当前关闭`;
  }
  return PRIVACY.externalAiConsent;
}

function buildAiConsentContent(): string {
  return [PRIVACY.externalAiSendScope, CONSENT.autoExtract, CONSENT.revocable].join('\n\n');
}

function collectAttachmentRefs(): { name: string; path: string }[] {
  const seen = new Set<string>();
  for (const symptom of records.symptoms.list()) {
    if (typeof symptom.attachment === 'string' && symptom.attachment !== '') seen.add(symptom.attachment);
  }
  for (const note of records.notes.list()) {
    if (typeof note.attachment === 'string' && note.attachment !== '') seen.add(note.attachment);
  }
  const dir = attachmentsDir();
  try {
    for (const name of wx.getFileSystemManager().readdirSync(dir)) seen.add(dir + name);
  } catch (e) {
    // 附件目录不存在时视为无附件。
  }
  return Array.from(seen).map((path) => ({ name: baseName(path), path }));
}

function buildExportPayload(): Dict {
  const profile = records.profile.list();
  const symptoms = records.symptoms.list();
  const notes = records.notes.list();
  const questions = records.questions.list();
  const briefs = records.briefs.list();
  const memory = records.memory.list();
  const attachments = collectAttachmentRefs();
  return {
    app: '就医准备助手',
    exportedAt: new Date().toISOString(),
    notice: EXPORT.notice,
    counts: {
      profile: profile.length,
      symptoms: symptoms.length,
      notes: notes.length,
      questions: questions.length,
      briefs: briefs.length,
      memory: memory.length,
      attachments: attachments.length,
    },
    records: { profile, symptoms, notes, questions, briefs, memory },
    attachments,
  };
}

Page({
  data: {
    ...SIDEBAR_DATA,
    fontSize: FONT_SIZE_DEFAULT,
    scale: 1,
    fontMin: FONT_SIZE_MIN,
    fontMax: FONT_SIZE_MAX,
    accentColor: accentColorFor(false),
    highContrast: false,
    aiEnabled: false,
    consentVersion: null as number | null,
    consentText: '',
    autoMemory: true,
    demoMode: false,
    demoVisible: false,
    memories: [] as MemoryRow[],
    hasMemories: false,
    memoryDraft: '',
    editingId: '',
    memoryError: '',
    exportPath: '',
    exportError: '',
    wipeError: '',
    resultText: '',
    labels: LABELS,
    buttons: BUTTONS,
    a11y: A11Y,
    memory: MEMORY,
    exportCopy: EXPORT,
    wipeCopy: WIPE,
    privacy: PRIVACY,
    disclaimers: DISCLAIMERS,
    about: ABOUT,
    demo: DEMO,
  },

  onShow() {
    syncSidebar(this);
    this.load();
  },

  /** 侧栏收起/展开：落盘偏好并回写 data。 */
  onSidebarToggle() {
    this.setData(setSidebarCollapsed(!this.data.sidebarCollapsed));
  },

  /** 读取偏好与记忆并刷新界面（返回本页时也会触发）。 */
  load() {
    const prefs = records.preferences.get();
    const memories = buildMemoryRows(records.memory.list());
    this.setData({
      fontSize: prefs.fontSize,
      scale: prefs.fontSize / FONT_SIZE_DEFAULT,
      accentColor: accentColorFor(prefs.highContrast),
      highContrast: prefs.highContrast,
      aiEnabled: prefs.aiEnabled,
      consentVersion: prefs.consentVersion,
      consentText: consentStatusText(prefs),
      autoMemory: prefs.autoMemory,
      demoMode: prefs.demoMode,
      demoVisible: isDevelopEnv(),
      memories,
      hasMemories: memories.length > 0,
      memoryError: '',
    });
  },

  /** 仅刷新记忆列表（新增/编辑/启停/删除/清空后调用）。 */
  refreshMemories() {
    const memories = buildMemoryRows(records.memory.list());
    this.setData({ memories, hasMemories: memories.length > 0 });
  },

  // ----- 显示与无障碍 -----

  /** 拖动过程中仅预览缩放，不写存储。 */
  onFontSizeChanging(event: WechatMiniprogram.SliderChanging) {
    const value = toInt(event.detail.value);
    if (Number.isNaN(value)) return;
    this.setData({ fontSize: value, scale: value / FONT_SIZE_DEFAULT });
  },

  /** 拖动结束：写入偏好（records 负责 14–32 夹取）。 */
  onFontSizeChange(event: WechatMiniprogram.SliderChange) {
    const value = toInt(event.detail.value);
    if (Number.isNaN(value)) return;
    const prefs = records.preferences.update({ fontSize: value });
    this.setData({ fontSize: prefs.fontSize, scale: prefs.fontSize / FONT_SIZE_DEFAULT });
    if (typeof wx.vibrateShort === 'function') wx.vibrateShort({ type: 'light' });
  },

  onHighContrastChange(event: WechatMiniprogram.SwitchChange) {
    const highContrast = event.detail.value === true;
    records.preferences.update({ highContrast });
    this.setData({ highContrast, accentColor: accentColorFor(highContrast) });
  },

  // ----- AI 外部调用 -----

  /**
   * 开启需同意：弹窗说明发送范围，确认才写入 aiEnabled + consentVersion；
   * 取消（或宿主无弹窗能力）保持关闭。关闭立即生效。
   */
  onAiEnabledChange(event: WechatMiniprogram.SwitchChange) {
    const next = event.detail.value === true;
    if (!next) {
      records.preferences.update({ aiEnabled: false });
      this.setData({ aiEnabled: false, consentText: consentStatusText(records.preferences.get()) });
      if (typeof wx.showToast === 'function') wx.showToast({ title: '已关闭外部 AI 调用', icon: 'none' });
      return;
    }

    const enable = () => {
      const prefs = records.preferences.update({
        aiEnabled: true,
        consentVersion: PRIVACY_NOTICE_VERSION,
      });
      this.setData({
        aiEnabled: prefs.aiEnabled,
        consentVersion: prefs.consentVersion,
        consentText: consentStatusText(prefs),
      });
      if (typeof wx.showToast === 'function') wx.showToast({ title: '已开启外部 AI 调用', icon: 'success' });
    };
    const keepOff = () => {
      this.setData({ aiEnabled: false });
    };

    if (typeof wx.showModal === 'function') {
      wx.showModal({
        title: CONSENT.enableAiTitle,
        content: buildAiConsentContent(),
        confirmText: '我同意',
        cancelText: '保持关闭',
        success: (res) => {
          if (res.confirm) enable();
          else keepOff();
        },
        fail: keepOff,
      });
    } else {
      keepOff();
    }
  },

  // ----- AI 记忆 -----

  onMemoryDraftInput(event: WechatMiniprogram.Input) {
    this.setData({ memoryDraft: event.detail.value, memoryError: '' });
  },

  /** 新增或编辑：编辑中 editingId 非空则 update，否则 add（来源固定为手动）。 */
  onMemorySave() {
    const text = this.data.memoryDraft.trim();
    if (text === '') {
      this.setData({ memoryError: MEMORY.requiredHint });
      if (typeof wx.showToast === 'function') wx.showToast({ title: MEMORY.requiredHint, icon: 'none' });
      return;
    }
    if (this.data.editingId !== '') {
      records.memory.update(this.data.editingId, { text });
    } else {
      records.memory.add({ text, source: 'manual' });
    }
    this.setData({ memoryDraft: '', editingId: '', memoryError: '' });
    this.refreshMemories();
    if (typeof wx.showToast === 'function') wx.showToast({ title: MEMORY.savedHint, icon: 'success' });
  },

  /** 点击记忆行 → 载入编辑表单。 */
  onMemoryEdit(event: WechatMiniprogram.TouchEvent) {
    const id = event.currentTarget.dataset.id;
    if (typeof id !== 'string' || id === '') return;
    const item = records.memory.get(id);
    if (item === null) return;
    this.setData({ editingId: item.id, memoryDraft: item.text, memoryError: '' });
    if (typeof wx.vibrateShort === 'function') wx.vibrateShort({ type: 'light' });
  },

  onMemoryCancelEdit() {
    this.setData({ editingId: '', memoryDraft: '', memoryError: '' });
  },

  onMemoryToggle(event: WechatMiniprogram.SwitchChange) {
    const id = event.currentTarget.dataset.id;
    if (typeof id !== 'string' || id === '') return;
    records.memory.update(id, { enabled: event.detail.value === true });
    this.refreshMemories();
  },

  onMemoryDelete(event: WechatMiniprogram.TouchEvent) {
    const id = event.currentTarget.dataset.id;
    if (typeof id !== 'string' || id === '') return;
    const doDelete = () => {
      records.memory.remove(id);
      this.refreshMemories();
      if (typeof wx.showToast === 'function') wx.showToast({ title: '记忆已删除', icon: 'none' });
    };
    if (typeof wx.showModal === 'function') {
      wx.showModal({
        title: MEMORY.deleteTitle,
        content: MEMORY.deleteConfirm,
        success: (res) => {
          if (res.confirm) doDelete();
        },
      });
    }
  },

  /** 清空全部记忆：逐条 remove（records.memory 无批量接口）。 */
  onMemoryClearAll() {
    const doClear = () => {
      const list = records.memory.list();
      for (const item of list) records.memory.remove(item.id);
      this.refreshMemories();
      this.setData({ resultText: `已清空 ${list.length} 条记忆。` });
      if (typeof wx.showToast === 'function') wx.showToast({ title: '记忆已清空', icon: 'none' });
    };
    if (typeof wx.showModal === 'function') {
      wx.showModal({
        title: MEMORY.clearAllTitle,
        content: MEMORY.clearAllConfirm,
        success: (res) => {
          if (res.confirm) doClear();
        },
      });
    }
  },

  onAutoMemoryChange(event: WechatMiniprogram.SwitchChange) {
    const autoMemory = event.detail.value === true;
    records.preferences.update({ autoMemory });
    this.setData({ autoMemory });
  },

  /** 演示模式开关（仅开发者工具可见）：写入 preferences.demoMode；AI 输出改走本地固定内容。
   *  自足可用：只开此开关即可出结果，无需同时开启「允许外部 AI 调用」（演示全程零外发）。 */
  onDemoModeChange(event: WechatMiniprogram.SwitchChange) {
    const demoMode = event.detail.value === true;
    records.preferences.update({ demoMode });
    this.setData({ demoMode });
    if (typeof wx.showToast === 'function') {
      wx.showToast({ title: demoMode ? DEMO.enabledHint : DEMO.disabledHint, icon: 'none' });
    }
  },

  // ----- 数据 -----

  /** 导出全部：文字记录 + 附件名称/路径引用，写入 USER_DATA_PATH，无网络。 */
  onExport() {
    this.setData({ exportPath: '', exportError: '' });
    let payload: Dict;
    try {
      payload = buildExportPayload();
    } catch (err) {
      this.setData({ exportError: errorText(err) });
      return;
    }
    const json = JSON.stringify(payload, null, 2);
    const filePath = `${wx.env.USER_DATA_PATH}/mhp_export_${Date.now()}.json`;
    wx.getFileSystemManager().writeFile({
      filePath,
      data: json,
      encoding: 'utf8',
      success: () => {
        oplog.append('export', filePath);
        this.setData({ exportPath: filePath, resultText: `已导出到：${filePath}` });
        if (typeof wx.showToast === 'function') wx.showToast({ title: EXPORT.doneHint, icon: 'success' });
      },
      fail: (err) => {
        this.setData({ exportError: errorText(err) });
        if (typeof wx.showToast === 'function') wx.showToast({ title: EXPORT.failedHint, icon: 'none' });
      },
    });
  },

  /** 清除所有本地资料：两步确认。 */
  onWipe() {
    if (typeof wx.showModal !== 'function') return;
    const finalConfirm = () => {
      wx.showModal({
        title: WIPE.secondTitle,
        content: WIPE.secondContent,
        confirmText: '确认清除',
        cancelText: BUTTONS.cancel,
        success: (res) => {
          if (res.confirm) this.performWipe();
        },
      });
    };
    wx.showModal({
      title: WIPE.firstTitle,
      content: WIPE.firstContent,
      confirmText: '继续',
      cancelText: BUTTONS.cancel,
      success: (res) => {
        if (res.confirm) finalConfirm();
      },
    });
  },

  /**
   * 执行清除。任一步抛错即中止并保留现状（可重试）；成功则回读默认值并给出计数。
   * 顺序：记录 → 旧命名空间 → 附件目录 → 审计日志。
   */
  performWipe() {
    this.setData({ wipeError: '', resultText: '', exportPath: '', exportError: '' });
    try {
      const removedRecords = deleteAll();
      const purgedLegacy = storage.purgeLegacy();
      const clearedFiles = clearAttachments();
      oplog.append('clear', 'all');
      this.load();
      this.setData({
        memoryDraft: '',
        editingId: '',
        resultText: `已清除：本地记录 ${removedRecords} 项、旧数据 ${purgedLegacy} 项、附件文件 ${clearedFiles} 个。`,
      });
      if (typeof wx.showToast === 'function') wx.showToast({ title: WIPE.doneHint, icon: 'none' });
    } catch (err) {
      this.setData({ wipeError: errorText(err), resultText: '' });
      if (typeof wx.showToast === 'function') wx.showToast({ title: WIPE.failedHint, icon: 'none' });
    }
  },
});
