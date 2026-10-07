// pages/brief/view/view.ts — workspace 用的 brief section 组件（Component 宿主）。
//
// 双宿主契约：data/methods 全部来自 controller 的纯对象工厂，两条宿主逐一展开；本文件只补
// 「组件宿主」所需的部分——highContrast 属性（根节点 is-hc）、导航 seam、canvas 选区 seam
// 与激活生命周期映射。
//
// 激活方法由 workspace 宿主通过 selectComponent 显式调用（切换进入/宿主显示/离开/隐藏），
// 本组件不自行接 pageLifetimes：pageLifetimes.show/hide 是页面级信号，不能代表 section 激活。

import { briefData, briefMethods } from './controller';

Component({
  options: {
    // body 复用设计系统的全局类（.mhp-error / .mhp-empty / .mhp-ico / .is-hc），
    // 而组件默认 isolated 隔离会阻断 app.wxss 样式；apply-shared 让页面（含 app.wxss）
    // 样式作用于本组件，同时本组件样式不外泄，避免复制全局规则。
    styleIsolation: 'apply-shared',
  },

  properties: {
    /** 高对比：根节点加 is-hc（宿主页根的 is-hc 亦经 CSS 变量继承，二者等价）。 */
    highContrast: { type: Boolean, value: false },
  },

  data: briefData(),

  methods: {
    ...briefMethods(),

    /** 导航 seam：section 内的路由跳转交由 workspace 宿主映射为内存切换（见方案 4.4）。 */
    hostNavigate(route: string) {
      this.triggerEvent('navigate', { route });
    },

    /**
     * canvas 选区 seam：自定义组件内必须用 wx.createSelectorQuery().in(this)，否则选区
     * 默认只覆盖页面范围节点，取不到本组件内的 #briefPoster。controller 经 queryScope()
     * 消费本作用域；wrapper 不实现该方法 → 回落 wx.createSelectorQuery()（行为同重构前）。
     */
    queryScope() {
      return wx.createSelectorQuery().in(this);
    },

    /** 切换进入 / 宿主重新显示：执行原 onShow 的页级刷新（宿主的 a11y/sidebar/navbar 由 workspace 负责）。 */
    onActivate() {
      this.refresh();
    },

    /** brief 无「切换离开」语义（无在飞请求/无未决授权/原页无 onUnload 逻辑）。 */
    onDeactivate() {},

    /** brief 无「宿主隐藏」语义（原页无 onHide）。 */
    onHostHide() {},

    /** brief 无「宿主显示」额外语义（统一走 onActivate）。 */
    onHostShow() {},
  },
});
