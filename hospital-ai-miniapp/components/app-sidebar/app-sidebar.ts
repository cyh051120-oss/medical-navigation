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
//   - 切页用 wx.reLaunch（侧栏是全局主导航）：避免 navigateTo 在 8 项间反复入栈
//     超出 10 页上限；工作台自身的入口仍用 navigateTo，保留返回栈语义。

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
  },

  data: {
    items: NAV_ITEMS as readonly NavItem[],
  },

  methods: {
    /** 收起 / 展开：只派发事件，由页面负责落盘并回写 data。 */
    onToggle() {
      this.triggerEvent('toggle');
    },

    /** 点击导航项：切到目标页；已是当前页则忽略，避免无谓 reLaunch。 */
    onTapItem(event: WechatMiniprogram.TouchEvent) {
      const key = event.currentTarget.dataset.key;
      const route = event.currentTarget.dataset.route;
      if (typeof route !== 'string' || route === '') return;
      if (typeof key === 'string' && key === this.data.current) return;
      wx.reLaunch({ url: '/' + route });
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
