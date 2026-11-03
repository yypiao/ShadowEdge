import { randomUUID } from 'node:crypto';
import type {
  BrowserProfile,
  BrowserStorageState,
  ProfileBackupEnvelope,
  ProxyCredential,
  Uuid,
} from '@shadowedge/core';
import { ShadowEdgeError } from '@shadowedge/core';
import { deriveKek, EnvelopeCrypto } from '@shadowedge/crypto';
import { auditFingerprint } from '@shadowedge/fingerprint';
import type { BrowserKernel } from '@shadowedge/kernel';
import type { ProfileRepository } from './profile-repository.js';
import type { ProxyRepository } from './proxy-repository.js';
import type { StorageStateRepository } from './storage-state-repository.js';

const KDF_ITERATIONS = 210000;

type BackupProxy = ProxyCredential & { password?: string };
interface BackupPayload {
  profile: BrowserProfile;
  proxies: BackupProxy[];
  storageState: BrowserStorageState;
}

interface BackupDeps {
  profileRepo: ProfileRepository;
  proxyRepo: ProxyRepository;
  storageStateRepo: StorageStateRepository;
  kernel: BrowserKernel;
}

function requirePassphrase(passphrase: string): void {
  if (passphrase.length < 12) {
    throw new ShadowEdgeError('E_BACKUP_INVALID', '备份口令至少需要 12 个字符');
  }
}

function proxyChain(proxyRepo: ProxyRepository, proxyId?: Uuid): BackupProxy[] {
  const result: BackupProxy[] = [];
  const visited = new Set<Uuid>();
  let current = proxyId;
  while (current) {
    if (visited.has(current) || result.length >= 8) {
      throw new ShadowEdgeError('E_BACKUP_INVALID', '代理链存在循环或超过 8 跳');
    }
    visited.add(current);
    const credential = proxyRepo.get(current);
    if (!credential) throw new ShadowEdgeError('E_PROXY_NOT_FOUND', `代理 ${current} 不存在`);
    result.push({ ...credential, password: proxyRepo.reveal(current) });
    current = credential.upstreamId;
  }
  return result;
}

export async function exportProfileBackup(
  deps: BackupDeps,
  profileId: Uuid,
  passphrase: string,
): Promise<{ contents: string; cookieCount: number; originCount: number }> {
  requirePassphrase(passphrase);
  const profile = deps.profileRepo.get(profileId);
  if (!profile) throw new ShadowEdgeError('E_PROFILE_NOT_FOUND', `环境 ${profileId} 不存在`);
  const context = deps.kernel.getAutomationContext(profileId);
  const storageState = await context.storageState();
  const payload: BackupPayload = {
    profile,
    proxies: proxyChain(deps.proxyRepo, profile.proxyId),
    storageState,
  };
  const { kek, salt } = deriveKek(passphrase, undefined, KDF_ITERATIONS);
  const sealed = new EnvelopeCrypto(kek).seal(JSON.stringify(payload), 'profile-backup');
  const envelope: ProfileBackupEnvelope = {
    format: 'shadowedge-profile-backup',
    version: 1,
    kdf: { name: 'PBKDF2-SHA256', iterations: KDF_ITERATIONS, salt },
    payload: sealed,
  };
  return {
    contents: `${JSON.stringify(envelope, null, 2)}\n`,
    cookieCount: storageState.cookies.length,
    originCount: storageState.origins.length,
  };
}

export function importProfileBackup(
  deps: BackupDeps,
  input: { contents: string; passphrase: string; name?: string },
): { profile: BrowserProfile; cookieCount: number; originCount: number } {
  requirePassphrase(input.passphrase);
  const envelope = parseEnvelope(input.contents);
  let payload: BackupPayload;
  try {
    const { kek } = deriveKek(
      input.passphrase,
      envelope.kdf.salt,
      envelope.kdf.iterations,
    );
    const plaintext = new EnvelopeCrypto(kek).unseal(
      envelope.payload.ciphertext,
      envelope.payload.wrappedKey,
      envelope.payload.iv,
      'profile-backup',
    );
    payload = parsePayload(JSON.parse(plaintext));
  } catch (error) {
    if (error instanceof ShadowEdgeError && error.code === 'E_BACKUP_INVALID') throw error;
    throw new ShadowEdgeError('E_CRYPTO_UNSEAL_FAILED', '备份口令错误或文件已损坏', {
      cause: error,
    });
  }

  const proxyIds = new Map<Uuid, Uuid>();
  for (const proxy of payload.proxies) proxyIds.set(proxy.id, randomUUID() as Uuid);
  for (const proxy of payload.proxies) {
    deps.proxyRepo.upsert({
      ...proxy,
      id: proxyIds.get(proxy.id)!,
      orgId: 'local',
      upstreamId: proxy.upstreamId ? proxyIds.get(proxy.upstreamId) : undefined,
    });
  }
  const id = randomUUID() as Uuid;
  const now = new Date().toISOString();
  const profile: BrowserProfile = {
    ...payload.profile,
    id,
    orgId: 'local',
    name: input.name?.trim() || `${payload.profile.name}（导入）`,
    proxyId: payload.profile.proxyId ? proxyIds.get(payload.profile.proxyId) : undefined,
    ownerId: 'local-user',
    sharedWith: [],
    storage: {
      ...payload.profile.storage,
      userDataDir: `profiles/${id}`,
      remoteRevision: 0,
    },
    status: 'idle',
    createdAt: now,
    updatedAt: now,
  };
  deps.profileRepo.save(profile);
  deps.storageStateRepo.save(id, payload.storageState);
  return {
    profile,
    cookieCount: payload.storageState.cookies.length,
    originCount: payload.storageState.origins.length,
  };
}

function parseEnvelope(contents: string): ProfileBackupEnvelope {
  try {
    const value: unknown = JSON.parse(contents);
    if (!isRecord(value) || value.format !== 'shadowedge-profile-backup' || value.version !== 1) {
      throw new Error('format');
    }
    const kdf = value.kdf;
    const payload = value.payload;
    if (!isRecord(kdf) || kdf.name !== 'PBKDF2-SHA256' ||
      typeof kdf.iterations !== 'number' || !Number.isInteger(kdf.iterations) ||
      kdf.iterations < 100000 || kdf.iterations > 2000000 ||
      typeof kdf.salt !== 'string' || !isRecord(payload) ||
      typeof payload.ciphertext !== 'string' || typeof payload.wrappedKey !== 'string' ||
      typeof payload.iv !== 'string') {
      throw new Error('envelope');
    }
    return {
      format: 'shadowedge-profile-backup',
      version: 1,
      kdf: { name: 'PBKDF2-SHA256', iterations: kdf.iterations, salt: kdf.salt },
      payload: {
        ciphertext: payload.ciphertext,
        wrappedKey: payload.wrappedKey,
        iv: payload.iv,
      },
    };
  } catch (error) {
    throw new ShadowEdgeError('E_BACKUP_INVALID', '不是有效的 ShadowEdge 环境备份文件', {
      cause: error,
    });
  }
}

function parsePayload(value: unknown): BackupPayload {
  if (!isRecord(value) || !isBrowserProfile(value.profile) ||
    !isStorageState(value.storageState) || !Array.isArray(value.proxies) ||
    !value.proxies.every(isBackupProxy)) {
    throw new ShadowEdgeError('E_BACKUP_INVALID', '备份载荷结构无效');
  }
  return { profile: value.profile, storageState: value.storageState, proxies: value.proxies };
}

function isBrowserProfile(value: unknown): value is BrowserProfile {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.name !== 'string' ||
    !isRecord(value.storage) || typeof value.storage.userDataDir !== 'string' ||
    !Array.isArray(value.startupUrls) || !Array.isArray(value.sharedWith)) return false;
  try {
    if (!isRecord(value.fingerprint)) return false;
    // SAFETY: auditFingerprint 会逐维校验画像；失败时整个备份拒绝导入。
    const fingerprint = JSON.parse(JSON.stringify(value.fingerprint)) as BrowserProfile['fingerprint'];
    return auditFingerprint(fingerprint).consistent;
  } catch {
    return false;
  }
}

function isStorageState(value: unknown): value is BrowserStorageState {
  if (!isRecord(value) || !Array.isArray(value.cookies) || !Array.isArray(value.origins)) return false;
  return value.cookies.every((cookie) => isRecord(cookie) &&
    ['name', 'value', 'domain', 'path'].every((key) => typeof cookie[key] === 'string') &&
    typeof cookie.expires === 'number' && typeof cookie.httpOnly === 'boolean' &&
    typeof cookie.secure === 'boolean' && ['Strict', 'Lax', 'None'].includes(String(cookie.sameSite))) &&
    value.origins.every((origin) => isRecord(origin) && typeof origin.origin === 'string' &&
      Array.isArray(origin.localStorage) && origin.localStorage.every((item) =>
        isRecord(item) && typeof item.name === 'string' && typeof item.value === 'string'));
}

function isBackupProxy(value: unknown): value is BackupProxy {
  return isRecord(value) && typeof value.id === 'string' && typeof value.label === 'string' &&
    (value.protocol === 'http' || value.protocol === 'socks5') &&
    typeof value.host === 'string' && typeof value.port === 'number' &&
    (value.password === undefined || typeof value.password === 'string') &&
    (value.upstreamId === undefined || typeof value.upstreamId === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
