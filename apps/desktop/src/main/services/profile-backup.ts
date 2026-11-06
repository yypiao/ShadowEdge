import { randomUUID } from 'node:crypto';
import type {
  BrowserProfile,
  BrowserStorageState,
  AccountCredential,
  ProfileBackupEnvelope,
  ProxyCredential,
  RpaSchedule,
  RpaWorkflow,
  Uuid,
} from '@shadowedge/core';
import { CURRENT_PLATFORM_POLICY_CATALOG_VERSION, ShadowEdgeError } from '@shadowedge/core';
import { deriveKek, EnvelopeCrypto } from '@shadowedge/crypto';
import { auditFingerprint } from '@shadowedge/fingerprint';
import type { BrowserKernel } from '@shadowedge/kernel';
import { validateGraph } from '@shadowedge/rpa';
import type { AccountRepository } from './account-repository.js';
import type { RpaRepository } from './rpa-repository.js';
import type { ProfileRepository } from './profile-repository.js';
import type { ProxyRepository } from './proxy-repository.js';
import type { StorageStateRepository } from './storage-state-repository.js';
import { managedProfilePath } from './profile-directory.js';
import { captureStorageState, countIndexedDatabases, countOpfsFiles, withinOpfsBudget } from './profile-state.js';
import { normalizeProfileName } from './profile-input.js';
import { getPlatformPolicyCatalog, siteForProfile } from './platform-policies.js';

const KDF_ITERATIONS = 210000;

type BackupProxy = ProxyCredential & { password?: string };
type BackupAccount = AccountCredential & { password: string };
interface BackupSchedule {
  schedule: RpaSchedule;
  inputs?: Record<string, unknown>;
}
interface BackupPayload {
  profile: BrowserProfile;
  proxies: BackupProxy[];
  storageState: BrowserStorageState;
  accounts?: BackupAccount[];
  workflows?: RpaWorkflow[];
  schedules?: BackupSchedule[];
}

interface BackupDeps {
  profileRepo: ProfileRepository;
  proxyRepo: ProxyRepository;
  storageStateRepo: StorageStateRepository;
  accountRepo?: AccountRepository;
  rpaRepo?: RpaRepository;
  kernel: BrowserKernel;
  profilesDir: string;
  /** 旧备份没有固定版本时，按导入这一刻的默认签名版本固定。 */
  defaultKernelVersion?: string;
}

interface BackupCounts {
  cookieCount: number;
  originCount: number;
  indexedDbCount: number;
  opfsFileCount: number;
}

function counts(state: BrowserStorageState): BackupCounts {
  return {
    cookieCount: state.cookies.length,
    originCount: state.origins.length,
    indexedDbCount: countIndexedDatabases(state),
    opfsFileCount: countOpfsFiles(state),
  };
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
): Promise<{ contents: string } & BackupCounts> {
  requirePassphrase(passphrase);
  const profile = deps.profileRepo.get(profileId);
  if (!profile) throw new ShadowEdgeError('E_PROFILE_NOT_FOUND', `环境 ${profileId} 不存在`);
  const context = deps.kernel.getAutomationContext(profileId);
  const storageState = await captureStorageState(context);
  const accounts = deps.accountRepo?.list(profileId).map((credential) => ({
    ...credential,
    password: deps.accountRepo!.reveal(credential.id).password,
  })) ?? [];
  const workflows = deps.rpaRepo?.listWorkflows() ?? [];
  const schedules = deps.rpaRepo?.listSchedules()
    .filter((schedule) => schedule.profileIds.includes(profileId))
    .map((schedule) => ({
      schedule: { ...schedule, profileIds: [profileId] },
      inputs: deps.rpaRepo!.getScheduleInputs(schedule.workflowId),
    })) ?? [];
  const payload: BackupPayload = {
    profile,
    proxies: proxyChain(deps.proxyRepo, profile.proxyId),
    storageState,
    accounts,
    workflows,
    schedules,
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
    ...counts(storageState),
  };
}

export function importProfileBackup(
  deps: BackupDeps,
  input: { contents: string; passphrase: string; name?: string },
): { profile: BrowserProfile } & BackupCounts {
  requirePassphrase(input.passphrase);
  const envelope = parseEnvelope(input.contents);
  let payload: BackupPayload;
  try {
    const { kek } = deriveKek(input.passphrase, envelope.kdf.salt, envelope.kdf.iterations);
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

  validateProxyGraph(payload);
  validateBackupRelations(payload);
  if (((payload.accounts?.length ?? 0) > 0 && !deps.accountRepo) ||
    (((payload.workflows?.length ?? 0) > 0 || (payload.schedules?.length ?? 0) > 0) && !deps.rpaRepo)) {
    throw new ShadowEdgeError('E_BACKUP_INVALID', '当前导入器未配置账号或 RPA 仓储');
  }
  const proxyIds = new Map<Uuid, Uuid>();
  for (const proxy of payload.proxies) proxyIds.set(proxy.id, randomUUID() as Uuid);
  const workflowIds = new Map<Uuid, Uuid>();
  for (const workflow of payload.workflows ?? []) workflowIds.set(workflow.id, randomUUID() as Uuid);
  const id = randomUUID() as Uuid;
  const now = new Date().toISOString();
  const profile: BrowserProfile = {
    ...payload.profile,
    id,
    orgId: 'local',
    name: normalizeProfileName(input.name ?? `${payload.profile.name}（导入）`),
    proxyId: payload.profile.proxyId ? proxyIds.get(payload.profile.proxyId) : undefined,
    kernelVersion: payload.profile.kernelVersion ?? deps.defaultKernelVersion,
    platformPolicyVersion: payload.profile.platformPolicyVersion ??
      (payload.profile.platformTag || payload.profile.platformSiteId
        ? CURRENT_PLATFORM_POLICY_CATALOG_VERSION
        : undefined),
    // 导入的是独立环境，不能保留指向原设备环境的灰度关系。
    kernelUpgradeSourceId: undefined,
    ownerId: 'local-user',
    sharedWith: [],
    storage: {
      ...payload.profile.storage,
      userDataDir: managedProfilePath(deps.profilesDir, id),
      remoteRevision: 0,
    },
    status: 'idle',
    createdAt: now,
    updatedAt: now,
  };
  if (profile.platformPolicyVersion) getPlatformPolicyCatalog(profile.platformPolicyVersion);
  if (profile.platformSiteId) siteForProfile(profile);
  try {
    deps.profileRepo.transaction(() => {
      for (const proxy of payload.proxies) {
        const { password, secretRef: _secretRef, ...credential } = proxy;
        deps.proxyRepo.upsert({
          ...credential,
          password,
          id: proxyIds.get(proxy.id)!,
          orgId: 'local',
          upstreamId: proxy.upstreamId ? proxyIds.get(proxy.upstreamId) : undefined,
        });
      }
      deps.profileRepo.save(profile);
      deps.storageStateRepo.save(id, payload.storageState);
      for (const account of payload.accounts ?? []) {
        const { password, ...credential } = account;
        deps.accountRepo!.upsert({
          ...credential,
          id: randomUUID() as Uuid,
          profileId: id,
          password,
        });
      }
      for (const workflow of payload.workflows ?? []) {
        deps.rpaRepo!.saveWorkflow({
          ...workflow,
          id: workflowIds.get(workflow.id)!,
          orgId: 'local',
          createdBy: 'local-user',
        });
      }
      for (const item of payload.schedules ?? []) {
        deps.rpaRepo!.saveSchedule({
          ...item.schedule,
          workflowId: workflowIds.get(item.schedule.workflowId)!,
          profileIds: [id],
          // 导入不能触发过期任务；由用户审阅后显式启用并计算下一周期。
          enabled: false,
          nextRunAt: now,
          lastRunAt: undefined,
          lastError: undefined,
          updatedAt: now,
        }, item.inputs);
      }
    });
  } catch (error) {
    throw new ShadowEdgeError('E_STORAGE_STATE_FAILED', '备份导入未完整保存，所有写入已回滚', {
      retryable: true,
      cause: error,
    });
  }
  return { profile, ...counts(payload.storageState) };
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
  const accounts = value.accounts ?? [];
  const workflows = value.workflows ?? [];
  const schedules = value.schedules ?? [];
  if (!Array.isArray(accounts) || !accounts.every(isBackupAccount) ||
    !Array.isArray(workflows) || !workflows.every(isBackupWorkflow) ||
    !Array.isArray(schedules) || !schedules.every(isBackupSchedule)) {
    throw new ShadowEdgeError('E_BACKUP_INVALID', '备份账号或 RPA 载荷结构无效');
  }
  return {
    profile: value.profile,
    storageState: value.storageState,
    proxies: value.proxies,
    accounts,
    workflows,
    schedules,
  };
}

function isBrowserProfile(value: unknown): value is BrowserProfile {
  if (!isRecord(value) || typeof value.id !== 'string' ||
    typeof value.name !== 'string' || value.name.length > 120 ||
    (value.platformTag !== undefined && typeof value.platformTag !== 'string') ||
    (value.platformSiteId !== undefined && typeof value.platformSiteId !== 'string') ||
    (value.platformPolicyVersion !== undefined &&
      (typeof value.platformPolicyVersion !== 'string' || !/^[\w.-]{1,80}$/.test(value.platformPolicyVersion))) ||
    (value.kernelVersion !== undefined && (typeof value.kernelVersion !== 'string' || !/^[\w.-]{1,80}$/.test(value.kernelVersion))) ||
    (value.kernelUpgradeSourceId !== undefined && typeof value.kernelUpgradeSourceId !== 'string') ||
    !isRecord(value.storage) || typeof value.storage.userDataDir !== 'string' ||
    !['auto', 'manual', 'local-only'].includes(String(value.storage.syncMode)) ||
    !['chromium-patched', 'chromium-cdp', 'firefox-gecko'].includes(String(value.kernel)) ||
    !Array.isArray(value.startupUrls) ||
    !value.startupUrls.every((url) => typeof url === 'string') ||
    !Array.isArray(value.sharedWith)) return false;
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
  const validCookies = value.cookies.every((cookie): cookie is BrowserStorageState['cookies'][number] => isRecord(cookie) &&
    ['name', 'value', 'domain', 'path'].every((key) => typeof cookie[key] === 'string') &&
    typeof cookie.expires === 'number' && Number.isFinite(cookie.expires) &&
    typeof cookie.httpOnly === 'boolean' && typeof cookie.secure === 'boolean' &&
    ['Strict', 'Lax', 'None'].includes(String(cookie.sameSite)));
  const validOrigins = value.origins.every((origin): origin is BrowserStorageState['origins'][number] =>
    isRecord(origin) && typeof origin.origin === 'string' &&
      Array.isArray(origin.localStorage) && origin.localStorage.every((item) =>
        isRecord(item) && typeof item.name === 'string' && typeof item.value === 'string') &&
      (origin.indexedDB === undefined || isIndexedDb(origin.indexedDB)) &&
      (origin.opfs === undefined || isOpfs(origin.opfs)));
  const validSession = value.sessionStorage === undefined ||
    (Array.isArray(value.sessionStorage) && value.sessionStorage.length <= 1000 &&
      value.sessionStorage.every((snapshot) => isRecord(snapshot) &&
        typeof snapshot.url === 'string' && typeof snapshot.origin === 'string' &&
        Array.isArray(snapshot.items) && snapshot.items.length <= 10000 &&
        snapshot.items.every((item) => isRecord(item) &&
          typeof item.name === 'string' && typeof item.value === 'string')));
  if (!validCookies || !validOrigins || !validSession) return false;
  return withinOpfsBudget({ origins: value.origins });
}

function isOpfs(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > 4000) return false;
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.path !== 'string' || !validOpfsPath(entry.path)) return false;
    if (entry.type === 'directory') continue;
    if (entry.type !== 'file' || typeof entry.base64 !== 'string' || !validBase64(entry.base64)) return false;
  }
  return true;
}

function validOpfsPath(path: string): boolean {
  return path.length > 0 && path.length <= 1024 && !path.startsWith('/') && !path.endsWith('/') &&
    !path.includes('\\') && !path.includes('\0') &&
    path.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..');
}

function validBase64(value: string): boolean {
  return value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value) &&
    Buffer.from(value, 'base64').toString('base64') === value;
}

function isIndexedDb(value: unknown): boolean {
  return Array.isArray(value) && value.every((database) => isRecord(database) &&
    typeof database.name === 'string' && Number.isInteger(database.version) &&
    Array.isArray(database.stores) && database.stores.every((store) => isRecord(store) &&
      typeof store.name === 'string' && typeof store.autoIncrement === 'boolean' &&
      optionalStringOrArray(store, 'keyPath', 'keyPathArray') &&
      Array.isArray(store.records) && store.records.every(isRecord) &&
      Array.isArray(store.indexes) && store.indexes.every((index) => isRecord(index) &&
        typeof index.name === 'string' && optionalStringOrArray(index, 'keyPath', 'keyPathArray') &&
        typeof index.multiEntry === 'boolean' && typeof index.unique === 'boolean')));
}

function optionalStringOrArray(
  value: Record<string, unknown>,
  scalar: string,
  array: string,
): boolean {
  return (value[scalar] === undefined || typeof value[scalar] === 'string') &&
    (value[array] === undefined || Array.isArray(value[array]) &&
      value[array].every((item) => typeof item === 'string'));
}

function validateProxyGraph(payload: BackupPayload): void {
  if (payload.proxies.length > 8) {
    throw new ShadowEdgeError('E_BACKUP_INVALID', '备份代理链超过 8 跳');
  }
  const ids = new Set<Uuid>();
  for (const proxy of payload.proxies) {
    if (ids.has(proxy.id)) throw new ShadowEdgeError('E_BACKUP_INVALID', '备份代理 ID 重复');
    ids.add(proxy.id);
  }
  if (payload.profile.proxyId && !ids.has(payload.profile.proxyId)) {
    throw new ShadowEdgeError('E_BACKUP_INVALID', '环境绑定的代理未包含在备份中');
  }
  const byId = new Map(payload.proxies.map((proxy) => [proxy.id, proxy]));
  for (const proxy of payload.proxies) {
    if (proxy.upstreamId && !ids.has(proxy.upstreamId)) {
      throw new ShadowEdgeError('E_BACKUP_INVALID', '备份代理链缺少上游节点');
    }
    const visited = new Set<Uuid>();
    let current: Uuid | undefined = proxy.id;
    while (current) {
      if (visited.has(current)) throw new ShadowEdgeError('E_BACKUP_INVALID', '备份代理链存在循环');
      visited.add(current);
      current = byId.get(current)?.upstreamId;
    }
  }
}

function isBackupProxy(value: unknown): value is BackupProxy {
  return isRecord(value) && typeof value.id === 'string' && typeof value.label === 'string' &&
    (value.protocol === 'http' || value.protocol === 'socks5') &&
    typeof value.host === 'string' && Number.isInteger(value.port) &&
    Number(value.port) >= 1 && Number(value.port) <= 65535 &&
    (value.username === undefined || typeof value.username === 'string') &&
    (value.password === undefined || typeof value.password === 'string') &&
    (value.upstreamId === undefined || typeof value.upstreamId === 'string') &&
    Array.isArray(value.tags) && value.tags.every((tag) => typeof tag === 'string');
}

function isBackupAccount(value: unknown): value is BackupAccount {
  return isRecord(value) && typeof value.id === 'string' && typeof value.profileId === 'string' &&
    typeof value.label === 'string' && typeof value.origin === 'string' &&
    typeof value.username === 'string' && typeof value.usernameSelector === 'string' &&
    typeof value.passwordSelector === 'string' && typeof value.password === 'string' && value.password.length > 0 &&
    (value.submitSelector === undefined || typeof value.submitSelector === 'string');
}

function isRpaGraph(value: unknown): value is RpaWorkflow['graph'] {
  return isRecord(value) && typeof value.entry === 'string' && isRecord(value.nodes) &&
    (value.maxSteps === undefined || typeof value.maxSteps === 'number') &&
    (value.timeoutMs === undefined || typeof value.timeoutMs === 'number');
}

function isBackupWorkflow(value: unknown): value is RpaWorkflow {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.name !== 'string' ||
    !Number.isInteger(value.version) || !isRpaGraph(value.graph) ||
    typeof value.createdBy !== 'string' || typeof value.updatedAt !== 'string') return false;
  try {
    return validateGraph(value.graph).valid;
  } catch {
    return false;
  }
}

function isBackupSchedule(value: unknown): value is BackupSchedule {
  if (!isRecord(value) || !isRecord(value.schedule) ||
    (value.inputs !== undefined && !isRecord(value.inputs))) return false;
  const schedule = value.schedule;
  return typeof schedule.workflowId === 'string' && Array.isArray(schedule.profileIds) &&
    schedule.profileIds.every((id) => typeof id === 'string') &&
    Number.isInteger(schedule.intervalMinutes) && Number(schedule.intervalMinutes) >= 1 &&
    Number(schedule.intervalMinutes) <= 10080 && typeof schedule.enabled === 'boolean' &&
    typeof schedule.nextRunAt === 'string' && typeof schedule.updatedAt === 'string';
}

function validateBackupRelations(payload: BackupPayload): void {
  const workflowIds = new Set<Uuid>();
  for (const workflow of payload.workflows ?? []) {
    if (workflowIds.has(workflow.id)) throw new ShadowEdgeError('E_BACKUP_INVALID', '备份工作流 ID 重复');
    workflowIds.add(workflow.id);
  }
  for (const item of payload.schedules ?? []) {
    if (!workflowIds.has(item.schedule.workflowId)) {
      throw new ShadowEdgeError('E_BACKUP_INVALID', '调度配置引用了备份中不存在的工作流');
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
