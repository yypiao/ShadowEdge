import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CURRENT_PLATFORM_POLICY_CATALOG_VERSION,
  getBuiltinPlatformPolicyCatalog,
  LEGACY_PLATFORM_POLICY_CATALOG_VERSION,
  listBuiltinPlatformPolicyCatalogs,
} from '../src/platform-policy-catalog.js';

function digest(version: string): string {
  return createHash('sha256').update(JSON.stringify(getBuiltinPlatformPolicyCatalog(version))).digest('hex');
}

describe('平台策略目录快照', () => {
  it('历史快照保持 9 个站点，当前快照只在原策略后追加 3 个站点', () => {
    const [legacy, current] = listBuiltinPlatformPolicyCatalogs();
    expect(legacy?.version).toBe(LEGACY_PLATFORM_POLICY_CATALOG_VERSION);
    expect(current?.version).toBe(CURRENT_PLATFORM_POLICY_CATALOG_VERSION);
    expect(legacy?.policies.flatMap((policy) => policy.sites)).toHaveLength(9);
    expect(current?.policies.flatMap((policy) => policy.sites)).toHaveLength(12);
    for (const legacyPolicy of legacy!.policies) {
      const currentPolicy = current!.policies.find((policy) => policy.tag === legacyPolicy.tag);
      expect(currentPolicy?.sites.slice(0, legacyPolicy.sites.length)).toEqual(legacyPolicy.sites);
    }
    const legacyIds = new Set(legacy!.policies.flatMap((policy) => policy.sites).map((site) => site.id));
    const added = current!.policies.flatMap((policy) => policy.sites)
      .filter((site) => !legacyIds.has(site.id)).map((site) => site.id);
    expect(added).toEqual(['amazon-ca', 'shopee-tw', 'tiktok-jp']);
  });

  it('完整 JSON 哈希固定，防止就地改写历史策略', () => {
    expect(digest(LEGACY_PLATFORM_POLICY_CATALOG_VERSION)).toBe('93cef39ca7425065f5869b1e3ae273906d62a0b17664b2eb03c10e95f2315b34');
    expect(digest(CURRENT_PLATFORM_POLICY_CATALOG_VERSION)).toBe('7cbd9a4d1cbdf29281d2aa2edda8b08d5a15d948d509fa2df1b01b3c8b4722c7');
  });

  it('每次返回防御性副本，未知版本不回退到当前目录', () => {
    const current = getBuiltinPlatformPolicyCatalog(CURRENT_PLATFORM_POLICY_CATALOG_VERSION)!;
    current.policies[0]!.sites[0]!.countryCodes.push('DE');
    current.policies[0]!.sites[0]!.url = 'https://example.com/';
    const restored = getBuiltinPlatformPolicyCatalog(CURRENT_PLATFORM_POLICY_CATALOG_VERSION);
    expect(restored?.policies[0]?.sites[0]).toMatchObject({
      url: 'https://www.amazon.com/', countryCodes: ['US'],
    });
    expect(getBuiltinPlatformPolicyCatalog('2099-01-01.1')).toBeUndefined();
  });
});
