import type { FingerprintProfile } from '@shadowedge/core';

/**
 * T9「指纹跟随代理」：由代理出口地理推导指纹覆盖项。
 * 平台风控最基本的交叉验证就是 IP 地理 × 时区 × 语言三者一致（T4 闸门的同源规则）。
 */

export interface GeoInput {
  country?: string;
  countryCode?: string;
  timezone?: string;
  latitude?: number;
  longitude?: number;
}

/** 国家码 → 语言列表。只覆盖主流电商市场，未知国家回退英语（最低识别度假设）。 */
const COUNTRY_LANGUAGES: Record<string, string[]> = {
  US: ['en-US', 'en'],
  GB: ['en-GB', 'en'],
  DE: ['de-DE', 'de', 'en-US'],
  FR: ['fr-FR', 'fr', 'en-US'],
  IT: ['it-IT', 'it', 'en-US'],
  ES: ['es-ES', 'es', 'en-US'],
  NL: ['nl-NL', 'nl', 'en-US'],
  JP: ['ja-JP', 'ja'],
  KR: ['ko-KR', 'ko'],
  CN: ['zh-CN', 'zh'],
  HK: ['zh-HK', 'zh', 'en-US'],
  TW: ['zh-TW', 'zh'],
  SG: ['en-SG', 'en', 'zh-CN'],
  MY: ['ms-MY', 'ms', 'en-US'],
  TH: ['th-TH', 'th'],
  VN: ['vi-VN', 'vi'],
  PH: ['en-PH', 'en'],
  ID: ['id-ID', 'id'],
  BR: ['pt-BR', 'pt'],
  MX: ['es-MX', 'es'],
  CA: ['en-CA', 'en', 'fr-CA'],
  AU: ['en-AU', 'en'],
  AE: ['ar-AE', 'ar', 'en-US'],
  RU: ['ru-RU', 'ru'],
  PL: ['pl-PL', 'pl'],
  SE: ['sv-SE', 'sv'],
  TR: ['tr-TR', 'tr'],
  IN: ['en-IN', 'en', 'hi-IN'],
};

/**
 * 由出口地理推导覆盖项：时区直接采用，语言按国家映射，
 * 地理坐标在出口城市坐标上加 ±0.05° 抖动（同一城市内的居民分布，非精确点）。
 * 抖动由坐标本身确定性推导，同一出口每次结果一致，避免画像漂移。
 */
export function deriveGeoOverrides(geo: GeoInput): Partial<FingerprintProfile> {
  const overrides: Partial<FingerprintProfile> = {};

  if (geo.timezone) overrides.timezone = geo.timezone;

  const code = geo.countryCode?.toUpperCase();
  if (code && COUNTRY_LANGUAGES[code]) {
    overrides.languages = COUNTRY_LANGUAGES[code];
  } else {
    overrides.languages = ['en-US', 'en'];
  }

  if (geo.latitude !== undefined && geo.longitude !== undefined) {
    // 确定性抖动：取坐标小数部分做哈希源，±0.05° ≈ 5km 半径
    const jitterSeed = Math.abs(geo.latitude * 1000 + geo.longitude * 7);
    const jitterLat = ((jitterSeed % 1) - 0.5) * 0.1;
    const jitterLon = (((jitterSeed * 1.618) % 1) - 0.5) * 0.1;
    overrides.geolocation = {
      latitude: Number((geo.latitude + jitterLat).toFixed(5)),
      longitude: Number((geo.longitude + jitterLon).toFixed(5)),
      accuracy: 50,
    };
  }

  return overrides;
}
