import { describe, expect, it } from 'vitest';
import type { BrowserProfile, ProxyHealth } from '@shadowedge/core';
import { generateFingerprint } from '@shadowedge/fingerprint';
import { checkPlatformRegion, findPlatformSite, listPlatformPolicies } from '../src/main/services/platform-policies.js';
import { runLaunchGate } from '../src/main/services/launch-gate.js';

function profile(): BrowserProfile {
  const now = new Date().toISOString();
  return {
    id: 'platform-profile', orgId: 'local', name: 'Amazon 美国站', kernel: 'chromium-cdp',
    fingerprint: generateFingerprint({ seed: 'platform-policy', platform: 'host' }),
    platformTag: 'amazon', platformSiteId: 'amazon-us', proxyId: 'proxy-us', ownerId: 'local-user', sharedWith: [],
    storage: { userDataDir: 'profiles/platform-profile', remoteRevision: 0, syncMode: 'local-only' },
    startupUrls: ['https://www.amazon.com/'], status: 'idle', createdAt: now, updatedAt: now,
  };
}

function health(countryCode?: string): ProxyHealth {
  return {
    proxyId: 'proxy-us', checkedAt: new Date().toISOString(), reachable: true, latencyMs: 10,
    geo: { country: countryCode ?? 'Unknown', countryCode, timezone: profile().fingerprint.timezone },
  };
}

describe('平台站点策略', () => {
  it('内置 Amazon、Shopee、TikTok 站点且返回防御性副本', () => {
    const policies = listPlatformPolicies();
    expect(policies.map((policy) => policy.tag)).toEqual(['amazon', 'shopee', 'tiktok']);
    expect(findPlatformSite('amazon-us')).toMatchObject({
      countryCodes: ['US'], languages: ['en-US', 'en'], timezone: 'America/New_York',
    });
    policies[0]!.sites[0]!.countryCodes.push('DE');
    expect(findPlatformSite('amazon-us').countryCodes).toEqual(['US']);
  });

  it('站点要求与出口国家一致时放行，德国出口或缺失国家均拒绝', async () => {
    const current = profile();
    // 启动页允许附加自定义页面，站点身份不能依赖 URL 猜测。
    current.startupUrls = ['https://example.com/'];
    const aligned = health('US');
    aligned.geo!.timezone = current.fingerprint.timezone;
    expect(() => checkPlatformRegion(current, aligned)).not.toThrow();
    await expect(runLaunchGate({ profile: current }, { checkProxy: async () => aligned })).resolves.toBeUndefined();

    const wrong = health('DE');
    wrong.geo!.timezone = current.fingerprint.timezone;
    expect(() => checkPlatformRegion(current, wrong)).toThrowError(expect.objectContaining({
      code: 'E_PROXY_GEO_MISMATCH',
      details: expect.objectContaining({ siteId: 'amazon-us', actualCountryCode: 'DE' }),
    }));
    expect(() => checkPlatformRegion(current, health())).toThrowError(expect.objectContaining({
      code: 'E_PROXY_GEO_MISMATCH',
    }));
  });
});
