// shared/ui/sidebar.ts — 全局左侧导航栏状态（展开 / 收起）。
//
// 与 shared/ui/a11y.ts 同构的单一机制：8 个页面在 onShow() 调用 syncSidebar(this)，
// 把 AppPreferences.sidebarCollapsed 写进本页 data；页面根节点据此加 `is-collapsed`
// 类，页面内容经 app.wxss 的 `.app-body { margin-left: var(--mhp-sidebar-w) }` 为侧栏让位。
// 切换时页面调用 setSidebarCollapsed(next) 落盘并回写 data。
//
// 数据层：只经 records.preferences（纯本地，无网络）；本模块不做任何 wx.* 调用。

import { records } from '../services/records';

/** 侧栏状态；collapsed=true 表示收起为纯图标栏。 */
export interface SidebarState {
  sidebarCollapsed: boolean;
}

/** 页面 data 预设（默认展开）。 */
export const SIDEBAR_DATA: SidebarState = { sidebarCollapsed: false };

/** syncSidebar 需要的最小页面契约（便于页面与 node harness 注入）。 */
export interface SidebarPage {
  setData(data: SidebarState): void;
}

/** 读取当前侧栏状态（AppPreferences.sidebarCollapsed）。 */
function readSidebar(): SidebarState {
  return { sidebarCollapsed: records.preferences.get().sidebarCollapsed };
}

/** 把当前侧栏状态写入页面 data；在每个页面的 onShow() 调用。 */
export function syncSidebar(page: SidebarPage): void {
  page.setData(readSidebar());
}

/** 收起/展开：落盘偏好并返回新状态，供页面 setData。 */
export function setSidebarCollapsed(collapsed: boolean): SidebarState {
  const prefs = records.preferences.update({ sidebarCollapsed: collapsed });
  return { sidebarCollapsed: prefs.sidebarCollapsed };
}
