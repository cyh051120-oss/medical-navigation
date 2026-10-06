// app.ts — 应用入口（迁移自旧 app.js）。
//
// 职责：注册全局启动钩子，并在首启（或隐私说明版本过旧）时展示隐私说明。
// 隐私说明正文来自 config/texts.ts 的 PRIVACY 分组，其中明确「外部 AI 调用默认
// 关闭、启用需同意」；用户同意后把说明版本写入 AppPreferences.consentVersion
// （shared/services/records）。旧键 privacy_agreed 已废弃，不再读写。

import { PRIVACY } from './config/texts';
import { preferences } from './shared/services/records';

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

/** 部分基础库提供的官方同意回调（不在当前类型声明内，按可选能力探测）。 */
type OptionalAgreePrivacyAuthorization = (() => void) | undefined;

/** 若宿主提供官方同意接口则调用之；缺失时静默跳过，不影响本地同意记录。 */
function agreePrivacyAuthorizationIfAvailable(): void {
  const host = wx as unknown as {
    agreePrivacyAuthorization?: OptionalAgreePrivacyAuthorization;
  };
  if (typeof host.agreePrivacyAuthorization === 'function') {
    host.agreePrivacyAuthorization();
  }
}

/** 退出小程序；宿主未提供该接口时静默返回。 */
function exitMiniProgramIfAvailable(): void {
  if (typeof wx.exitMiniProgram === 'function') {
    wx.exitMiniProgram({});
  }
}

App({
  onLaunch() {
    this.checkPrivacyAuth();
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
      confirmColor: '#2A4FD7',
      success: (res) => {
        if (res.confirm) {
          preferences.update({ consentVersion: PRIVACY_NOTICE_VERSION });
          agreePrivacyAuthorizationIfAvailable();
        } else {
          exitMiniProgramIfAvailable();
        }
      },
    });
  },
});
