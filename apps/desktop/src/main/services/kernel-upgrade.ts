import { randomUUID } from 'node:crypto';
import type { BrowserProfile, Uuid } from '@shadowedge/core';
import { ShadowEdgeError } from '@shadowedge/core';
import type { KernelDistributionService } from './kernel-distribution.js';
import { managedProfilePath } from './profile-directory.js';

/** 灰度克隆只复制环境契约；加密站点状态由 handlers 在同一事务内复制。 */
export function prepareKernelUpgrade(
  source: BrowserProfile,
  targetVersion: string,
  distribution: KernelDistributionService,
  profilesDir: string,
  now = new Date().toISOString(),
): BrowserProfile {
  requireIdle(source, '原环境');
  distribution.verifyVersion(targetVersion);
  const id = randomUUID() as Uuid;
  return {
    ...source,
    id,
    name: `【内核验证】${source.name}`.slice(0, 120),
    kernelVersion: targetVersion,
    kernelUpgradeSourceId: source.id,
    storage: {
      userDataDir: managedProfilePath(profilesDir, id),
      remoteRevision: 0,
      // 验证克隆不能和原环境争用远端同步 revision。
      syncMode: 'local-only',
    },
    status: 'idle',
    lastUsedAt: undefined,
    createdAt: now,
    updatedAt: now,
  };
}

export function commitKernelUpgrade(
  source: BrowserProfile,
  clone: BrowserProfile,
  confirmed: boolean,
  distribution: KernelDistributionService,
  now = new Date().toISOString(),
): BrowserProfile {
  if (!confirmed) {
    throw new ShadowEdgeError(
      'E_KERNEL_UPGRADE_NOT_CONFIRMED',
      '必须先完成克隆环境探针对照并明确确认，原环境保持不变',
    );
  }
  requireIdle(source, '原环境');
  requireIdle(clone, '验证克隆');
  if (clone.kernelUpgradeSourceId !== source.id || !clone.kernelVersion) {
    throw new ShadowEdgeError('E_PROFILE_INVALID', '验证克隆与原环境不匹配');
  }
  distribution.verifyVersion(clone.kernelVersion);
  return { ...source, kernelVersion: clone.kernelVersion, updatedAt: now };
}

function requireIdle(profile: BrowserProfile, label: string): void {
  if (profile.status !== 'idle') {
    throw new ShadowEdgeError('E_PROFILE_BUSY', `${label}正在运行或同步，请先停止后再进行内核升级`);
  }
}
