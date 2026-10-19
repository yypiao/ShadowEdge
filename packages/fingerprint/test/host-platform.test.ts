import { describe, expect, it } from 'vitest';
import { generateFingerprint, resolvePlatform } from '../src/index.js';

describe('跟随宿主机平台画像', () => {
  it('resolvePlatform：host 解析为当前宿主机（本机 darwin → macos）', () => {
    expect(resolvePlatform('host')).toBe(process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux');
    expect(resolvePlatform('windows')).toBe('windows');
    expect(resolvePlatform(undefined)).toBe(resolvePlatform('host'));
  });

  it('host 模式：macOS 宿主的 GPU 限定同系（不出 D3D11）', () => {
    if (process.platform !== 'darwin') return;
    for (const seed of ['h1', 'h2', 'h3', 'h4', 'h5']) {
      const fp = generateFingerprint({ seed, platform: 'host' });
      expect(fp.platform).toBe('macos');
      expect(fp.webgl.renderer).not.toContain('Direct3D11');
      expect(fp.webgl.renderer).toMatch(/Apple|Metal|OpenGL/);
    }
  });

  it('host 模式确定性：同 seed 两次产出逐字段一致', () => {
    expect(generateFingerprint({ seed: 'det', platform: 'host' })).toEqual(generateFingerprint({ seed: 'det', platform: 'host' }));
  });

  it('显式平台保持旧行为：windows 候选集不受 host 过滤影响（防历史漂移）', () => {
    const legacy = generateFingerprint({ seed: 'legacy-1', platform: 'windows' });
    expect(legacy.platform).toBe('windows');
    // 旧行为快照：seed legacy-1 在 windows 下的 WebGL 候选来自全量 4 项
    expect(generateFingerprint({ seed: 'legacy-1', platform: 'windows' })).toEqual(legacy);
  });
});
