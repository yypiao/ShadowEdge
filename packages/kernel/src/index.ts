import type { BrowserProfile, LaunchOptions, LaunchResult, Uuid } from '@shadowedge/core';
import type { BrowserContext } from 'patchright';
import { ShadowEdgeError } from '@shadowedge/core';
import { startRelay, type RelayHandle } from '@shadowedge/proxy';
import type {
  KernelDriver,
  ResolvedProxy,
  ResolvedUpstreamProxy,
  RunningInstance,
} from './driver.js';
import { ChromiumCdpDriver } from './drivers/chromium-cdp.js';

export type {
  KernelDriver,
  KernelLaunchSpec,
  ResolvedProxy,
  ResolvedUpstreamProxy,
  RunningInstance,
} from './driver.js';
export { PatchrightDriver, buildLaunchConfig } from './drivers/patchright.js';
export {
  ChromiumCdpDriver,
  encodeFingerprintPortrait,
  resolveKernelExecutable,
} from './drivers/chromium-cdp.js';
export type { ChromiumCdpDriverOptions } from './drivers/chromium-cdp.js';

export interface BrowserKernelDeps {
  /** 按 proxyId 解析出可用代理（含已解封凭据）。由 handlers 层从加密仓储提供。 */
  resolveProxy?: (proxyId: Uuid) => Promise<ResolvedUpstreamProxy | undefined>;
  /** 驱动注册表，默认自研 Chromium 优先；Camoufox 备驱动就绪后在此追加。 */
  drivers?: KernelDriver[];
  /** 用户手动关窗或浏览器异常退出；显式 kernel.close() 不触发此回调。 */
  onExit?: (profileId: Uuid) => void;
}

/**
 * 内核门面：驱动选择、并发守卫、会话跟踪。
 * 渲染层/调用方只与 BrowserKernel 交互，不感知具体驱动。
 */
export class BrowserKernel {
  private readonly drivers: KernelDriver[];
  private readonly resolveProxy?: (proxyId: Uuid) => Promise<ResolvedUpstreamProxy | undefined>;
  private readonly onExit?: (profileId: Uuid) => void;
  private running = new Map<Uuid, RunningInstance>();

  constructor(deps: BrowserKernelDeps = {}) {
    this.drivers = deps.drivers ?? [new ChromiumCdpDriver()];
    this.resolveProxy = deps.resolveProxy;
    this.onExit = deps.onExit;
  }

  async launch(profile: BrowserProfile, options: LaunchOptions): Promise<LaunchResult> {
    if (this.running.has(profile.id)) {
      throw new ShadowEdgeError('E_PROFILE_BUSY', `环境 ${profile.id} 已在运行`);
    }

    // T8：Chromium 不支持 SOCKS5 认证与代理链，真实代理一律由本机中继承接，
    // Chromium 只看见 127.0.0.1 上的无认证 HTTP 代理。
    let relay: RelayHandle | undefined;
    let proxy: ResolvedProxy | undefined;
    if (profile.proxyId && this.resolveProxy) {
      const upstream = await this.resolveProxy(profile.proxyId);
      if (upstream) {
        const { upstream: firstHop, ...relayProxy } = upstream;
        relay = await startRelay(relayProxy, { upstream: firstHop });
        proxy = { server: relay.server };
      }
    }

    let relayClosed = false;
    const closeRelay = async () => {
      if (!relay || relayClosed) return;
      relayClosed = true;
      await relay.close();
    };

    const driver = this.drivers[0]!;
    let instance: RunningInstance;
    try {
      instance = await driver.launch({ profile, options, proxy });
    } catch (error) {
      await closeRelay().catch(() => undefined);
      throw error;
    }

    const innerClose = instance.close;
    instance.close = async () => {
      try {
        await innerClose();
      } finally {
        await closeRelay();
      }
    };

    this.running.set(profile.id, instance);
    instance.onExit(() => {
      // close() 会先删除运行记录，因此显式关闭不会重复上报 profile:exit。
      if (this.running.get(profile.id) !== instance) return;
      this.running.delete(profile.id);
      void closeRelay().catch(() => undefined);
      this.onExit?.(profile.id);
    });

    return {
      profileId: profile.id,
      sessionId: crypto.randomUUID() as Uuid,
      pid: instance.pid,
      wsEndpoint: instance.wsEndpoint,
      startedAt: instance.startedAt,
      kernelUsed: instance.kernelUsed ?? driver.name,
    };
  }

  async close(profileId: Uuid): Promise<void> {
    const instance = this.running.get(profileId);
    if (!instance) return;
    this.running.delete(profileId);
    await instance.close();
    // 中继由实例的 close 包装统一回收；天然退出则在 onExit 中回收。
  }

  getAutomationContext(profileId: Uuid): BrowserContext {
    const instance = this.running.get(profileId);
    if (!instance) {
      throw new ShadowEdgeError('E_PROFILE_NOT_RUNNING', `环境 ${profileId} 未在运行`);
    }
    if (!instance.getContext) {
      throw new ShadowEdgeError('E_INTERNAL', `环境 ${profileId} 的驱动不支持自动化上下文`);
    }
    return instance.getContext();
  }

  async listRunning(): Promise<Uuid[]> {
    return Array.from(this.running.keys());
  }
}
