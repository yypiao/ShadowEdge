import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path';
import type { BrowserProfile, Uuid } from '@shadowedge/core';
import { ShadowEdgeError } from '@shadowedge/core';
import type { ProfileRepository } from './profile-repository.js';

export function managedProfilePath(root: string, profileId: Uuid): string {
  const managedRoot = resolve(root);
  if (!profileId || basename(profileId) !== profileId || profileId === '.' || profileId === '..') {
    throw new ShadowEdgeError('E_PROFILE_INVALID', '环境 ID 不能用于构造安全数据目录');
  }
  const target = resolve(managedRoot, profileId);
  if (dirname(target) !== managedRoot || !target.startsWith(managedRoot + sep)) {
    throw new ShadowEdgeError('E_PROFILE_INVALID', '环境数据目录越界');
  }
  return target;
}

function isManagedPath(root: string, path: string, profileId: Uuid): boolean {
  return resolve(path) === managedProfilePath(root, profileId);
}

function moveDirectory(source: string, target: string): void {
  try {
    renameSync(source, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    cpSync(source, target, { recursive: true, errorOnExist: true, verbatimSymlinks: true });
    rmSync(source, { recursive: true, force: true });
  }
}

/** 旧版本使用 cwd/profiles/<id>；只迁移这一精确布局，绝不搬动任意外部路径。 */
export function migrateProfileDirectories(
  repository: ProfileRepository,
  root: string,
  legacyCwd: string,
): void {
  mkdirSync(root, { recursive: true });
  for (const profile of repository.list()) {
    const target = managedProfilePath(root, profile.id);
    if (isManagedPath(root, profile.storage.userDataDir, profile.id)) continue;
    if (isAbsolute(profile.storage.userDataDir)) {
      throw new ShadowEdgeError('E_PROFILE_INVALID', `环境 ${profile.id} 包含非托管绝对数据路径`);
    }
    const source = resolve(legacyCwd, profile.storage.userDataDir);
    if (source !== resolve(legacyCwd, 'profiles', profile.id)) {
      throw new ShadowEdgeError('E_PROFILE_INVALID', `环境 ${profile.id} 的旧数据路径不符合迁移布局`);
    }
    const sourceExists = existsSync(source);
    const targetExists = existsSync(target);
    if (sourceExists && targetExists) {
      throw new ShadowEdgeError('E_PROFILE_INVALID', `环境 ${profile.id} 新旧数据目录同时存在，未自动合并`);
    }
    if (sourceExists) moveDirectory(source, target);
    try {
      repository.save({
        ...profile,
        storage: { ...profile.storage, userDataDir: target },
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      if (sourceExists && existsSync(target) && !existsSync(source)) moveDirectory(target, source);
      throw error;
    }
  }
  recoverProfileQuarantine(root, repository);
}

export function removeProfileDirectory(root: string, profile: BrowserProfile): void {
  const target = managedProfilePath(root, profile.id);
  if (!isManagedPath(root, profile.storage.userDataDir, profile.id)) {
    throw new ShadowEdgeError('E_PROFILE_INVALID', '拒绝删除非托管环境数据目录');
  }
  const closed = resolve(root, `.closed-${profile.id}`);
  if (existsSync(target)) {
    if (existsSync(closed)) {
      throw new ShadowEdgeError('E_PROFILE_INVALID', '环境存在未收口的关闭隔离目录，请先重启恢复');
    }
    // 只有快照成功落库后才调用；原子改名避免崩溃留下半个可用目录。
    renameSync(target, closed);
  }
  rmSync(closed, { recursive: true, force: true });
}

/** 先改名再提交数据库删除；数据库失败可回滚，提交后的残留下次启动清理。 */
export function deleteProfileWithDirectory(
  repository: ProfileRepository,
  root: string,
  profile: BrowserProfile,
): void {
  const target = managedProfilePath(root, profile.id);
  if (!isManagedPath(root, profile.storage.userDataDir, profile.id)) {
    throw new ShadowEdgeError('E_PROFILE_INVALID', '拒绝删除非托管环境数据目录');
  }
  const quarantine = resolve(root, `.deleting-${profile.id}`);
  const exists = existsSync(target);
  if (exists) {
    if (existsSync(quarantine)) {
      throw new ShadowEdgeError('E_PROFILE_INVALID', '环境存在未收口的删除隔离目录，请先重启恢复');
    }
    renameSync(target, quarantine);
  }
  try {
    repository.transaction(() => repository.delete(profile.id));
  } catch (error) {
    if (exists && existsSync(quarantine) && !existsSync(target)) renameSync(quarantine, target);
    throw error;
  }
  rmSync(quarantine, { recursive: true, force: true });
}

export function recoverProfileQuarantine(root: string, repository: ProfileRepository): void {
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.closed-')) {
      // 该目录只会在完整快照成功落库后由原子改名产生。
      rmSync(resolve(root, entry.name), { recursive: true, force: true });
      continue;
    }
    if (!entry.name.startsWith('.deleting-')) continue;
    const profileId = entry.name.slice('.deleting-'.length);
    const quarantine = resolve(root, entry.name);
    const profile = repository.get(profileId);
    if (!profile) {
      // 数据库删除已提交，残留只是尚未清理的垃圾。
      rmSync(quarantine, { recursive: true, force: true });
      continue;
    }
    const target = managedProfilePath(root, profileId);
    if (existsSync(target)) {
      throw new ShadowEdgeError('E_PROFILE_INVALID', `环境 ${profileId} 的目录与删除隔离副本同时存在`);
    }
    // 崩溃发生在数据库删除前，必须回滚目录而不是清除用户状态。
    renameSync(quarantine, target);
  }
}
