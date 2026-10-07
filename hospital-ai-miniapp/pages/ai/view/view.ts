// pages/ai/view/view.ts — workspace 用的 ai section 组件（Component 宿主）。
//
// 双宿主契约：data/methods 全部来自 controller 的纯对象工厂，两条宿主逐一展开；本文件只补
// 「组件宿主」所需的部分——highContrast 属性（根节点 is-hc）、entryMode 属性（入口 mode 透传）、
// 导航 seam 与 ai 特有的生命周期映射。
//
// 激活方法由 workspace 宿主通过 selectComponent 显式调用（切换进入/宿主显示/离开/隐藏），
// 本组件不自行接 pageLifetimes：pageLifetimes.show/hide 是页面级信号，不能代表 section 激活。
//
// ai 生命周期映射（见方案 §4.2；与重构前 Page 语义等价）：
//   onActivate   = 旧 onShow：pageHidden=false；首激活消费入口 mode；loadAll + refreshHealth；
//                  若入口/待处理 mode 为 consult 则在刷新后 setMode('consult')。
//                  切换回来后重置 destroyed=false（重新可用，等价于旧页面的「重新进入」）。
//   onDeactivate = 旧 onUnload / 切走：destroyed=true、sendToken++、abortPendingRequests()，
//                  实例内所有异步回调据 token/flag 判死，杜绝过期快照回写（等价旧 reLaunch 离开）。
//   onHostHide   = 旧 onHide：仅 pageHidden=true（宿主进后台，不 abort 在飞请求）。
//   onHostShow   = 旧页面无独立「宿主显示」语义：统一走 onActivate。

import { abortPendingRequests } from '../../../shared/services/aiClient';
import { aiData, aiMethods } from './controller';
import type { AiSectionInstance } from './controller';

/** 组件实例面：在 controller 的 AiSectionInstance 之外补组件宿主自有的入口标记。 */
interface AiViewInstance extends AiSectionInstance {
  /** 入口 mode 是否已消费（仅首次激活生效，之后 deep-link 不再重复切换）。 */
  entryApplied: boolean;
}

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
    /** 入口模式（workspace 从 query.mode 透传）：仅首次激活消费，'organize' | 'consult' | ''。 */
    entryMode: { type: String, value: '' },
  },

  data: aiData(),

  lifetimes: {
    /** 组件挂载：初始化与 Page 顶层实例字段等价的非 data 字段（controller 方法据其判活）。 */
    attached() {
      const inst = this as unknown as AiViewInstance;
      inst.initialMode = '';
      inst.selectedIds = [];
      inst.selectionInitialized = false;
      inst.pendingInput = null;
      inst.pendingText = '';
      inst.pendingInterview = null;
      inst.pendingKind = 'ask';
      inst.interviewOrigin = '';
      inst.destroyed = false;
      inst.sendToken = 0;
      inst.pageHidden = false;
      inst.entryApplied = false;
    },
  },

  methods: {
    ...aiMethods(),

    /** 导航 seam：section 内的路由跳转交由 workspace 宿主映射为内存切换（见方案 4.4）。 */
    hostNavigate(route: string) {
      this.triggerEvent('navigate', { route });
    },

    /** 切换进入 / 宿主重新显示：执行旧 onShow 的页级刷新（宿主的 a11y/sidebar/navbar 由 workspace 负责）。 */
    onActivate() {
      const inst = this as unknown as AiViewInstance;
      inst.pageHidden = false;
      // 切走后 destroyed=true 会阻断回调；切回时先复位，等价旧页面「重新进入」的可用状态。
      inst.destroyed = false;
      // 首激活消费入口 mode（镜像旧 onLoad 先于 onShow 的顺序：先落 mode / initialMode，再 loadAll）。
      if (!inst.entryApplied) {
        inst.entryApplied = true;
        const m = this.data.entryMode;
        if (m === 'organize') this.setData({ mode: 'organize' });
        else if (m === 'consult') inst.initialMode = 'consult';
      }
      this.loadAll();
      void this.refreshHealth();
      const initial = inst.initialMode;
      inst.initialMode = '';
      if (initial === 'consult') void this.setMode('consult');
    },

    /** 切换离开：等价旧 onUnload / reLaunch 离开——置死并中止全部在飞请求。 */
    onDeactivate() {
      const inst = this as unknown as AiViewInstance;
      inst.destroyed = true;
      inst.sendToken += 1;
      abortPendingRequests();
    },

    /** 宿主隐藏（后台）：等价旧 onHide，仅标记 pageHidden（用于后台不弹 toast），不中止在飞请求。 */
    onHostHide() {
      const inst = this as unknown as AiViewInstance;
      inst.pageHidden = true;
    },

    /** 宿主显示：ai 无额外语义，统一走 onActivate。 */
    onHostShow() {},
  },
});
