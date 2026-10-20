// shared/ui/nav.ts — 正式 section 路由及工作台导航关系的唯一数据源。
//
// NAV_ITEMS 继续承载全部 8 个 section 的路由及兼容侧栏：工作台 / 个人档案 / 症状记录 / 资料摘录 / 待问清单 /
// 就医摘要 / AI 助手 / 设置。PRIMARY_TABS 则定义手机工作台五个一级入口，避免其与路由
// 映射各写一份而漂移。
//
// icon 名称对应 styles/icons.wxss 的 `.mhp-ico--<icon>`（Lucide 矢量图标）。
// route 为不带前导斜杠的相对路径；跳转时统一补 `/`。
// title 为该页导航栏标题的唯一来源：workspace 单页宿主切换 section 时用它设置
// 系统导航栏标题，取值必须与对应 pages/<name>/<name>.json 的 navigationBarTitleText 一致。

/** 一个左侧栏导航项。 */
export interface NavItem {
  /** 稳定标识；页面用同名 key 传给侧栏以高亮当前项。 */
  key: string;
  /** 中文标签。 */
  label: string;
  /** 图标名，对应 `.mhp-ico--<icon>`。 */
  icon: string;
  /** 相对路由，不带前导斜杠。 */
  route: string;
  /** 导航栏标题；与本页 json 的 navigationBarTitleText 保持一致。 */
  title: string;
}

/** 8 个页面的固定顺序（工作台在最前）。 */
export const NAV_ITEMS: readonly NavItem[] = [
  { key: 'home', label: '工作台', icon: 'house', route: 'pages/home/home', title: '工作台' },
  { key: 'profile', label: '个人档案', icon: 'user', route: 'pages/profile/profile', title: '个人档案' },
  {
    key: 'symptoms',
    label: '症状记录',
    icon: 'stethoscope',
    route: 'pages/symptoms/symptoms',
    title: '症状时间线',
  },
  { key: 'notes', label: '资料摘录', icon: 'file-text', route: 'pages/notes/notes', title: '资料摘录' },
  {
    key: 'questions',
    label: '待问清单',
    icon: 'message-circle-question',
    route: 'pages/questions/questions',
    title: '待问清单',
  },
  { key: 'brief', label: '就医摘要', icon: 'clipboard-list', route: 'pages/brief/brief', title: '就医摘要' },
  { key: 'ai', label: 'AI 助手', icon: 'wand-sparkles', route: 'pages/ai/ai', title: 'AI 助手' },
  { key: 'settings', label: '设置', icon: 'settings', route: 'pages/settings/settings', title: '设置' },
] as const;

/** 手机工作台的五个一级入口。原 NAV_ITEMS 继续负责八个正式 section 与兼容路由。 */
export const PRIMARY_TABS = [
  { key: 'home', label: '首页', icon: 'house', section: 'home' },
  { key: 'records', label: '记录', icon: 'file-text', section: 'symptoms' },
  { key: 'brief', label: '摘要', icon: 'clipboard-list', section: 'brief' },
  { key: 'ai', label: 'AI', icon: 'wand-sparkles', section: 'ai' },
  { key: 'mine', label: '我的', icon: 'user', section: 'profile' },
] as const;

/** 次级入口只聚合已有 section，不产生额外业务状态或路由。 */
export const RECORD_SECTIONS = [
  { key: 'symptoms', label: '症状' },
  { key: 'notes', label: '资料' },
  { key: 'questions', label: '待问' },
] as const;

export const MINE_SECTIONS = [
  { key: 'profile', label: '个人档案' },
  { key: 'settings', label: '设置' },
] as const;

export type PrimaryTabKey = (typeof PRIMARY_TABS)[number]['key'];

/** 一级高亮始终从正式 section 推导，避免导航与内容选中态各自维护权威。 */
export function primaryTabForSection(section: string): PrimaryTabKey {
  if (RECORD_SECTIONS.some((item) => item.key === section)) return 'records';
  if (MINE_SECTIONS.some((item) => item.key === section)) return 'mine';
  if (section === 'brief') return 'brief';
  if (section === 'ai') return 'ai';
  return 'home';
}
