import type { BrowserProfile, PlatformPolicy, PlatformSitePolicy, ProxyHealth } from '@shadowedge/core';
import { ShadowEdgeError } from '@shadowedge/core';

const POLICIES: PlatformPolicy[] = [
  {
    tag: 'amazon', label: 'Amazon',
    sites: [
      site('amazon-us', 'amazon', '美国站', 'https://www.amazon.com/', ['US'], ['en-US', 'en'], 'America/New_York'),
      site('amazon-uk', 'amazon', '英国站', 'https://www.amazon.co.uk/', ['GB'], ['en-GB', 'en'], 'Europe/London'),
      site('amazon-de', 'amazon', '德国站', 'https://www.amazon.de/', ['DE'], ['de-DE', 'de'], 'Europe/Berlin'),
      site('amazon-jp', 'amazon', '日本站', 'https://www.amazon.co.jp/', ['JP'], ['ja-JP', 'ja'], 'Asia/Tokyo'),
    ],
  },
  {
    tag: 'shopee', label: 'Shopee',
    sites: [
      site('shopee-sg', 'shopee', '新加坡站', 'https://shopee.sg/', ['SG'], ['en-SG', 'en'], 'Asia/Singapore'),
      site('shopee-my', 'shopee', '马来西亚站', 'https://shopee.com.my/', ['MY'], ['ms-MY', 'ms', 'en'], 'Asia/Kuala_Lumpur'),
      site('shopee-ph', 'shopee', '菲律宾站', 'https://shopee.ph/', ['PH'], ['en-PH', 'en'], 'Asia/Manila'),
    ],
  },
  {
    tag: 'tiktok', label: 'TikTok',
    sites: [
      site('tiktok-us', 'tiktok', '美国区', 'https://www.tiktok.com/', ['US'], ['en-US', 'en'], 'America/New_York'),
      site('tiktok-uk', 'tiktok', '英国区', 'https://www.tiktok.com/?region=GB', ['GB'], ['en-GB', 'en'], 'Europe/London'),
    ],
  },
];

function site(
  id: string, platformTag: string, label: string, url: string,
  countryCodes: string[], languages: string[], timezone: string,
): PlatformSitePolicy {
  return { id, platformTag, label, url, countryCodes, languages, timezone };
}

export function listPlatformPolicies(): PlatformPolicy[] {
  return POLICIES.map((policy) => ({
    ...policy,
    sites: policy.sites.map((item) => ({ ...item, countryCodes: [...item.countryCodes], languages: [...item.languages] })),
  }));
}

export function findPlatformSite(siteId: string): PlatformSitePolicy {
  const found = POLICIES.flatMap((policy) => policy.sites).find((item) => item.id === siteId);
  if (!found) throw new ShadowEdgeError('E_PROFILE_INVALID', `未知平台站点 ${siteId}`);
  return found;
}

export function siteForProfile(profile: BrowserProfile): PlatformSitePolicy | undefined {
  if (profile.platformSiteId) {
    const selected = findPlatformSite(profile.platformSiteId);
    if (selected.platformTag !== profile.platformTag) {
      throw new ShadowEdgeError('E_PROFILE_INVALID', '环境平台与已选站点不一致');
    }
    return selected;
  }
  if (!profile.platformTag) return undefined;
  // 兼容 T35 之前的环境：仅在启动页仍精确匹配时恢复站点身份。
  return POLICIES.find((policy) => policy.tag === profile.platformTag)?.sites.find((item) =>
    profile.startupUrls.includes(item.url));
}

/** 平台区域是额外的业务一致性约束，不替代原有指纹时区检查。 */
export function checkPlatformRegion(profile: BrowserProfile, health: ProxyHealth): void {
  const selected = siteForProfile(profile);
  if (!selected) return;
  const actual = health.geo?.countryCode?.toUpperCase();
  if (!actual) {
    throw new ShadowEdgeError(
      'E_PROXY_GEO_MISMATCH',
      `${selected.label}需要明确的代理出口国家/地区，当前探测结果缺少 countryCode`,
      { details: { siteId: selected.id, expectedCountryCodes: selected.countryCodes } },
    );
  }
  if (!selected.countryCodes.includes(actual)) {
    throw new ShadowEdgeError(
      'E_PROXY_GEO_MISMATCH',
      `代理出口国家/地区（${actual}）与${selected.label}要求（${selected.countryCodes.join('/')}）不一致`,
      { details: { siteId: selected.id, expectedCountryCodes: selected.countryCodes, actualCountryCode: actual } },
    );
  }
}
