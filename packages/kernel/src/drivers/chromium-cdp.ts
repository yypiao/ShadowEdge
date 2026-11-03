import { existsSync, mkdirSync } from 'node:fs';
import { chromium, type BrowserContext } from 'patchright';
import { createConsoleLogger, ShadowEdgeError } from '@shadowedge/core';
import {
  buildLaunchConfig,
  findFreePort,
  PatchrightDriver,
  readBrowserProcessId,
} from './patchright.js';
import type { KernelDriver, KernelLaunchSpec, RunningInstance } from '../driver.js';
import { createKernelLaunchAuthorization, KERNEL_LAUNCH_KEK_ENV } from '../launch-token.js';

export interface ChromiumCdpDriverOptions {
  /** 自构建内核可执行文件路径；缺省读环境变量 SHADOWEDGE_KERNEL_EXECUTABLE。 */
  executablePath?: string | (() => string | undefined);
  /** 内核缺失或启动失败时回退 Patchright（默认 true）。函数形式支持运行时修改配置。 */
  fallbackToPatchright?: boolean | (() => boolean);
  /** 回退驱动替换点（测试注入用，生产缺省 PatchrightDriver）。 */
  fallbackDriver?: KernelDriver;
}

const log = createConsoleLogger({ driver: 'chromium-cdp' });

function redactLaunchError(error: Error): string {
  return error.message.replace(
    /--shadowedge-launch-token=\S+/g,
    '--shadowedge-launch-token=[redacted]',
  );
}

/**
 * 解析自构建内核路径。不存在视为未就绪（返回 undefined 走回退），
 * 不允许拿着坏路径去启动再失败——回退决策必须发生在启动前。
 */
export function resolveKernelExecutable(
  explicit?: string | (() => string | undefined),
): string | undefined {
  const configured = typeof explicit === 'function' ? explicit() : explicit;
  const candidate = configured ?? process.env.SHADOWEDGE_KERNEL_EXECUTABLE;
  if (!candidate) return undefined;
  return existsSync(candidate) ? candidate : undefined;
}

export function browserChildEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => {
      // 本机数据 KEK 只允许存在于 Electron 主进程，绝不继承给业务浏览器。
      return entry[0] !== 'SHADOWEDGE_KEK' && typeof entry[1] === 'string';
    }),
  );
}

/** 画像序列化为 base64-JSON，与内核 0001 补丁的校验口径（base64 + JSON 对象）一致。 */
export function encodeFingerprintPortrait(spec: KernelLaunchSpec): string {
  return Buffer.from(JSON.stringify(spec.profile.fingerprint), 'utf8').toString('base64');
}

/**
 * 自研 Chromium 内核驱动（T13）。
 * 复用 Patchright 的启动参数/上下文组装（同一套画像来源），差异只在：
 * 1. executablePath 指向自构建内核；2. 追加 --shadowedge-fingerprint 画像入口。
 * JS 注入层暂保留：C++ 层目前只覆盖 webdriver，其余维度等 T14/T15 下沉后让位。
 */
export class ChromiumCdpDriver implements KernelDriver {
  readonly name = 'chromium-cdp';

  constructor(private readonly opts: ChromiumCdpDriverOptions = {}) {}

  async launch(spec: KernelLaunchSpec): Promise<RunningInstance> {
    const executablePath = resolveKernelExecutable(this.opts.executablePath);
    if (!executablePath) {
      return this.launchFallback(spec, 'kernel executable not found');
    }

    const cdpPort = spec.options.remoteDebugging ? await findFreePort() : undefined;
    // 内核模式保留原生 Worker 构造器：0003/0008 把同一脚本送进所有 Worker 作用域。
    const { contextOptions, injectionScript } = buildLaunchConfig(spec, cdpPort, {
      serviceWorker: 'kernel',
      // 0004/0005 已下沉 Screen/WebGL/Audio；Canvas 保留 JS，见 ADR 0005。
      coveredByKernel: ['screen', 'webgl', 'audio'],
    });
    const userDataDir = spec.profile.storage.userDataDir;
    const authorization = createKernelLaunchAuthorization(spec.profile.id);
    const environment = browserChildEnvironment(process.env);
    mkdirSync(userDataDir, { recursive: true });

    let context: BrowserContext;
    try {
      context = await chromium.launchPersistentContext(userDataDir, {
        ...contextOptions,
        args: [
          ...contextOptions.args,
          `--shadowedge-fingerprint=${encodeFingerprintPortrait(spec)}`,
          `--shadowedge-launch-token=${authorization.token}`,
          // 全 Worker 作用域的注入载体（0003/0008 在 Worker 自身脚本前求值）。
          `--shadowedge-init-script=${Buffer.from(injectionScript, 'utf8').toString('base64')}`,
        ],
        executablePath,
        env: { ...environment, [KERNEL_LAUNCH_KEK_ENV]: authorization.kekHex },
      });
    } catch (error) {
      const reason = redactLaunchError(error as Error);
      if (this.fallbackDisabled()) {
        throw new ShadowEdgeError('E_KERNEL_LAUNCH_FAILED', `自研内核启动失败: ${reason}`, {
          retryable: true,
          // Patchright 的原始启动错误包含完整命令行，不能把密文令牌留在 cause 中。
          cause: new Error(reason),
        });
      }
      return this.launchFallback(spec, `kernel launch failed: ${reason}`);
    }
    await context.addInitScript({ content: injectionScript });

    return {
      profileId: spec.profile.id,
      pid: await readBrowserProcessId(context),
      wsEndpoint: cdpPort ? `http://127.0.0.1:${cdpPort}` : undefined,
      startedAt: new Date().toISOString(),
      kernelUsed: this.name,
      onExit: (listener) => context.on('close', listener),
      getContext: () => context,
      close: async () => {
        await context.close().catch(() => undefined);
      },
    };
  }

  private fallbackDisabled(): boolean {
    return typeof this.opts.fallbackToPatchright === 'function'
      ? !this.opts.fallbackToPatchright()
      : this.opts.fallbackToPatchright === false;
  }

  /** 回退路径：委托 Patchright，并在实例上显式标记 kernelUsed，禁止静默降级。 */
  protected async launchFallback(spec: KernelLaunchSpec, reason: string): Promise<RunningInstance> {
    if (this.fallbackDisabled()) {
      throw new ShadowEdgeError('E_KERNEL_LAUNCH_FAILED', `自研内核不可用且回退已禁用: ${reason}`, {
        details: { reason },
      });
    }
    const fallback = this.opts.fallbackDriver ?? new PatchrightDriver();
    log.warn('回退 Patchright 驱动', {
      reason,
      profileId: spec.profile.id,
      fallback: fallback.name,
    });
    const instance = await fallback.launch(spec);
    instance.kernelUsed = fallback.name;
    return instance;
  }
}
