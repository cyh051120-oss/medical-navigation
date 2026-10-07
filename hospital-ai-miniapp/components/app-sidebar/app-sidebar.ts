// components/app-sidebar/app-sidebar.ts — 全局可折叠左侧导航栏。
//
// 设计要点：
//   - 页面把 8 个页面注册为侧栏项（shared/ui/nav.ts 是唯一数据源）。
//   - 组件只负责展示与派发：收起/展开通过 triggerEvent('toggle') 交由页面落盘
//     （页面调用 shared/ui/sidebar.setSidebarCollapsed），组件自身不读写存储。
//   - 固定定位（position: fixed）；页面根节点加 `app-shell` 后由 app.wxss 用
//     margin-left: var(--mhp-sidebar-w) 为侧栏让位，两者宽度共用 --mhp-layout-scale。
//   - 样式隔离 isolated：仅本组件 wxss 生效；但 CSS 自定义属性（颜色/间距令牌）
//     仍从页面根节点继承，故高对比 .is-hc 会自动作用于侧栏。--mhp-scale 另由
//     `scale` 属性显式写入组件根节点，保证图标与文字随全局字号缩放。
//   - 切页（侧栏是全局主导航）：按页面栈深度分流。栈深 > 1 用 wx.reLaunch 重置整个
//     页面栈，避免 navigateTo 在 8 项间反复入栈超出 10 页上限；栈深 <= 1 时栈内只有
//     当前页，wx.redirectTo 原地替换与 reLaunch 语义等价（都得到 [目标页]、无返回箭头）
//     且更轻（不销毁全部页面）。工作台自身的入口仍用 navigateTo，保留返回栈语义。
//   - mode（workspace 单页宿主）：默认 'navigate' 保持上面的整页跳转；'select' 时改为
//     triggerEvent('select', { key, route }) 把切换交给页面内存处理（SPA 不重建页面）。
//     wrapper 路由页不传 mode，行为与重构前逐一相同。

import { NAV_ITEMS } from '../../shared/ui/nav';
import type { NavItem } from '../../shared/ui/nav';

Component({
  options: {
    styleIsolation: 'isolated',
  },

  properties: {
    /** 当前页面 key（对应 NAV_ITEMS[].key），用于高亮当前项。 */
    current: { type: String, value: '' },
    /** 是否收起为纯图标栏。 */
    collapsed: { type: Boolean, value: false },
    /** 全局字号缩放系数，写入组件根节点 --mhp-scale。 */
    scale: { type: Number, value: 1 },
    /**
     * 切页模式：'navigate'（默认，整页跳转）或 'select'（派发 select 事件，由 workspace
     * 宿主在内存内切换 section）。默认值保持所有既有 wrapper 页行为不变。
     */
    mode: { type: String, value: 'navigate' },
  },

  data: {
    items: NAV_ITEMS as readonly NavItem[],
  },

  methods: {
    /** 收起 / 展开：只派发事件，由页面负责落盘并回写 data。 */
    onToggle() {
      this.triggerEvent('toggle');
    },

    /** 点击导航项：已是当前页则忽略；mode='select' 交给宿主内存切换，否则整页跳转。 */
    onTapItem(event: WechatMiniprogram.TouchEvent) {
      const key = event.currentTarget.dataset.key;
      const route = event.currentTarget.dataset.route;
      if (typeof route !== 'string' || route === '') return;
      if (typeof key === 'string' && key === this.data.current) return;

      // select 模式（workspace 单页宿主）：不导航，只把目标交给宿主决定切换方式。
      if (this.data.mode === 'select') {
        this.triggerEvent('select', { key, route });
        return;
      }

      const target = '/' + route;
      // 等价性：栈深 <= 1 时 redirectTo 与 reLaunch 都以 [目标页] 收尾、都无返回箭头，
      // 故可走更轻的 redirectTo；栈深 > 1 时 redirectTo 只替换栈顶会留下下层返回箭头，
      // 破坏「侧栏切页即重置导航」的既有语义，故仍用 reLaunch 重置整栈。
      if (getCurrentPages().length > 1) {
        wx.reLaunch({ url: target });
      } else {
        wx.redirectTo({ url: target });
      }
    },

    /** 收起态长按：以 toast 显示导航项名称，作为触摸端 tooltip（读屏另有 aria-label）。 */
    onItemLongPress(event: WechatMiniprogram.TouchEvent) {
      const label = event.currentTarget.dataset.label;
      if (typeof label !== 'string' || label === '') return;
      if (typeof wx.showToast === 'function') {
        wx.showToast({ title: label, icon: 'none' });
      }
    },
  },
});
