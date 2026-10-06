// server/authorities.ts
// 权威信源域名白名单（任务 24）。
//
// 契约：
//   - DEFAULT_AUTHORITY_DOMAINS：内置默认清单（卫健委 / 疾控 / 药监局 / 中华医学会 /
//     三甲医院官网示例 / MSD 诊疗手册）。均为「示例，可扩展」，可被 config 覆盖。
//   - resolveAuthorityDomains(configDomains)：域名覆盖语义——
//       config 非空（规整后仍 ≥1 个有效域名）→ 完全覆盖默认，只用 config 的清单；
//       config 为空 / 未提供 / 全为无效项 → 回退 DEFAULT_AUTHORITY_DOMAINS。
//     无论走哪条路径，返回值都经过小写化、去重、去首尾点、去 scheme/path/端口。
//   - isAuthorityUrl(urlOrHost, domains)：严格子域匹配，统一小写。仅当
//       host === d  或  host.endsWith('.' + d)  时命中。
//     因此 `evil-nhc.gov.cn` 与 `nhcgov.cn` 都不会命中 `nhc.gov.cn`。
//
// 本模块无副作用、无网络、无磁盘 I/O，可被 server/**.ts 安全导入。
// 约束：可擦除语法（无 enum/namespace/参数属性）；仅类型导入使用 `import type`（本文件无）。

/**
 * 默认权威域名清单（示例，可扩展 / 可被 config 覆盖）。
 *
 * - nhc.gov.cn      国家卫生健康委员会（卫健委）
 * - chinacdc.cn     中国疾病预防控制中心（疾控）
 * - nmpa.gov.cn     国家药品监督管理局（药监局）
 * - cma.org.cn      中华医学会
 * - pumch.cn        北京协和医院官网（示例：三甲）
 * - wchscu.cn       四川大学华西医院官网（示例：三甲）
 * - msdmanuals.cn   MSD 诊疗手册（默沙东诊疗手册中文版）
 *
 * 注：与 server/config.example.json 的 authorityDomains 保持一致；config 一旦填写
 * 非空清单即完全覆盖此默认值（见 resolveAuthorityDomains）。
 */
export const DEFAULT_AUTHORITY_DOMAINS: readonly string[] = [
  'nhc.gov.cn',
  'chinacdc.cn',
  'nmpa.gov.cn',
  'cma.org.cn',
  'pumch.cn',
  'wchscu.cn',
  'msdmanuals.cn',
];

/**
 * 把任意「域名 / 主机 / URL」规整为小写主机名。
 *
 * 支持的输入形态：
 *   - `nhc.gov.cn`
 *   - `WWW.NHC.GOV.CN`
 *   - `https://www.nhc.gov.cn/path?q=1`
 *   - `www.nhc.gov.cn:443`
 *
 * 无法规整（空串 / 纯空白 / 解析失败）时返回 null。
 */
export function normalizeDomain(input: string): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim().toLowerCase();
  if (trimmed === '') return null;

  let host = trimmed;
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//.exec(host);
  if (scheme !== null) host = host.slice(scheme[0].length);

  const at = host.indexOf('@'); // 去掉 URL 中的凭据段
  if (at >= 0) host = host.slice(at + 1);

  host = host.split('/')[0].split('?')[0].split('#')[0]; // 去 path / query / fragment
  host = host.replace(/:\d+$/, ''); // 去端口
  host = host.replace(/^\.+/, '').replace(/\.+$/, ''); // 去首尾点

  return host === '' ? null : host;
}

/**
 * 严格子域匹配：host === d 或 host 是 d 的子域（host.endsWith('.' + d)）。
 * 统一小写；非法输入（空 / 不可解析）不命中任何域名。
 *
 * 反例（必须不命中 `nhc.gov.cn`）：
 *   - `evil-nhc.gov.cn`（前缀不同，且不是 `.nhc.gov.cn` 结尾）
 *   - `nhcgov.cn`（缺少分隔点，长度不足）
 *
 * @param urlOrHost 完整 URL 或纯主机名/域名。
 * @param domains   权威域名清单（可为 config 覆盖后的结果）。
 */
export function isAuthorityUrl(urlOrHost: string, domains: readonly string[]): boolean {
  const host = normalizeDomain(urlOrHost);
  if (host === null) return false;
  for (const raw of domains) {
    const domain = normalizeDomain(raw);
    if (domain === null) continue;
    if (host === domain || host.endsWith(`.${domain}`)) return true;
  }
  return false;
}

/**
 * 判定一个条目是否为「可信的权威域名」（P1-42）：
 *   - 可被 normalizeDomain 规整（非空、非纯路径等）；
 *   - 至少 2 段（拒绝 `com` / `cn` 这类裸 TLD）；
 *   - 每段符合 `[a-z0-9]([a-z0-9-]*[a-z0-9])?`（拒绝空段 / 首尾连字符 / 非法字符）。
 *
 * 该函数不打印任何内容（authorities.ts 保持无副作用）；可见告警由 config.ts 负责。
 */
export function isPlausibleAuthorityDomain(input: string): boolean {
  const domain = normalizeDomain(input);
  if (domain === null) return false;
  const labels = domain.split('.');
  if (labels.length < 2) return false;
  return labels.every((label) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label));
}

/**
 * 解析生效的权威域名清单（去重、保持首次出现顺序）。
 *
 * - config 非空且规整后仍有 ≥1 个合法域名 → 覆盖默认；
 * - config 为空 / undefined / 全部非法（含裸 TLD）→ 回退 DEFAULT_AUTHORITY_DOMAINS。
 */
export function resolveAuthorityDomains(
  configDomains: readonly string[] | null | undefined
): string[] {
  const cleaned: string[] = [];
  const seen = new Set<string>();
  if (Array.isArray(configDomains)) {
    for (const raw of configDomains) {
      if (typeof raw !== 'string' || !isPlausibleAuthorityDomain(raw)) continue;
      const domain = normalizeDomain(raw);
      if (domain === null || seen.has(domain)) continue;
      seen.add(domain);
      cleaned.push(domain);
    }
  }
  return cleaned.length > 0 ? cleaned : [...DEFAULT_AUTHORITY_DOMAINS];
}
