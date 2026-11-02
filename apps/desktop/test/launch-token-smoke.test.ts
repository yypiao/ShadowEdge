import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { BrowserProfile } from '@shadowedge/core';
import { generateFingerprint } from '@shadowedge/fingerprint';
import {
  BrowserKernel,
  ChromiumCdpDriver,
  createKernelLaunchAuthorization,
  KERNEL_LAUNCH_KEK_ENV,
} from '@shadowedge/kernel';

const executablePath = process.env.SHADOWEDGE_KERNEL_EXECUTABLE;
const SMOKE = process.env.SHADOWEDGE_SMOKE === '1' && executablePath !== undefined;

function launchDirectly(token?: string, kekHex?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'shadowedge-launch-token-'));
  const env = { ...process.env };
  delete env[KERNEL_LAUNCH_KEK_ENV];
  if (kekHex) env[KERNEL_LAUNCH_KEK_ENV] = kekHex;
  try {
    return spawnSync(
      executablePath!,
      [
        '--headless=new',
        '--disable-gpu',
        `--user-data-dir=${join(dir, 'profile')}`,
        ...(token ? [`--shadowedge-launch-token=${token}`] : []),
        'about:blank',
      ],
      { env, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function expectRejected(token?: string, kekHex?: string) {
  const result = launchDirectly(token, kekHex);
  expect(result.error).toBeUndefined();
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('ShadowEdge launch authorization');
}

describe.skipIf(!SMOKE)('Chromium 启动令牌原生校验', () => {
  it('缺失、错密钥与过期令牌均拒绝启动', () => {
    expectRejected();
    const valid = createKernelLaunchAuthorization('negative-test');
    expectRejected(valid.token, randomBytes(32).toString('hex'));
    const envelope = JSON.parse(Buffer.from(valid.token, 'base64').toString('utf8')) as {
      ciphertext: string;
    };
    const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
    ciphertext[0]! ^= 1;
    envelope.ciphertext = ciphertext.toString('base64');
    const tampered = Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64');
    expectRejected(tampered, valid.kekHex);
    const expired = createKernelLaunchAuthorization(
      'negative-test',
      Math.floor(Date.now() / 1000) - 120,
    );
    expectRejected(expired.token, expired.kekHex);
  }, 60000);

  it('桌面驱动签发的合法令牌可以启动', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shadowedge-launch-valid-'));
    const now = new Date().toISOString();
    const fingerprint = generateFingerprint({ seed: 'launch-token-valid', platform: 'host' });
    const profile: BrowserProfile = {
      id: 'launch-token-valid',
      orgId: 'local',
      name: 'launch-token-valid',
      kernel: 'chromium-patched',
      fingerprint,
      ownerId: 'local',
      sharedWith: [],
      storage: { userDataDir: join(dir, 'profile'), remoteRevision: 0, syncMode: 'local-only' },
      startupUrls: [],
      status: 'idle',
      createdAt: now,
      updatedAt: now,
    };
    const kernel = new BrowserKernel({
      drivers: [new ChromiumCdpDriver({ executablePath, fallbackToPatchright: false })],
    });
    try {
      const launched = await kernel.launch(profile, { profileId: profile.id });
      expect(launched.kernelUsed).toBe('chromium-cdp');
      expect(launched.pid).toBeGreaterThan(0);
    } finally {
      await kernel.close(profile.id);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);
});
