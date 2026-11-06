import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildChromeCatalog,
  catalogPlatforms,
  catalogToGeneratorDb,
  auditFingerprint,
  generateFingerprint,
  parseChromeStableVersion,
  parseFingerprintCatalog,
} from '../src/index.js';

const meta = { generatedAt: '2026-10-22T00:00:00.000Z', source: 'test' };

describe('UA/UA-CH catalog', () => {
  it('由 Chrome 完整版本生成三平台目录', () => {
    const catalog = buildChromeCatalog('131.0.6778.86', meta);
    expect(catalog.chromeVersion).toBe('131.0.6778.86');
    expect(catalogPlatforms()).toEqual(['windows', 'macos', 'linux']);
    for (const platform of catalogPlatforms()) {
      const [entry] = catalog.platforms[platform];
      expect(entry?.userAgent).toContain('Chrome/131.0.0.0');
      expect(entry?.userAgentData.fullVersion).toBe('131.0.6778.86');
      expect(entry?.userAgentData.brands[0]).toEqual({ brand: 'Chromium', version: '131' });
    }
  });

  it('目录可序列化、解析并转换为生成器 db 覆盖', () => {
    const catalog = parseFingerprintCatalog(
      JSON.parse(JSON.stringify(buildChromeCatalog('131.0.6778.86', meta))),
    );
    const db = catalogToGeneratorDb(catalog);
    expect(db.userAgents.macos[0]).toContain('Chrome/131.0.0.0');
    expect(db.uaDatas.windows[0]?.platform).toBe('Windows');
  });

  it('使用目录生成的环境可用同一目录复现并通过审计', () => {
    const db = catalogToGeneratorDb(
      parseFingerprintCatalog(
        JSON.parse(JSON.stringify(buildChromeCatalog('131.0.6778.86', meta))),
      ),
    );
    const overrides = {
      webgl: {
        vendor: 'Google Inc. (Apple)',
        renderer: 'ANGLE (Apple, Apple M1 Pro, OpenGL 4.1)',
        noise: 'noise' as const,
      },
    };
    const fp = generateFingerprint({
      seed: 'catalog-seed',
      platform: 'macos',
      db,
      overrides,
    });
    expect(fp.userAgent).toContain('Chrome/131.0.0.0');
    expect(auditFingerprint(fp, { db, overrides }).consistent).toBe(true);
  });

  it('拒绝非法版本号与损坏目录', () => {
    expect(() => buildChromeCatalog('131.0', meta)).toThrow('invalid Chrome full version');
    expect(() => parseFingerprintCatalog({ schemaVersion: 1 })).toThrow(
      'invalid fingerprint catalog',
    );
  });

  it('从 Chrome for Testing 响应提取 stable 版本', () => {
    expect(parseChromeStableVersion({ channels: { Stable: { version: '131.0.6778.86' } } })).toBe(
      '131.0.6778.86',
    );
    expect(() => parseChromeStableVersion({ channels: {} })).toThrow();
  });
});

describe('画像绑定不可变 catalog 快照', () => {
  it('默认历史画像与显式 131 快照逐字节一致', () => {
    for (const seed of ['legacy-a', 'legacy-b', 'legacy-c']) {
      const historical = generateFingerprint({ seed, platform: 'host' });
      const restored = generateFingerprint({ seed, platform: 'host', catalogVersion: '131.0.6778.86' });
      expect(historical.catalogVersion).toBe('131.0.6778.86');
      expect(JSON.stringify(restored)).toBe(JSON.stringify(historical));
      expect(auditFingerprint(historical).consistent).toBe(true);
    }
  });

  it('新画像使用 156 且可按自身版本审计，不影响 131 画像', async () => {
    const { CURRENT_CATALOG_VERSION } = await import('../src/index.js');
    const current = generateFingerprint({ seed: 'catalog-seed', platform: 'host', catalogVersion: CURRENT_CATALOG_VERSION });
    const historical = generateFingerprint({ seed: 'catalog-seed', platform: 'host' });
    expect(current.userAgent).toContain('Chrome/156.0.0.0');
    expect(current.userAgentData.fullVersion).toBe('156.0.8078.91');
    expect(current.catalogVersion).toBe(CURRENT_CATALOG_VERSION);
    expect(auditFingerprint(current).consistent).toBe(true);
    expect(historical.userAgent).not.toBe(current.userAgent);
    expect(auditFingerprint(historical).consistent).toBe(true);
  });

  it('升级新增 91 快照后，131 与 73 历史 seed 逐字节不漂移', () => {
    const expected = {
      '131.0.6778.86': {
        'legacy-a': 'd6ae08a87c0d5579b04900df9960a4c62a5c1895e1f83529aa6777bb3c2208d3',
        'catalog-seed': 'd93d6692c2c507fdafc28dc637e649f02e2a3fcc2ce8e9177b29ecb1b9967f36',
      },
      '156.0.8078.73': {
        'legacy-a': 'e54e51549b56f50c75136013ce4d88e647e800d2bb761a9b3fb599f86a6f76d8',
        'catalog-seed': 'c171de1f029b016c6972144faa9acde11f35985bf11a8ebc87dbf9f8a4082ede',
      },
    };
    for (const [catalogVersion, seeds] of Object.entries(expected)) {
      for (const [seed, sha256] of Object.entries(seeds)) {
        const portrait = generateFingerprint({ seed, platform: 'macos', catalogVersion });
        const actual = createHash('sha256').update(JSON.stringify(portrait)).digest('hex');
        expect(actual).toBe(sha256);
      }
    }
  });

  it('缺失快照明确报错，生成与审计均不静默回退', () => {
    expect(() => generateFingerprint({ seed: 'missing', catalogVersion: '999.0.0.0' }))
      .toThrowError(expect.objectContaining({ code: 'E_CATALOG_SNAPSHOT_MISSING' }));
    const current = generateFingerprint({ seed: 'missing', catalogVersion: '156.0.8078.73' });
    expect(() => auditFingerprint({ ...current, catalogVersion: '999.0.0.0' }))
      .toThrowError(expect.objectContaining({ code: 'E_CATALOG_SNAPSHOT_MISSING' }));
  });

  it('业务 overrides 不能偷换 catalog 版本', () => {
    const current = generateFingerprint({
      seed: 'override-version',
      catalogVersion: '156.0.8078.73',
      overrides: { catalogVersion: '999.0.0.0' },
    });
    expect(current.catalogVersion).toBe('156.0.8078.73');
  });
});

it('156 显式平台也不会生成跨系 GPU', () => {
  for (const seed of ['legacy-a', 'legacy-b', 'legacy-c', 'catalog-seed']) {
    const fp = generateFingerprint({ seed, platform: 'macos', catalogVersion: '156.0.8078.73' });
    expect(fp.webgl.renderer).not.toContain('D3D11');
    expect(auditFingerprint(fp).consistent).toBe(true);
  }
});
