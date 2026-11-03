import type { ProfileCreateInput, ProfileUpdateInput } from '@shadowedge/core';
import { ShadowEdgeError } from '@shadowedge/core';

export function normalizeProfileName(value: string | undefined): string {
  const name = value?.trim() ?? '';
  if (!name || name.length > 120) {
    throw new ShadowEdgeError('E_PROFILE_INVALID', '环境名称长度必须为 1–120 个字符');
  }
  return name;
}

export function normalizeStartupUrls(urls: string[] | undefined): string[] {
  if (!urls) return [];
  if (urls.length > 20) throw new ShadowEdgeError('E_PROFILE_INVALID', '每个环境最多配置 20 个启动页面');
  return urls.map((value) => {
    const trimmed = value.trim();
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch (error) {
      throw new ShadowEdgeError('E_PROFILE_INVALID', '启动页面必须是完整 HTTP(S) URL', { cause: error });
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || trimmed.length > 2048) {
      throw new ShadowEdgeError('E_PROFILE_INVALID', '启动页面仅允许不含凭据的 HTTP(S) URL');
    }
    return url.toString();
  });
}

export function normalizeCreateInput(input: ProfileCreateInput): ProfileCreateInput {
  return {
    ...input,
    name: normalizeProfileName(input.name),
    startupUrls: normalizeStartupUrls(input.startupUrls),
    notes: normalizeNotes(input.notes),
    platformTag: normalizePlatformTag(input.platformTag),
  };
}

export function normalizeUpdateInput(patch: ProfileUpdateInput): ProfileUpdateInput {
  return {
    name: patch.name === undefined ? undefined : normalizeProfileName(patch.name),
    platformTag: patch.platformTag === undefined ? undefined : normalizePlatformTag(patch.platformTag),
    groupId: patch.groupId,
    proxyId: patch.proxyId,
    startupUrls: patch.startupUrls === undefined ? undefined : normalizeStartupUrls(patch.startupUrls),
    notes: patch.notes === undefined ? undefined : normalizeNotes(patch.notes),
  };
}

function normalizeNotes(notes: string | undefined): string | undefined {
  if (notes !== undefined && notes.length > 4000) {
    throw new ShadowEdgeError('E_PROFILE_INVALID', '环境备注不能超过 4000 个字符');
  }
  return notes;
}

function normalizePlatformTag(tag: string | undefined): string | undefined {
  if (tag !== undefined && tag.length > 64) {
    throw new ShadowEdgeError('E_PROFILE_INVALID', '平台标识不能超过 64 个字符');
  }
  return tag;
}
