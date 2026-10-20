import { describe, expect, it } from 'vitest';
import type { BrowserProfile } from '@shadowedge/core';
import { generateFingerprint } from '@shadowedge/fingerprint';
import { buildLaunchConfig } from '../src/drivers/patchright.js';
import type { KernelLaunchSpec } from '../src/driver.js';

function makeSpec(
  overrides: Partial<KernelLaunchSpec['options']> = {},
  proxy?: KernelLaunchSpec['proxy'],
): KernelLaunchSpec {
  const now = new Date().toISOString();
  const profile: BrowserProfile = {
    id: 'p1',
    orgId: 'local',
    name: 't',
    kernel: 'chromium-patched',
    fingerprint: generateFingerprint({ seed: 'driver-test' }),
    ownerId: 'local-user',
    sharedWith: [],
    storage: { userDataDir: 'profiles/p1', remoteRevision: 0, syncMode: 'auto' },
    startupUrls: [],
    status: 'idle',
    createdAt: now,
    updatedAt: now,
  };
  return { profile, options: { profileId: 'p1', ...overrides }, proxy };
}

describe('Patchright 驱动启动配置', () => {
  it('WebRTC 非代理 UDP 强制禁用（T0 泄漏修复）', () => {
    const { args } = buildLaunchConfig(makeSpec());
    expect(args).toContain('--force-webrtc-ip-handling-policy=disable_non_proxied_udp');
  });

  it('headless 一律拒绝（T0 探针可识别）', () => {
    expect(() => buildLaunchConfig(makeSpec({ headless: true }))).toThrowError(/headless/);
  });

  it('上下文选项映射画像字段', () => {
    const spec = makeSpec();
    const { contextOptions } = buildLaunchConfig(spec);
    expect(contextOptions.userAgent).toBe(spec.profile.fingerprint.userAgent);
    expect(contextOptions.timezoneId).toBe(spec.profile.fingerprint.timezone);
    expect(contextOptions.locale).toBe(spec.profile.fingerprint.languages[0]);
    expect(contextOptions.viewport?.width).toBe(spec.profile.fingerprint.viewport.width);
    expect(contextOptions.extraHTTPHeaders?.['sec-ch-ua']).toContain('"Chromium"');
    expect(contextOptions.extraHTTPHeaders?.['sec-ch-ua-platform']).toBe('"Windows"');
    expect(contextOptions.headless).toBe(false);
  });

  it('代理映射含凭据', () => {
    const { contextOptions } = buildLaunchConfig(
      makeSpec({}, { server: 'socks5://1.2.3.4:1080', username: 'u', password: 'p' }),
    );
    expect(contextOptions.proxy).toEqual({
      server: 'socks5://1.2.3.4:1080',
      username: 'u',
      password: 'p',
    });
  });

  it('remoteDebugging 时注入 CDP 端口参数', () => {
    const { args } = buildLaunchConfig(makeSpec({ remoteDebugging: true }), 19333);
    expect(args).toContain('--remote-debugging-port=19333');
  });

  it('注入脚本与画像确定性一致', () => {
    const a = buildLaunchConfig(makeSpec());
    const b = buildLaunchConfig(makeSpec());
    expect(a.injectionScript).toBe(b.injectionScript);
  });
});
