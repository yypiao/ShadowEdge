import type { BrowserProfile, LaunchOptions, LaunchResult, Uuid } from '@shadowedge/core';
import { ShadowEdgeError } from '@shadowedge/core';
import type { KernelDriver, ResolvedProxy, RunningInstance } from './driver.js';
import { PatchrightDriver } from './drivers/patchright.js';

export type { KernelDriver, KernelLaunchSpec, ResolvedProxy, RunningInstance } from './driver.js';
export { PatchrightDriver, buildLaunchConfig } from './drivers/patchright.js';

export interface BrowserKernelDeps {
  /** 按 proxyId 解析出可用代理（含已解封凭据）。由 handlers 层从加密仓储提供。 */
  resolveProxy?: (proxyId: Uuid) => Promise<ResolvedProxy | undefined>;
  /** 驱动注册表，默认仅 Patchright 主驱动；Camoufox 备驱动就绪后在此追加。 */
  drivers?: KernelDriver[];
}

/**
 * 内核门面：驱动选择、并发守卫、会话跟踪。
 * 渲染层/调用方只与 BrowserKernel 交互，不感知具体驱动。
 */
export class BrowserKernel {
  private readonly drivers: KernelDriver[];
  private readonly resolveProxy?: (proxyId: Uuid) => Promise<ResolvedProxy | undefined>;
  private running = new Map<Uuid, RunningInstance>();

  constructor(deps: BrowserKernelDeps = {}) {
    this.drivers = deps.drivers ?? [new PatchrightDriver()];
    this.resolveProxy = deps.resolveProxy;
  }

  async launch(profile: BrowserProfile, options: LaunchOptions): Promise<LaunchResult> {
    if (this.running.has(profile.id)) {
      throw new ShadowEdgeError('E_PROFILE_BUSY', `环境 ${profile.id} 已在运行`);
    }

    let proxy: ResolvedProxy | undefined;
    if (profile.proxyId && this.resolveProxy) {
      proxy = await this.resolveProxy(profile.proxyId);
    }

    // 当前唯一驱动；多驱动就绪后按 profile.kernel 选择。
    const driver = this.drivers[0]!;
    const instance = await driver.launch({ profile, options, proxy });
    this.running.set(profile.id, instance);

    return {
      profileId: profile.id,
      sessionId: crypto.randomUUID() as Uuid,
      pid: instance.pid,
      wsEndpoint: instance.wsEndpoint,
      startedAt: instance.startedAt,
    };
  }

  async close(profileId: Uuid): Promise<void> {
    const instance = this.running.get(profileId);
    if (!instance) return;
    this.running.delete(profileId);
    await instance.close();
  }

  async listRunning(): Promise<Uuid[]> {
    return Array.from(this.running.keys());
  }
}
