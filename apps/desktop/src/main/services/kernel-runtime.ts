import { constants } from 'node:fs';
import { accessSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserProfile, KernelRuntimeConfig, KernelRuntimeStatus } from '@shadowedge/core';
import { ShadowEdgeError } from '@shadowedge/core';
import type { ChromiumCdpDriverOptions } from '@shadowedge/kernel';

interface RuntimeEnvironment {
  SHADOWEDGE_KERNEL_EXECUTABLE?: string;
}

/** 主进程内核配置；路径不是凭据，但仍以 0600 写入并原子替换，避免半文件。 */
export class KernelRuntimeService {
  private config: KernelRuntimeConfig;

  constructor(
    private readonly dataDir: string,
    private readonly env: RuntimeEnvironment = process.env,
    private readonly verifyInstalled?: (version?: string) => void,
    private readonly resolveInstalled?: (version?: string) => string | undefined,
  ) {
    this.config = this.load();
  }

  getStatus(): KernelRuntimeStatus {
    const resolved = this.resolve();
    return {
      ...this.config,
      resolvedExecutablePath: resolved.path,
      source: resolved.source,
      available: resolved.path !== undefined,
    };
  }

  configure(input: KernelRuntimeConfig): KernelRuntimeStatus {
    if (input.fallbackPolicy !== 'allow-patchright' && input.fallbackPolicy !== 'require-chromium-cdp') {
      throw new ShadowEdgeError('E_INTERNAL', '未知的内核回退策略');
    }
    if (input.executablePath !== undefined) {
      assertExecutable(input.executablePath);
    }
    this.config = {
      executablePath: input.executablePath || undefined,
      fallbackPolicy: input.fallbackPolicy,
    };
    this.save();
    return this.getStatus();
  }

  /** 每次启动读取最新配置；固定版本环境绕过全局配置和 current 软链。 */
  driverOptions(): ChromiumCdpDriverOptions {
    return {
      executablePath: (profile) => {
        const resolved = this.resolve(profile);
        if (resolved.source === 'installed') this.verifyInstalled?.(profile?.kernelVersion);
        return resolved.path;
      },
      fallbackToPatchright: () => this.config.fallbackPolicy === 'allow-patchright',
    };
  }

  private resolve(profile?: BrowserProfile): { path?: string; source: KernelRuntimeStatus['source'] } {
    if (profile?.kernelVersion) {
      const pinned = this.resolveInstalled?.(profile.kernelVersion) ??
        installedExecutable(this.dataDir, profile.kernelVersion);
      if (!usableExecutable(pinned)) {
        throw new ShadowEdgeError(
          'E_KERNEL_VERSION_NOT_FOUND',
          `环境固定的内核版本 ${profile.kernelVersion} 未安装或不可执行`,
        );
      }
      return { path: pinned, source: 'installed' };
    }
    if (this.config.executablePath) {
      return usableExecutable(this.config.executablePath)
        ? { path: this.config.executablePath, source: 'configured' }
        : { source: 'none' };
    }
    if (this.env.SHADOWEDGE_KERNEL_EXECUTABLE) {
      return usableExecutable(this.env.SHADOWEDGE_KERNEL_EXECUTABLE)
        ? { path: this.env.SHADOWEDGE_KERNEL_EXECUTABLE, source: 'environment' }
        : { source: 'none' };
    }
    const installed = this.resolveInstalled?.() ?? installedExecutable(this.dataDir);
    if (profile && usableExecutable(installed)) {
      throw new ShadowEdgeError(
        'E_KERNEL_VERSION_NOT_PINNED',
        '该历史环境尚未固定内核版本；请先完成迁移，禁止静默跟随全局版本',
      );
    }
    return usableExecutable(installed)
      ? { path: installed, source: 'installed' }
      : { source: 'none' };
  }

  private load(): KernelRuntimeConfig {
    try {
      const value: unknown = JSON.parse(readFileSync(this.configPath(), 'utf8'));
      if (typeof value !== 'object' || value === null) throw new Error('not an object');
      const record = value as Record<string, unknown>;
      const executablePath = record.executablePath;
      const fallbackPolicy = record.fallbackPolicy;
      if (executablePath !== undefined && typeof executablePath !== 'string') throw new Error('invalid path');
      if (fallbackPolicy !== 'allow-patchright' && fallbackPolicy !== 'require-chromium-cdp') {
        throw new Error('invalid fallback policy');
      }
      return { executablePath: executablePath || undefined, fallbackPolicy };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { fallbackPolicy: 'allow-patchright' };
      }
      throw new ShadowEdgeError('E_INTERNAL', '内核配置文件损坏，请修复后重试', { cause: error });
    }
  }

  private save(): void {
    mkdirSync(this.dataDir, { recursive: true });
    const path = this.configPath();
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.config, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  }

  private configPath(): string {
    return join(this.dataDir, 'kernel-runtime.json');
  }
}

function installedExecutable(dataDir: string, version?: string): string {
  const root = version
    ? join(dataDir, 'kernels', 'versions', version, 'payload')
    : join(dataDir, 'kernels', 'current');
  if (process.platform === 'darwin') {
    return join(root, 'Chromium.app', 'Contents', 'MacOS', 'Chromium');
  }
  return join(root, process.platform === 'win32' ? 'chrome.exe' : 'chrome');
}

function usableExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function assertExecutable(path: string): void {
  if (!path.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(path)) {
    throw new ShadowEdgeError('E_KERNEL_NOT_INSTALLED', '内核路径必须是绝对路径');
  }
  if (!usableExecutable(path)) {
    throw new ShadowEdgeError('E_KERNEL_NOT_INSTALLED', `内核不可执行或不存在: ${path}`);
  }
}
