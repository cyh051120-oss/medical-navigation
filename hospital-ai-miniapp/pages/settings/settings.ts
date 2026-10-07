// pages/settings/settings.ts — 设置 wrapper 页（任务 15；workspace 重构 P2）。
//
// 重构后本页 = 薄 wrapper：data/methods 来自 pages/settings/view/controller.ts 的纯对象工厂
// （与 workspace section 组件同一单源），本文件只保留宿主页职责——生命周期前奏、侧栏状态，
// 以及设置页特有的隐私授权 resolver 注册/注销（onShow/onHide/onUnload 原样保留）。
//
// 结构：根壳（.settings + app-shell + is-hc/is-collapsed + inline scale 变量）＋ <app-sidebar/> ＋
// <include src="./view/body.wxml"/>；样式 @import ./view/body.wxss。
//
// 双宿主契约：data 键集与方法名集必须与重构前逐一相同（面快照证据）。
// 禁止用平台 behaviors 承载业务逻辑（H 层捕获不展开 behaviors）。
//
// 页级服务依赖声明（path-pinned shim）：settings 的偏好/隐私实际调用在 view/controller.ts
// （相对路径更深，为 `../../../app`）。此处以 `../../app` 重新导出，使 S 层静态扫描的页 bundle
// （wrapper + controller + view）仍能读到页级 `../../app` 依赖（settings spec 的 imports 断言）。

import { SIDEBAR_DATA, setSidebarCollapsed, syncSidebar } from '../../shared/ui/sidebar';
import { setPrivacyAuthResolver } from '../../app';
import type { PrivacyAuthResolution } from '../../app';
import { settingsData, settingsMethods } from './view/controller';

// path-pinned re-export shim（ai.ts 风格）：保持页级 '../../app' 依赖可见（S 层静态扫描）。
export { PRIVACY_NOTICE_VERSION, setPrivacyAuthResolver } from '../../app';

Page({
  /** 页面是否处于可见（onShow..onHide）状态；不可见时不承接授权弹窗，直接拒绝。 */
  pageShown: false,
  /** 当前挂起的隐私授权 resolve；非空表示有隐私接口在等待用户决定。 */
  pendingPrivacyResolve: null as ((result: PrivacyAuthResolution) => void) | null,

  data: {
    ...settingsData(),
    ...SIDEBAR_DATA,
  },

  ...settingsMethods(),

  onShow() {
    this.pageShown = true;
    this.registerPrivacyResolver();
    syncSidebar(this);
    this.load();
    this.refreshPrivacyStatus();
    if (typeof wx.setNavigationBarColor === 'function') {
      const hc = this.data.highContrast === true;
      wx.setNavigationBarColor({
        frontColor: hc ? '#ffffff' : '#000000',
        backgroundColor: hc ? '#000000' : '#ffffff',
      });
    }
  },

  /** 离开本页（未销毁）：撤销挂起授权并注销解析器，隐私接口不会永久 pending。 */
  onHide() {
    this.pageShown = false;
    this.finishPrivacyAuth(false, '');
    setPrivacyAuthResolver(null);
  },

  /** 销毁本页：与 onHide 同等清理（注销解析器 + 无挂起请求）。 */
  onUnload() {
    this.pageShown = false;
    this.finishPrivacyAuth(false, '');
    setPrivacyAuthResolver(null);
  },

  /** 侧栏收起/展开：落盘偏好并回写 data。 */
  onSidebarToggle() {
    this.setData(setSidebarCollapsed(!this.data.sidebarCollapsed));
  },
});
