import type { FingerprintProfile } from '@shadowedge/core';

/**
 * 生成与画像 UA/UA-CH 同源的请求头。
 * Chromium 的 HTTP Client Hints 不受页面 JS 注入影响，必须由浏览器上下文覆盖；
 * 否则服务端看到内核真实版本，页面内看到画像版本，直接构成矛盾。
 */
export function buildClientHintHeaders(fp: FingerprintProfile): Record<string, string> {
  const brands = fp.userAgentData.brands
    .map(({ brand, version }) => `"${brand}";v="${version}"`)
    .join(', ');
  return {
    'sec-ch-ua': brands,
    'sec-ch-ua-mobile': fp.userAgentData.mobile ? '?1' : '?0',
    'sec-ch-ua-platform': `"${fp.userAgentData.platform}"`,
  };
}
