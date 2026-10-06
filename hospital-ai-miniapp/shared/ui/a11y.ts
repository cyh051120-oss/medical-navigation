// shared/ui/a11y.ts — 全局无障碍状态（任务 16）：字号缩放 + 高对比。
//
// 单一机制：8 个页面在 onShow() 调用 syncA11y(this)，把 AppPreferences.fontSize /
// highContrast 写进本页 data；页面根节点再用
//   style="--mhp-scale: {{scale}}; --mhp-layout-scale: {{layoutScale}}"
//   class="... {{highContrast ? 'is-hc' : ''}}"
// 消费。字号缩放因此由 app.wxss 的 `--mhp-scale` 变量统一驱动，各页字号一律写成
// `calc(Nrpx * var(--mhp-scale))`，不写死 px；高对比由 app.wxss 的全局 `.is-hc`
// 变量映射统一接管（settings 页保留其等价作用域块以兼容既有契约）。
//
// 字号 scale 与布局 layoutScale 分离（P1-31）：字号可以一直放大，但侧栏宽度这类
// 「占位几何」必须设上限，否则 fontSize=32（scale≈2.29）时侧栏会吃掉 76% 视口，
// 8 个页面全部退化为每行 2 字。layoutScale 用于 app.wxss / app-sidebar.wxss 的宽度
// 自定义属性，绝不用于 font-size；font-size 仍只消费 --mhp-scale。
//
// 未来 D/F 波页面：在 data 里展开 A11Y_DATA、onShow 调 syncA11y(this)、根节点加
// 上面两段绑定即可复用，无需再各自读偏好。
//
// 数据层：只经 records.preferences（纯本地，无网络）；本模块不做任何 wx.* 调用。

import { FONT_SIZE_DEFAULT, records } from '../services/records';

/** 布局缩放上限：侧栏宽度只随 layoutScale 缩放，避免大字档把内容区挤没。
 *  750rpx 视口下侧栏展开基准 248rpx，248 × 上限 ≤ 300rpx 才能保证内容区 ≥60%：
 *  300 / 248 ≈ 1.2097，取 1.2。 */
const LAYOUT_SCALE_CAP = 1.2;

/** 页面无障碍状态；scale 为相对 FONT_SIZE_DEFAULT(=14) 的缩放系数。 */
export interface A11yState {
  /** 字号缩放系数：14 → 1，24 → 24/14，32 → 32/14。仅驱动 font-size。 */
  scale: number;
  /** 布局缩放系数：min(scale, LAYOUT_SCALE_CAP)。仅驱动宽度/占位自定义属性。 */
  layoutScale: number;
  /** 高对比开关：true 时页面根节点加 `is-hc` 类。 */
  highContrast: boolean;
}

/**
 * 页面 data 预设（与 app.wxss 的 `--mhp-scale: 1` / `--mhp-layout-scale: 1`
 * 默认值一致）。页面用 `...A11Y_DATA` 展开，首帧即为正常字号与正常侧栏宽。
 */
export const A11Y_DATA: A11yState = { scale: 1, layoutScale: 1, highContrast: false };

/** syncA11y 需要的最小页面契约（便于页面与 node harness 注入）。 */
export interface A11yPage {
  setData(data: A11yState): void;
}

/** 读取当前全局无障碍状态（AppPreferences.fontSize / highContrast）。 */
function readA11y(): A11yState {
  const prefs = records.preferences.get();
  const scale = prefs.fontSize / FONT_SIZE_DEFAULT;
  return {
    scale,
    layoutScale: Math.min(scale, LAYOUT_SCALE_CAP),
    highContrast: prefs.highContrast,
  };
}

/** 把当前无障碍状态写入页面 data；在每个页面的 onShow() 调用。 */
export function syncA11y(page: A11yPage): void {
  page.setData(readA11y());
}
