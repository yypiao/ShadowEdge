import type {
  BrowserProfile,
  PlatformPolicyCatalog,
  PlatformSitePolicy,
  ProxyHealth,
} from '@shadowedge/core';
import {
  CURRENT_PLATFORM_POLICY_CATALOG_VERSION,
  getBuiltinPlatformPolicyCatalog,
  ShadowEdgeError,
} from '@shadowedge/core';

export function getPlatformPolicyCatalog(version = CURRENT_PLATFORM_POLICY_CATALOG_VERSION): PlatformPolicyCatalog {
  const catalog = getBuiltinPlatformPolicyCatalog(version);
  if (!catalog) throw new ShadowEdgeError('E_PROFILE_INVALID', `未知平台策略目录版本 ${version}`);
  return catalog;
}

export function listPlatformPolicyCatalog(): PlatformPolicyCatalog {
  return getPlatformPolicyCatalog();
}

export function findPlatformSite(
  siteId: string,
  catalogVersion = CURRENT_PLATFORM_POLICY_CATALOG_VERSION,
): PlatformSitePolicy {
  const found = getPlatformPolicyCatalog(catalogVersion).policies
    .flatMap((policy) => policy.sites).find((item) => item.id === siteId);
  if (!found) {
    throw new ShadowEdgeError('E_PROFILE_INVALID', `未知平台站点 ${siteId}`, {
      details: { catalogVersion },
    });
  }
  return found;
}

export function siteForProfile(profile: BrowserProfile): PlatformSitePolicy | undefined {
  const catalogVersion = profile.platformPolicyVersion ?? CURRENT_PLATFORM_POLICY_CATALOG_VERSION;
  const catalog = getPlatformPolicyCatalog(catalogVersion);
  if (profile.platformSiteId) {
    const selected = findPlatformSite(profile.platformSiteId, catalogVersion);
    if (selected.platformTag !== profile.platformTag) {
      throw new ShadowEdgeError('E_PROFILE_INVALID', '环境平台与已选站点不一致');
    }
    return selected;
  }
  if (!profile.platformTag) return undefined;
  // 兼容 T35 之前的环境：仅在启动页仍精确匹配时恢复站点身份。
  return catalog.policies.find((policy) => policy.tag === profile.platformTag)?.sites.find((item) =>
    profile.startupUrls.includes(item.url));
}

/** 平台区域是额外的业务一致性约束，不替代原有指纹时区检查。 */
export function checkPlatformRegion(profile: BrowserProfile, health: ProxyHealth): void {
  const selected = siteForProfile(profile);
  if (!selected) return;
  const catalogVersion = profile.platformPolicyVersion ?? CURRENT_PLATFORM_POLICY_CATALOG_VERSION;
  const actual = health.geo?.countryCode?.toUpperCase();
  if (!actual) {
    throw new ShadowEdgeError(
      'E_PROXY_GEO_MISMATCH',
      `${selected.label}需要明确的代理出口国家/地区，当前探测结果缺少 countryCode`,
      { details: { siteId: selected.id, catalogVersion, expectedCountryCodes: selected.countryCodes } },
    );
  }
  if (!selected.countryCodes.includes(actual)) {
    throw new ShadowEdgeError(
      'E_PROXY_GEO_MISMATCH',
      `代理出口国家/地区（${actual}）与${selected.label}要求（${selected.countryCodes.join('/')}）不一致`,
      { details: { siteId: selected.id, catalogVersion, expectedCountryCodes: selected.countryCodes, actualCountryCode: actual } },
    );
  }
}
