// pages/workspace/workspace.ts — 单页工作台（workspace SPA）宿主页（P1 基建）。
//
// 职责：作为 app.json 的启动页，在单页内承载各功能区 section（内存切换，不重建页面），
// 并统一持有宿主级状态：a11y（字号/高对比）、侧栏（展开/收起）、系统导航栏标题与分享。
//
// 范围：全部 8 个功能区均已迁入本页为 section（内存切换）；wrapper 路由页保留为兼容面
// （深链/e2e/截图），本页不再发起整页跳转。
//
// section 生命周期映射（见方案 4.2）：切换进入/宿主显示 → onActivate；切换离开 → onDeactivate；
// 宿主隐藏 → onHostHide。由本页显式调用，不用平台 behaviors（H 层捕获不展开 behaviors）。

import { A11Y_DATA, syncA11y } from '../../shared/ui/a11y';
import { SIDEBAR_DATA, setSidebarCollapsed, syncSidebar } from '../../shared/ui/sidebar';
import { NAV_ITEMS } from '../../shared/ui/nav';
import { POSTER } from '../../config/texts';

/** 已迁移的 section 注册表（key 对应 NAV_ITEMS[].key）。 */
const MIGRATED_SECTIONS: readonly string[] = ['home', 'profile', 'notes', 'questions', 'symptoms', 'brief', 'ai', 'settings'];

/** workspace 默认（回落）section。 */
const DEFAULT_SECTION = 'home';

/** workspace 使用的 section 组件最小契约（页面经 selectComponent 取实例）。 */
interface SectionComponent {
  onActivate?(): void;
  onDeactivate?(): void;
  onHostHide?(): void;
  onHostShow?(): void;
}

/** 系统导航栏标题的唯一来源：shared/ui/nav.ts 的 title。 */
function titleFor(key: string): string {
  const item = NAV_ITEMS.find((entry) => entry.key === key);
  return item ? item.title : '';
}

Page({
  data: {
    active: DEFAULT_SECTION,
    mounted: { home: true },
    /** ai section 的入口模式（onLoad 从 query.mode 透传；ai-view 仅首次激活消费）。 */
    aiMode: '',
    ...A11Y_DATA,
    ...SIDEBAR_DATA,
  },

  /** onLoad 解析出的 ai 模式（P1 暂存，供后续 ai section 透传）。 */
  mode: '',

  onLoad(query: Record<string, string | undefined>) {
    const section = query && typeof query.section === 'string' ? query.section : '';
    // 仅已迁移 section 可激活；未知/未迁移的 section 一律回落到默认 section。
    const active = MIGRATED_SECTIONS.includes(section) ? section : DEFAULT_SECTION;
    const mode = query && typeof query.mode === 'string' ? query.mode : '';
    this.mode = mode;
    this.setData({ active, aiMode: mode, mounted: { ...this.data.mounted, [active]: true } });
    this.applyTitle(active);
  },

  onShow() {
    syncA11y(this);
    syncSidebar(this);
    this.syncNavColor();
    this.activate(this.data.active);
  },

  /** 首次渲染完成后补一次激活：onShow 早于首帧渲染，此时 selectComponent 可能尚未就绪。 */
  onReady() {
    this.activate(this.data.active);
  },

  onHide() {
    this.section(this.data.active)?.onHostHide?.();
  },

  /** 侧栏收起/展开：落盘偏好并回写 data（语义与各路由页一致）。 */
  onSidebarToggle() {
    this.setData(setSidebarCollapsed(!this.data.sidebarCollapsed));
  },

  /** 侧栏 select：内存切换 section（8 项全部已迁移；未知 key 保底不动作）。 */
  onSelect(event: WechatMiniprogram.CustomEvent<{ key?: string; route?: string }>) {
    const detail = event.detail || {};
    const key = typeof detail.key === 'string' ? detail.key : '';
    const route = typeof detail.route === 'string' ? detail.route : '';
    if (key === '' || route === '') return;
    if (key === this.data.active) return;

    this.switchSection(key);
  },

  /** section 内导航 seam：controller 经 hostNavigate 触发；按 route 反查 key 后走同一内存切换。 */
  onSectionNavigate(event: WechatMiniprogram.CustomEvent<{ route?: string }>) {
    const detail = event.detail || {};
    const route = typeof detail.route === 'string' ? detail.route : '';
    if (route === '') return;
    const item = NAV_ITEMS.find((entry) => entry.route === route);
    if (!item) return;
    if (item.key === this.data.active) return;

    this.switchSection(item.key);
  },

  /** 已迁移 section 的内存切换（onSelect 与 onSectionNavigate 共用）；不在注册表的 key 保底返回 false。 */
  switchSection(key: string): boolean {
    if (!MIGRATED_SECTIONS.includes(key)) return false;
    this.section(this.data.active)?.onDeactivate?.();
    this.setData({ active: key, mounted: { ...this.data.mounted, [key]: true } });
    this.applyTitle(key);
    this.activate(key);
    return true;
  },

  onShareAppMessage() {
    // brief 激活时复用原页分享标题语义（POSTER.shareTitle），路径统一回 workspace（方案 §4.3）；
    // 其余 section 保持默认分享文案与路径不变。
    const title = this.data.active === 'brief' ? POSTER.shareTitle : '就医准备助手';
    return { title, path: '/pages/workspace/workspace' };
  },

  /** 取已挂载的 section 组件；未挂载返回 null。 */
  section(key: string): SectionComponent | null {
    return this.selectComponent('#sec-' + key) as unknown as SectionComponent | null;
  },

  /** 激活 section：切换进入或宿主重新显示（语义由 section 自行决定）。 */
  activate(key: string) {
    const comp = this.section(key);
    if (comp !== null && typeof comp.onActivate === 'function') comp.onActivate();
  },

  /** 设置系统导航栏标题（单源 = shared/ui/nav.ts 的 title）。 */
  applyTitle(key: string) {
    const title = titleFor(key);
    if (title !== '' && typeof wx.setNavigationBarTitle === 'function') {
      wx.setNavigationBarTitle({ title });
    }
  },

  /** 偏好变更后刷新 a11y 与导航栏颜色。 */
  refreshPrefs() {
    syncA11y(this);
    this.syncNavColor();
  },

  /** 偏好广播（方案 §4.3）：settings section 变更偏好 → 宿主重取 a11y 与导航栏颜色。 */
  onPrefsChanged() {
    this.refreshPrefs();
  },

  /** 依当前高对比状态刷新导航栏前景/背景色（与各路由页 onShow 前奏一致）。 */
  syncNavColor() {
    if (typeof wx.setNavigationBarColor !== 'function') return;
    const hc = this.data.highContrast === true;
    wx.setNavigationBarColor({
      frontColor: hc ? '#ffffff' : '#000000',
      backgroundColor: hc ? '#000000' : '#ffffff',
    });
  },
});
