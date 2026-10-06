// shared/ui/a11y.ts — 全局无障碍状态（任务 16）：字号缩放 + 高对比。
//
// 单一机制：8 个页面在 onShow() 调用 syncA11y(this)，把 AppPreferences.fontSize /
// highContrast 写进本页 data；页面根节点再用
//   style="--mhp-scale: {{scale}}"  class="... {{highContrast ? 'is-hc' : ''}}"
// 消费。字号缩放因此由 app.wxss 的 `--mhp-scale` 变量统一驱动，各页字号一律写成
// `calc(Nrpx * var(--mhp-scale))`，不写死 px；高对比由 app.wxss 的全局 `.is-hc`
// 变量映射统一接管（settings 页保留其等价作用域块以兼容既有契约）。
//
// 未来 D/F 波页面：在 data 里展开 A11Y_DATA、onShow 调 syncA11y(this)、根节点加
// 上面两段绑定即可复用，无需再各自读偏好。
//
// 数据层：只经 records.preferences（纯本地，无网络）；本模块不做任何 wx.* 调用。

import { FONT_SIZE_DEFAULT, records } from '../services/records';

/** 页面无障碍状态；scale 为相对 FONT_SIZE_DEFAULT(=14) 的缩放系数。 */
export interface A11yState {
  /** 字号缩放系数：14 → 1，24 → 24/14，32 → 32/14。 */
  scale: number;
  /** 高对比开关：true 时页面根节点加 `is-hc` 类。 */
  highContrast: boolean;
}

/**
 * 页面 data 预设（与 app.wxss 的 `--mhp-scale: 1` 默认值一致）。
 * 页面用 `...A11Y_DATA` 展开，首帧即为正常字号。
 */
export const A11Y_DATA: A11yState = { scale: 1, highContrast: false };

/** syncA11y 需要的最小页面契约（便于页面与 node harness 注入）。 */
export interface A11yPage {
  setData(data: A11yState): void;
}

/** 读取当前全局无障碍状态（AppPreferences.fontSize / highContrast）。 */
export function readA11y(): A11yState {
  const prefs = records.preferences.get();
  return {
    scale: prefs.fontSize / FONT_SIZE_DEFAULT,
    highContrast: prefs.highContrast,
  };
}

/** 把当前无障碍状态写入页面 data；在每个页面的 onShow() 调用。 */
export function syncA11y(page: A11yPage): void {
  page.setData(readA11y());
}
