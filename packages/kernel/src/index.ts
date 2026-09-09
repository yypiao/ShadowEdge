import type { BrowserProfile, LaunchOptions, LaunchResult, Uuid } from '@shadowedge/core';
import { ShadowEdgeError } from '@shadowedge/core';
import { generateFingerprint } from '@shadowedge/fingerprint';
import { ProxyManager } from '@shadowedge/proxy';

/** 便携的 Chromium 启动器，无需 prebuilt 二进制即可运行类型检查。 */
export class BrowserKernel {
  private running = new Map<Uuid, { pid: number; wsEndpoint?: string }>();
  private proxyManager = new ProxyManager();

  /** 启动浏览器环境。 */
  async launch(profile: BrowserProfile, options: LaunchOptions): Promise<LaunchResult> {
    if (this.running.has(profile.id)) {
      throw new ShadowEdgeError('E_PROFILE_BUSY', `环境 ${profile.id} 已在运行`);
    }

    const fingerprint = generateFingerprint({
      seed: profile.fingerprint.seed,
      platform: profile.fingerprint.platform,
      overrides: profile.fingerprint,
    });

    const proxyConfig = profile.proxyId
      ? await this.proxyManager.check(profile.proxyId)
      : undefined;

    const sessionId = crypto.randomUUID() as Uuid;
    const result: LaunchResult = {
      profileId: profile.id,
      sessionId,
      pid: 0,
      wsEndpoint: options.remoteDebugging ? `ws://127.0.0.1:${9222 + Math.floor(Math.random() * 100)}` : undefined,
      startedAt: new Date().toISOString(),
    };
    this.running.set(profile.id, { pid: 0, wsEndpoint: result.wsEndpoint });
    return result;
  }

  async close(profileId: Uuid): Promise<void> {
    this.running.delete(profileId);
  }

  async listRunning(): Promise<Uuid[]> {
    return Array.from(this.running.keys());
  }

  /** 注入指纹脚本内容。实际场景由 Chromium patch 直接在 C++ 层拦截，这里仅做声明。 */
  getInjectionScript(fingerprint: unknown): string {
    return `// shadowedge-fingerprint-injection\n// 实际由 Chromium 补丁在 C++ 层拦截 API 调用\n// 参见 src/browser/patches/\n`;
  }
}
