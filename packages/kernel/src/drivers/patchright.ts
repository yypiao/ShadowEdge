import { mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { chromium, type BrowserContext } from 'patchright';
import { ShadowEdgeError } from '@shadowedge/core';
import { buildInjectionScript } from '@shadowedge/fingerprint';
import type { KernelDriver, KernelLaunchSpec, RunningInstance } from '../driver.js';

/** T0 实验结论：禁止非代理 UDP，否则 WebRTC 泄漏真实出口 IP。 */
const WEBRTC_POLICY_FLAG = '--force-webrtc-ip-handling-policy=disable_non_proxied_udp';

/** 探测一个空闲本地端口供 CDP 使用。 */
export async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** 组装持久化上下文的启动参数与上下文选项。独立导出以便单测覆盖，不必真开浏览器。 */
export function buildLaunchConfig(spec: KernelLaunchSpec, cdpPort?: number) {
  const fp = spec.profile.fingerprint;

  if (spec.options.headless) {
    // T0 实验结论：headless 被 CreepJS 以 94% 置信度识别，业务环境一律 headed。
    throw new ShadowEdgeError('E_KERNEL_LAUNCH_FAILED', '业务环境禁止 headless 启动（可被探针识别）', {
      details: { profileId: spec.profile.id },
    });
  }

  const args = [
    WEBRTC_POLICY_FLAG,
    // QUIC 不走 HTTP/SOCKS5 代理的 TCP 通道，禁用防止流量绕过代理出口。
    '--disable-quic',
    '--disable-blink-features=AutomationControlled',
    `--window-size=${fp.screen.width},${fp.screen.height}`,
    ...(cdpPort ? [`--remote-debugging-port=${cdpPort}`] : []),
    ...(spec.options.extraArgs ?? []),
  ];

  const contextOptions = {
    headless: false,
    args,
    userAgent: fp.userAgent,
    locale: fp.languages[0] ?? 'en-US',
    timezoneId: fp.timezone,
    viewport: { width: fp.viewport.width, height: fp.viewport.height },
    deviceScaleFactor: fp.screen.pixelRatio,
    geolocation: fp.geolocation
      ? { latitude: fp.geolocation.latitude, longitude: fp.geolocation.longitude, accuracy: fp.geolocation.accuracy }
      : undefined,
    permissions: fp.geolocation ? ['geolocation'] : [],
    proxy: spec.proxy
      ? { server: spec.proxy.server, username: spec.proxy.username, password: spec.proxy.password }
      : undefined,
  };

  return { args, contextOptions, injectionScript: buildInjectionScript(fp) };
}

/** Patchright 主驱动（ADR 0004 方案 A）：持久化目录隔离 + 主世界确定性指纹注入。 */
export class PatchrightDriver implements KernelDriver {
  readonly name = 'patchright-chromium';

  async launch(spec: KernelLaunchSpec): Promise<RunningInstance> {
    const cdpPort = spec.options.remoteDebugging ? await findFreePort() : undefined;
    const { contextOptions, injectionScript } = buildLaunchConfig(spec, cdpPort);
    const userDataDir = spec.profile.storage.userDataDir;
    mkdirSync(userDataDir, { recursive: true });

    let context: BrowserContext;
    try {
      context = await chromium.launchPersistentContext(userDataDir, contextOptions);
    } catch (error) {
      throw new ShadowEdgeError('E_KERNEL_LAUNCH_FAILED', `内核启动失败: ${(error as Error).message}`, {
        retryable: true,
        cause: error,
      });
    }
    await context.addInitScript({ content: injectionScript });

    // 说明：SystemInfo.getProcessInfo 仅 browser target 可用，而 patchright 持久化上下文
    // 拿不到 browser target，pid 无法可靠获取。进程回收依赖 context.close()（内核随上下文退出），
    // 因此 LaunchResult.pid 恒为 0，调用方不得依赖 pid 做进程管理。
    const pid = 0;
    const startedAt = new Date().toISOString();

    context.on('close', () => {
      // 用户手动关窗时由 BrowserKernel 的 close 收口；这里只兜底防泄漏。
    });

    return {
      profileId: spec.profile.id,
      pid,
      wsEndpoint: cdpPort ? `http://127.0.0.1:${cdpPort}` : undefined,
      startedAt,
      close: async () => {
        await context.close().catch(() => undefined);
      },
    };
  }
}
