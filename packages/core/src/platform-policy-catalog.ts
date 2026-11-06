import type { PlatformPolicyCatalog, PlatformSitePolicy } from './types.js';

export const LEGACY_PLATFORM_POLICY_CATALOG_VERSION = '2026-11-04.1';
export const CURRENT_PLATFORM_POLICY_CATALOG_VERSION = '2026-11-06.1';

function site(
  id: string, platformTag: string, label: string, url: string,
  countryCodes: string[], languages: string[], timezone: string,
): PlatformSitePolicy {
  return { id, platformTag, label, url, countryCodes, languages, timezone };
}

// 历史快照只允许整体保留并追加新快照，不能就地修改其中的任何字段。
const LEGACY_POLICIES: PlatformPolicyCatalog['policies'] = [
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

const CATALOGS: PlatformPolicyCatalog[] = [
  { version: LEGACY_PLATFORM_POLICY_CATALOG_VERSION, policies: LEGACY_POLICIES },
  {
    version: CURRENT_PLATFORM_POLICY_CATALOG_VERSION,
    policies: LEGACY_POLICIES.map((policy) => ({
      ...policy,
      sites: [...policy.sites],
    })),
  },
];

CATALOGS[1]!.policies.find((policy) => policy.tag === 'amazon')!.sites.push(
  site('amazon-ca', 'amazon', '加拿大站', 'https://www.amazon.ca/', ['CA'],
    ['en-CA', 'en', 'fr-CA', 'fr'], 'America/Toronto'),
);
CATALOGS[1]!.policies.find((policy) => policy.tag === 'shopee')!.sites.push(
  site('shopee-tw', 'shopee', '台湾站', 'https://shopee.tw/', ['TW'], ['zh-TW', 'zh'], 'Asia/Taipei'),
);
CATALOGS[1]!.policies.find((policy) => policy.tag === 'tiktok')!.sites.push(
  site('tiktok-jp', 'tiktok', '日本区', 'https://www.tiktok.com/?region=JP', ['JP'],
    ['ja-JP', 'ja'], 'Asia/Tokyo'),
);

function cloneCatalog(catalog: PlatformPolicyCatalog): PlatformPolicyCatalog {
  return {
    version: catalog.version,
    policies: catalog.policies.map((policy) => ({
      ...policy,
      sites: policy.sites.map((item) => ({
        ...item,
        countryCodes: [...item.countryCodes],
        languages: [...item.languages],
      })),
    })),
  };
}

export function listBuiltinPlatformPolicyCatalogs(): PlatformPolicyCatalog[] {
  return CATALOGS.map(cloneCatalog);
}

export function getBuiltinPlatformPolicyCatalog(version: string): PlatformPolicyCatalog | undefined {
  const catalog = CATALOGS.find((item) => item.version === version);
  return catalog ? cloneCatalog(catalog) : undefined;
}
