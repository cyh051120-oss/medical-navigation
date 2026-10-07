// pages/settings/view/view.ts — workspace 用的 settings section 组件（Component 宿主）。
//
// 双宿主契约：data/methods 全部来自 controller 的纯对象工厂，两条宿主逐一展开；本文件只补
// 「组件宿主」所需的部分——highContrast 属性（根节点 is-hc）、导航 seam、偏好广播与
// settings 特有的激活生命周期映射（隐私 resolver 注册/注销）。
//
// 激活方法由 workspace 宿主通过 selectComponent 显式调用（切换进入/宿主显示/离开/隐藏），
// 本组件不自行接 pageLifetimes：pageLifetimes.show/hide 是页面级信号，不能代表 section 激活。
//
// settings 生命周期映射（见方案 §4.2；与重构前 Page 生命周期语义等价）：
//   onActivate   = 旧 onShow：pageShown=true；注册隐私 resolver；load + refreshPrivacyStatus。
//                  （syncSidebar / setNavigationBarColor 为宿主职责，由 workspace 负责。）
//   onDeactivate = 旧 onUnload：结算挂起授权 + 注销 resolver。
//   onHostHide   = 旧 onHide：与 onDeactivate 同等清理。
//   onHostShow   = 旧页面无独立「宿主显示」语义：统一走 onActivate。

import { setPrivacyAuthResolver } from '../../../app';
import { settingsData, settingsMethods } from './controller';
import type { SettingsSectionInstance } from './controller';

Component({
  options: {
    // body 复用设计系统的全局类（.mhp-error / .mhp-empty / .is-hc），
    // 而组件默认 isolated 隔离会阻断 app.wxss 样式；apply-shared 让页面（含 app.wxss）
    // 样式作用于本组件，同时本组件样式不外泄，避免复制全局规则。
    styleIsolation: 'apply-shared',
  },

  properties: {
    /** 高对比：根节点加 is-hc（宿主页根的 is-hc 亦经 CSS 变量继承，二者等价）。 */
    highContrast: { type: Boolean, value: false },
  },

  data: settingsData(),

  lifetimes: {
    /** 组件挂载：初始化与 Page 顶层实例字段等价的非 data 字段（controller 方法据其判活）。 */
    attached() {
      const inst = this as unknown as SettingsSectionInstance;
      inst.pageShown = false;
      inst.pendingPrivacyResolve = null;
    },
  },

  methods: {
    ...settingsMethods(),

    /** 导航 seam：settings 现无路由跳转调用点；保留以与其它 section 一致（见方案 4.4）。 */
    hostNavigate(route: string) {
      this.triggerEvent('navigate', { route });
    },

    /** 偏好广播（方案 §4.3）：偏好变更 → 通知 workspace 宿主重取并下发。 */
    hostPrefsChanged() {
      this.triggerEvent('prefs-changed');
    },

    /** 切换进入 / 宿主重新显示：执行原 onShow 的页级刷新（宿主的 a11y/sidebar/navbar 由 workspace 负责）。 */
    onActivate() {
      const inst = this as unknown as SettingsSectionInstance;
      inst.pageShown = true;
      this.registerPrivacyResolver();
      this.load();
      this.refreshPrivacyStatus();
    },

    /** 切换离开：等价旧 onUnload / 离开——结算挂起授权并注销 resolver。 */
    onDeactivate() {
      const inst = this as unknown as SettingsSectionInstance;
      inst.pageShown = false;
      this.finishPrivacyAuth(false, '');
      setPrivacyAuthResolver(null);
    },

    /** 宿主隐藏（后台）：等价旧 onHide，与离开同等清理。 */
    onHostHide() {
      const inst = this as unknown as SettingsSectionInstance;
      inst.pageShown = false;
      this.finishPrivacyAuth(false, '');
      setPrivacyAuthResolver(null);
    },

    /** 宿主显示：settings 无额外语义，统一走 onActivate。 */
    onHostShow() {},
  },
});
