// shared/ui/theme.ts — JS 侧的强调色镜像（任务 41）。
//
// 设计令牌的唯一来源是 hospital-ai-miniapp/styles/tokens.wxss。但原生宿主 API
// （如 slider 的 activeColor）无法读取 CSS 自定义属性，只能接收字面色值，因此在 JS 侧
// 保留这一处镜像作为唯一来源，避免色值散落在页面里。
//
// 保持与 styles/tokens.wxss 同步：
//   ACCENT    <- --color-primary  (#0C7568)
//   ACCENT_HC <- --mhp-hc-accent  (#FFD400)
export const ACCENT = '#0C7568';
export const ACCENT_HC = '#FFD400';
