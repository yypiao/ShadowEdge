import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KernelRuntimeService } from '../src/main/services/kernel-runtime.js';

describe('桌面内核运行配置', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shadowedge-kernel-runtime-'));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('缺省无配置时明确报告不可用', () => {
    const status = new KernelRuntimeService(dir, {}).getStatus();
    expect(status).toMatchObject({ available: false, source: 'none', fallbackPolicy: 'allow-patchright' });
  });

  it('环境变量路径可解析且不与用户配置混淆', () => {
    const status = new KernelRuntimeService(dir, { SHADOWEDGE_KERNEL_EXECUTABLE: '/bin/sh' }).getStatus();
    expect(status).toMatchObject({
      available: true,
      source: 'environment',
      resolvedExecutablePath: '/bin/sh',
    });
    expect(status.executablePath).toBeUndefined();
  });

  it('用户配置原子持久化，严格模式即时反映到驱动选项', () => {
    const runtime = new KernelRuntimeService(dir, {});
    const saved = runtime.configure({ executablePath: '/bin/sh', fallbackPolicy: 'require-chromium-cdp' });
    expect(saved).toMatchObject({ available: true, source: 'configured', resolvedExecutablePath: '/bin/sh' });
    expect(runtime.driverOptions().fallbackToPatchright).toBeTypeOf('function');
    const fallback = runtime.driverOptions().fallbackToPatchright;
    expect(typeof fallback === 'function' ? fallback() : fallback).toBe(false);

    const restored = new KernelRuntimeService(dir, {});
    expect(restored.getStatus()).toMatchObject(saved);
    expect(readFileSync(join(dir, 'kernel-runtime.json'), 'utf8')).not.toContain('/bin/sh".tmp');
  });

  it('运行中修改回退策略不需要重建驱动选项', () => {
    const runtime = new KernelRuntimeService(dir, {});
    const options = runtime.driverOptions();
    const fallback = options.fallbackToPatchright;
    expect(typeof fallback === 'function' ? fallback() : fallback).toBe(true);
    runtime.configure({ executablePath: '/bin/sh', fallbackPolicy: 'require-chromium-cdp' });
    expect(typeof fallback === 'function' ? fallback() : fallback).toBe(false);
  });

  it('拒绝相对路径、不存在的路径和非法策略', () => {
    const runtime = new KernelRuntimeService(dir, {});
    expect(() => runtime.configure({ executablePath: 'chromium', fallbackPolicy: 'allow-patchright' }))
      .toThrowError(expect.objectContaining({ code: 'E_KERNEL_NOT_INSTALLED' }));
    expect(() => runtime.configure({ executablePath: '/nonexistent/chromium', fallbackPolicy: 'allow-patchright' }))
      .toThrowError(expect.objectContaining({ code: 'E_KERNEL_NOT_INSTALLED' }));
  });
});
