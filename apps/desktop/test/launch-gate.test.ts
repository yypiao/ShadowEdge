import { describe, expect, it } from 'vitest';
import type { BrowserProfile, ProxyHealth } from '@shadowedge/core';
import { generateFingerprint } from '@shadowedge/fingerprint';
import { runLaunchGate } from '../src/main/services/launch-gate.js';

function makeProfile(timezone?: string): BrowserProfile {
  const now = new Date().toISOString();
  const fingerprint = generateFingerprint({ seed: 'gate-test' });
  if (timezone) fingerprint.timezone = timezone;
  return {
    id: 'p1', orgId: 'local', name: 'gate-env', kernel: 'chromium-patched',
    fingerprint, proxyId: 'px1', ownerId: 'local-user', sharedWith: [],
    storage: { userDataDir: 'profiles/p1', remoteRevision: 0, syncMode: 'auto' },
    startupUrls: [], status: 'idle', createdAt: now, updatedAt: now,
  };
}

const healthyCn: ProxyHealth = {
  proxyId: 'px1', checkedAt: new Date().toISOString(), reachable: true, latencyMs: 100,
  exitIp: '42.202.173.92', geo: { country: 'China', timezone: 'Asia/Shanghai' },
};

describe('启动前闸门（T4）', () => {
  it('指纹一致 + 代理可达 + 地理对齐 → 放行', async () => {
    const profile = makeProfile();
    await expect(
      runLaunchGate(
        { profile },
        { checkProxy: async () => ({ ...healthyCn, geo: { country: 'US', timezone: profile.fingerprint.timezone } }) },
      ),
    ).resolves.toBeUndefined();
  });

  it('代理不可达 → E_PROXY_UNREACHABLE', async () => {
    await expect(
      runLaunchGate({ profile: makeProfile() }, {
        checkProxy: async () => {
          throw new Error('全部端点失败');
        },
      }),
    ).rejects.toMatchObject({ code: 'E_PROXY_UNREACHABLE' });
  });

  it('出口时区与指纹时区矛盾 → E_PROXY_GEO_MISMATCH（含修正建议）', async () => {
    const profile = makeProfile('America/Los_Angeles');
    await expect(
      runLaunchGate({ profile }, { checkProxy: async () => healthyCn }),
    ).rejects.toMatchObject({
      code: 'E_PROXY_GEO_MISMATCH',
      details: { exitTimezone: 'Asia/Shanghai', fingerprintTimezone: 'America/Los_Angeles' },
    });
  });

  it('ignoreProxyCheck 跳过代理两项检查，但指纹检查仍执行', async () => {
    let called = false;
    await expect(
      runLaunchGate({ profile: makeProfile(), ignoreProxyCheck: true }, {
        checkProxy: async () => {
          called = true;
          return healthyCn;
        },
      }),
    ).resolves.toBeUndefined();
    expect(called).toBe(false);
  });

  it('无代理绑定的环境直接放行代理检查', async () => {
    const profile = { ...makeProfile(), proxyId: undefined };
    await expect(runLaunchGate({ profile }, { checkProxy: async () => healthyCn })).resolves.toBeUndefined();
  });
});
