// pages/brief/brief.ts — 就医摘要 wrapper 页（任务 20/21；workspace 重构 P2）。
//
// 重构后本页 = 薄 wrapper：data/methods 来自 pages/brief/view/controller.ts 的纯对象工厂
// （与 workspace section 组件同一单源），本文件只保留宿主页职责——生命周期前奏、侧栏状态
// 与唯一的页级 onShareAppMessage。
//
// 结构：根壳（.brief + app-shell + is-hc/is-collapsed + inline scale 变量）＋ <app-sidebar/> ＋
// <include src="./view/body.wxml"/>；样式 @import ./view/body.wxss。
//
// 双宿主契约：data 键集与方法名集必须与重构前逐一相同（面快照证据）。
// 禁止用平台 behaviors 承载业务逻辑（H 层捕获不展开 behaviors）。

import { A11Y_DATA, syncA11y } from '../../shared/ui/a11y';
import { SIDEBAR_DATA, setSidebarCollapsed, syncSidebar } from '../../shared/ui/sidebar';
import { POSTER } from '../../config/texts';
import { briefData, briefMethods } from './view/controller';

// 页级服务依赖声明（path-pinned shim）：brief / poster 的实际调用在 view/controller.ts
// （相对路径更深，为 `../../../shared/...`）。此处保留页级导入路径，使 S 层静态扫描的
// 页 bundle（wrapper + controller + view）仍能读到这两个依赖（brief.spec / brief-image.spec 断言）。
export { build, toClipboard } from '../../shared/services/brief';
export { buildPosterPlan, drawPoster } from '../../shared/services/poster';

Page({
  data: {
    ...briefData(),
    ...A11Y_DATA,
    ...SIDEBAR_DATA,
  },

  ...briefMethods(),

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

  /** 分享：open-type="share" 触发；分享本工具入口，不携带任何本地记录。 */
  onShareAppMessage() {
    return { title: POSTER.shareTitle, path: '/pages/brief/brief' };
  },
});
