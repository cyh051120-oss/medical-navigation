// pages/home/home.ts — 个人工作台 wrapper 页（任务 13；workspace 重构 P1）。
//
// 重构后本页 = 薄 wrapper：data/methods 来自 pages/home/view/controller.ts 的纯对象工厂
// （与 workspace section 组件同一单源），本文件只保留宿主页职责——生命周期前奏与侧栏状态。
//
// 结构：根壳（.workbench + app-shell + is-hc/is-collapsed + inline scale 变量）＋ <app-sidebar/> ＋
// <include src="./view/body.wxml"/>；样式 @import ./view/body.wxss。
//
// 双宿主契约：data 键集与方法名集必须与重构前逐一相同（面快照证据）。本页只读——
// 不写入任何记录 / 存储（home.spec 的 homeReadOnly 依赖此只读性）。

import { A11Y_DATA, syncA11y } from '../../shared/ui/a11y';
import { SIDEBAR_DATA, setSidebarCollapsed, syncSidebar } from '../../shared/ui/sidebar';
import { homeData, homeMethods } from './view/controller';

Page({
  data: {
    ...homeData(),
    ...A11Y_DATA,
    ...SIDEBAR_DATA,
  },

  ...homeMethods(),

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
});
