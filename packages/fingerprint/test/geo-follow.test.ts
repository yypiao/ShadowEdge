import { describe, expect, it } from 'vitest';
import { deriveGeoOverrides } from '../src/geo-follow.js';
import { generateFingerprint } from '../src/index.js';

describe('指纹跟随代理（T9）', () => {
  it('德国出口：时区直通 + 德语优先 + 坐标带确定性抖动', () => {
    const o = deriveGeoOverrides({ countryCode: 'DE', timezone: 'Europe/Berlin', latitude: 50.1109, longitude: 8.6821 });
    expect(o.timezone).toBe('Europe/Berlin');
    expect(o.languages?.[0]).toBe('de-DE');
    expect(o.geolocation).toBeDefined();
    expect(Math.abs(o.geolocation!.latitude - 50.1109)).toBeLessThanOrEqual(0.05);
    expect(Math.abs(o.geolocation!.longitude - 8.6821)).toBeLessThanOrEqual(0.05);
    expect(o.geolocation!.accuracy).toBe(50);
  });

  it('同一出口多次推导结果完全一致（防画像漂移）', () => {
    const geo = { countryCode: 'GB', timezone: 'Europe/London', latitude: 51.5074, longitude: -0.1278 };
    expect(deriveGeoOverrides(geo)).toEqual(deriveGeoOverrides(geo));
  });

  it('未知国家回退英语，坐标缺省则不产出 geolocation', () => {
    const o = deriveGeoOverrides({ countryCode: 'XX', timezone: 'Etc/UTC' });
    expect(o.languages).toEqual(['en-US', 'en']);
    expect(o.geolocation).toBeUndefined();
  });

  it('覆盖项参与画像生成且通过一致性自检', () => {
    const overrides = deriveGeoOverrides({ countryCode: 'DE', timezone: 'Europe/Berlin', latitude: 50.1, longitude: 8.68 });
    const fp = generateFingerprint({ seed: 't9-test', overrides });
    expect(fp.timezone).toBe('Europe/Berlin');
    expect(fp.languages[0]).toBe('de-DE');
    expect(fp.geolocation?.latitude).toBeCloseTo(overrides.geolocation!.latitude, 4);
  });
});
