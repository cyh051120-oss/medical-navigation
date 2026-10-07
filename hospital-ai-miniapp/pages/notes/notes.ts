// pages/notes/notes.ts — 资料摘录 wrapper 页（任务 18；workspace 重构 P2）。
//
// 重构后本页 = 薄 wrapper：data/methods 来自 pages/notes/view/controller.ts 的纯对象工厂
// （与 workspace section 组件同一单源），本文件只保留宿主页职责——生命周期前奏与侧栏状态。
//
// 结构：根壳（.notes + app-shell + is-hc/is-collapsed + inline scale 变量）＋ <app-sidebar/> ＋
// <include src="./view/body.wxml"/>；样式 @import ./view/body.wxss。
//
// 双宿主契约：data 键集与方法名集必须与重构前逐一相同（面快照证据）。
// 禁止用平台 behaviors 承载业务逻辑（H 层捕获不展开 behaviors）。

import { A11Y_DATA, syncA11y } from '../../shared/ui/a11y';
import { SIDEBAR_DATA, setSidebarCollapsed, syncSidebar } from '../../shared/ui/sidebar';
import { notesData, notesMethods } from './view/controller';

// 页级附件依赖声明：资料摘录的附件读写经 shared/services/attachments；实际调用在
// view/controller.ts（相对路径更深，为 `../../../shared/...`）。此处保留页级导入路径，
// 使 S 层静态扫描的页 bundle（wrapper + controller + view）仍能读到该依赖（notes.spec 断言）。
export {
  addWithAttachment,
  deleteRecordWithAttachment,
  replaceAttachment,
} from '../../shared/services/attachments';

Page({
  data: {
    ...notesData(),
    ...A11Y_DATA,
    ...SIDEBAR_DATA,
  },

  ...notesMethods(),

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
