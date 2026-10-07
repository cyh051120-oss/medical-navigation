// pages/ai/ai.ts — 三模式 AI 助手 wrapper 页（任务 29；workspace 重构 P2）。
//
// 重构后本页 = 薄 wrapper：data/methods 来自 pages/ai/view/controller.ts 的纯对象工厂
// （与 workspace section 组件同一单源），本文件只保留宿主页职责——生命周期前奏与 ai 特有的
// 在飞请求编排（onLoad/onShow/onHide/onUnload 原样保留）。
//
// 结构：根壳（.ai + app-shell + is-hc/is-collapsed + inline scale 变量）＋ <app-sidebar/> ＋
// <include src="./view/body.wxml"/>；样式 @import ./view/body.wxss。
//
// 双宿主契约：data 键集与方法名集必须与重构前逐一相同（面快照证据）。
// 禁止用平台 behaviors 承载业务逻辑（H 层捕获不展开 behaviors）。
//
// ai 的实例字段（initialMode/selectedIds/…/pageHidden）不在 data 中，与重构前顶层字段一致：
// wrapper 在此以顶层字段承载（组件宿主在 view.ts 的 attached 初始化）。

import { A11Y_DATA, syncA11y } from '../../shared/ui/a11y';
import { SIDEBAR_DATA, setSidebarCollapsed, syncSidebar } from '../../shared/ui/sidebar';
import { abortPendingRequests } from '../../shared/services/aiClient';
import type { AskInput, InterviewInput } from '../../shared/services/aiClient';
import { aiData, aiMethods } from './view/controller';

// 页级服务依赖声明（path-pinned shim）：demo 固定结果 / 本地整理 / 历史存储的实际调用在
// view/controller.ts（相对路径更深，为 `../../../shared/...`）。此处保留页级导入路径，使 S 层
// 静态扫描的页 bundle（wrapper + controller + view）仍能读到这些依赖（ai 各 spec 断言）。
export { demoAsk, demoExtractMemory, demoInterview } from '../../shared/services/demoAi';
export { organize } from '../../shared/services/organizer';
export * from '../../shared/utils/storage';

Page({
  initialMode: '' as string,
  selectedIds: [] as string[],
  selectionInitialized: false,
  pendingInput: null as AskInput | null,
  pendingText: '',
  /** 预览确认后的待发问诊引导请求（与 `pendingInput` 互斥）。 */
  pendingInterview: null as InterviewInput | null,
  /** 当前预览属于哪条链路：/api/ask 还是 /api/interview。 */
  pendingKind: 'ask' as 'ask' | 'interview',
  /** 本轮问诊引导的第一段描述，用作症状记录的「原话」。 */
  interviewOrigin: '',
  /** 页面是否已销毁：所有异步回调入口据此早退，禁止用过期快照回写。 */
  destroyed: false,
  /** 在飞发送序号：回调与当前序号不一致即视为过期，忽略。 */
  sendToken: 0,
  /** 页面是否在后台（onHide）：后台时不弹 toast。 */
  pageHidden: false,

  data: {
    ...aiData(),
    ...A11Y_DATA,
    ...SIDEBAR_DATA,
  },

  ...aiMethods(),

  onLoad(options: Record<string, string | undefined>) {
    const mode = options && typeof options.mode === 'string' ? options.mode : '';
    if (mode === 'organize') this.setData({ mode });
    else if (mode === 'consult') this.initialMode = 'consult';
  },

  onShow() {
    this.pageHidden = false;
    syncA11y(this);
    syncSidebar(this);
    if (typeof wx.setNavigationBarColor === 'function') {
      const hc = this.data.highContrast === true;
      wx.setNavigationBarColor({
        frontColor: hc ? '#ffffff' : '#000000',
        backgroundColor: hc ? '#000000' : '#ffffff',
      });
    }
    this.loadAll();
    void this.refreshHealth();
    const initial = this.initialMode;
    this.initialMode = '';
    if (initial === 'consult') void this.setMode('consult');
  },

  onHide() {
    this.pageHidden = true;
  },

  /** 页面销毁：标记失效、作废在飞序号、取消所有在飞请求（避免过期回调回写历史）。 */
  onUnload() {
    this.destroyed = true;
    this.sendToken += 1;
    abortPendingRequests();
  },

  /** 侧栏收起/展开：落盘偏好并回写 data。 */
  onSidebarToggle() {
    this.setData(setSidebarCollapsed(!this.data.sidebarCollapsed));
  },
});
