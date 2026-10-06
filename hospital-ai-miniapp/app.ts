// app.ts — 应用入口（迁移自旧 app.js）。
//
// 职责：注册全局启动钩子、平台隐私授权监听与全局错误兜底，并在首启（或隐私说明版本过旧）
// 时展示隐私说明。隐私说明正文来自 config/texts.ts 的 PRIVACY 分组，其中明确「外部 AI
// 调用默认关闭、启用需同意」；用户同意后把说明版本写入 AppPreferences.consentVersion
// （shared/services/records）。旧键 privacy_agreed 已废弃，不再读写。

import { PRIVACY } from './config/texts';
import { preferences } from './shared/services/records';
import { ACCENT } from './shared/ui/theme';

/** 当前隐私说明版本；上调此值会让用户在下次启动时重新确认一次。 */
export const PRIVACY_NOTICE_VERSION = 1;

/** 将集中维护的隐私文案组装为弹窗正文。 */
function buildPrivacyNotice(): string {
  return [
    PRIVACY.localFirst,
    PRIVACY.externalAiOffByDefault,
    PRIVACY.externalAiConsent,
    PRIVACY.localDataControl,
  ].join('\n\n');
}

// ===== 平台隐私授权（P1-26 / A02-01 / A06-01） =====
//
// 官方链路：宿主在调用隐私接口（chooseMedia / saveImageToPhotosAlbum 等）且用户尚未同意
// 时触发 wx.onNeedPrivacyAuthorization；开发者弹出自定义弹窗，用户轻触
// <button open-type="agreePrivacyAuthorization"> 后调用 resolve 告知平台。
// app.ts 只做「注册监听 + 安全兜底」；同意按钮与弹窗属于页面（设置页由 CLIENT-DATA 接入），
// 通过 setPrivacyAuthResolver 注册解析器挂到本监听上。

/** 官方 resolve 的入参（event=agree 时 buttonId 须指向被点击的同意按钮）。 */
export interface PrivacyAuthResolution {
  event: 'agree' | 'disagree';
  buttonId?: string;
}

/** 隐私授权解析器：拿到 resolve 后由 UI 决定同意/拒绝。 */
export type PrivacyAuthResolver = (resolve: (result: PrivacyAuthResolution) => void) => void;

let privacyAuthResolver: PrivacyAuthResolver | null = null;

/** 注册 / 清除隐私授权解析器（供设置页接入；传 null 清除）。 */
export function setPrivacyAuthResolver(resolver: PrivacyAuthResolver | null): void {
  privacyAuthResolver = resolver;
}

/** 宿主 onNeedPrivacyAuthorization 的官方签名（miniprogram-api-typings@5.2.3 把首个
 *  回调参数误标为 GeneralCallbackResult，这里按官方文档声明可调用的 resolve）。 */
type HostPrivacyListener = (
  resolve: (result: PrivacyAuthResolution) => void,
  eventInfo: { referrer: string }
) => void;

/** 设置页路由（其隐私授权入口是 P1-26 的页面侧落点）。 */
const SETTINGS_ROUTE = 'pages/settings/settings';

/** 当前栈顶页面路由；基础库/时序异常时返回空串，绝不抛错。 */
function currentRoute(): string {
  if (typeof getCurrentPages !== 'function') return '';
  try {
    const pages = getCurrentPages();
    if (!Array.isArray(pages) || pages.length === 0) return '';
    const top = pages[pages.length - 1];
    return typeof top.route === 'string' ? top.route : '';
  } catch (e) {
    logShellDiagnostic('privacyRoute', String(e));
    return '';
  }
}

/**
 * 无解析器时把用户引导到设置页的隐私授权入口。仅在栈顶不是设置页、且宿主支持相应
 * 能力时执行；任何缺失/失败都静默降级，绝不代替用户同意。
 */
function guideToSettingsPrivacy(): void {
  if (currentRoute() === SETTINGS_ROUTE) return;
  const go = (): void => {
    if (typeof wx.navigateTo !== 'function') return;
    try {
      wx.navigateTo({ url: `/${SETTINGS_ROUTE}` });
    } catch (e) {
      logShellDiagnostic('privacyGuide', String(e));
    }
  };
  if (typeof wx.showModal !== 'function') {
    go();
    return;
  }
  try {
    wx.showModal({
      title: '需要隐私授权',
      content: '请到「设置」页的隐私授权入口完成同意后，再重试本次操作。',
      confirmText: '去设置',
      cancelText: '暂不',
      success: (res) => {
        if (res.confirm) go();
      },
      fail: () => go(),
    });
  } catch (e) {
    logShellDiagnostic('privacyGuide', String(e));
    go();
  }
}

/** 仅当宿主提供官方隐私监听时注册；旧基础库缺失该 API 时静默跳过，不崩溃。 */
function registerPrivacyAuthorization(): void {
  const host = wx as unknown as {
    onNeedPrivacyAuthorization?: (listener: HostPrivacyListener) => void;
  };
  if (typeof host.onNeedPrivacyAuthorization !== 'function') return;
  host.onNeedPrivacyAuthorization((resolve) => {
    // exactly-once：无论解析器如何调用（或抛错），本次请求最多 resolve 一次。
    let settled = false;
    const settle = (result: PrivacyAuthResolution): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    if (privacyAuthResolver !== null) {
      try {
        privacyAuthResolver(settle);
      } catch (e) {
        logShellDiagnostic('privacyResolver', String(e));
        settle({ event: 'disagree' });
      }
      return;
    }
    // 无解析器（设置页不可用）：绝不代替用户同意；先尽力把用户引导到设置页授权入口，
    // 再按拒绝解析本次请求，使其收到明确的未授权失败而非永久 pending。
    guideToSettingsPrivacy();
    settle({ event: 'disagree' });
  });
}

/** 退出小程序；宿主未提供该接口时静默返回。 */
function exitMiniProgramIfAvailable(): void {
  if (typeof wx.exitMiniProgram === 'function') {
    wx.exitMiniProgram({});
  }
}

/** 全局兜底诊断：只记录阶段与错误文本（截断），绝不读取 / 输出任何医疗内容。 */
function logShellDiagnostic(stage: string, detail: string): void {
  const text = detail.length > 500 ? detail.slice(0, 500) + '…' : detail;
  console.error(`[mhp] ${stage}: ${text}`);
}

App({
  onLaunch() {
    registerPrivacyAuthorization();
    this.checkPrivacyAuth();
  },

  /** 全局 JS 异常：记录可诊断的栈信息（不落盘、不外发、不含医疗内容）。 */
  onError(error) {
    logShellDiagnostic('onError', error);
  },

  /** 未处理的 Promise 拒绝：同上，让静默总失败变为可诊断。 */
  onUnhandledRejection(res) {
    logShellDiagnostic('onUnhandledRejection', String(res.reason));
  },

  /** 首启隐私说明：仅当本地同意版本缺失或低于当前版本时处理。 */
  checkPrivacyAuth() {
    const consentVersion = preferences.get().consentVersion;
    if (consentVersion !== null && consentVersion >= PRIVACY_NOTICE_VERSION) {
      return;
    }

    // 官方隐私 API（基础库 2.32.3+）优先；旧版或调用失败时降级为 Modal。
    if (typeof wx.getPrivacySetting === 'function') {
      wx.getPrivacySetting({
        success: (res) => {
          if (res.needAuthorization) {
            this.showPrivacyModal();
          }
        },
        fail: () => {
          this.showPrivacyModal();
        },
      });
    } else {
      this.showPrivacyModal();
    }
  },

  /** 展示隐私说明：同意后写入版本号，拒绝则退出小程序。 */
  showPrivacyModal() {
    wx.showModal({
      title: '隐私保护提示',
      content: buildPrivacyNotice(),
      confirmText: '我同意',
      cancelText: '退出',
      confirmColor: ACCENT,
      success: (res) => {
        if (res.confirm) {
          preferences.update({ consentVersion: PRIVACY_NOTICE_VERSION });
        } else {
          exitMiniProgramIfAvailable();
        }
      },
    });
  },
});
