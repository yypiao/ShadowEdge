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
