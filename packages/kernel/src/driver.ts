import type { BrowserProfile, LaunchOptions, LaunchResult, Uuid } from '@shadowedge/core';

/** 已解析的代理（handlers 层从加密仓储取出后注入，内核不接触密文存储）。 */
export interface ResolvedProxy {
  server: string;
  username?: string;
  password?: string;
}

/** 驱动无关的启动规格：由 BrowserKernel 门面组装，驱动只负责执行。 */
export interface KernelLaunchSpec {
  profile: BrowserProfile;
  options: LaunchOptions;
  proxy?: ResolvedProxy;
}

export interface RunningInstance {
  profileId: Uuid;
  pid: number;
  wsEndpoint?: string;
  startedAt: string;
  close(): Promise<void>;
}

/**
 * 内核驱动接口（ADR 0003/0004 的供应商中立接缝）。
 * 主实现：PatchrightDriver（Chromium）；备选：CamoufoxDriver（Firefox）。
 * 新驱动必须先通过 packages/kernel/test 的驱动契约测试。
 */
export interface KernelDriver {
  readonly name: string;
  launch(spec: KernelLaunchSpec): Promise<RunningInstance>;
}
