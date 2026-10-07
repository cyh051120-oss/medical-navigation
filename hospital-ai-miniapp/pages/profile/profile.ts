// pages/profile/profile.ts — 最小个人档案 wrapper 页（任务 14；workspace 重构 P2）。
//
// 重构后本页 = 薄 wrapper：data/methods 来自 pages/profile/view/controller.ts 的纯对象工厂
// （与 workspace section 组件同一单源），本文件只保留宿主页职责——生命周期前奏与侧栏状态。
//
// 结构：根壳（.profile + app-shell + is-hc/is-collapsed + inline scale 变量）＋ <app-sidebar/> ＋
// <include src="./view/body.wxml"/>；样式 @import ./view/body.wxss。
//
// 双宿主契约：data 键集与方法名集必须与重构前逐一相同（面快照证据）。
// 禁止用平台 behaviors 承载业务逻辑（H 层捕获不展开 behaviors）。

import { A11Y_DATA, syncA11y } from '../../shared/ui/a11y';
import { SIDEBAR_DATA, setSidebarCollapsed, syncSidebar } from '../../shared/ui/sidebar';
import { profileData, profileMethods } from './view/controller';

Page({
  data: {
    ...profileData(),
    ...A11Y_DATA,
    ...SIDEBAR_DATA,
  },

  ...profileMethods(),

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
    this.load();
  },

  /** 侧栏收起/展开：落盘偏好并回写 data。 */
  onSidebarToggle() {
    this.setData(setSidebarCollapsed(!this.data.sidebarCollapsed));
  },
});
