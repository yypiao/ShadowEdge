import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ShadowEdgeError } from '@shadowedge/core';
import { catalogToGeneratorDb, parseFingerprintCatalog } from './catalog.js';
import type { CatalogGeneratorDb, FingerprintCatalog } from './catalog.js';

/** 内嵌 DEFAULT_DB 的历史快照；老环境永远绑定此版本。 */
export const LEGACY_CATALOG_VERSION = '131.0.6778.86';
/** 新环境使用的版本，与当前自研 Chromium 内核保持一致。 */
export const CURRENT_CATALOG_VERSION = '156.0.8078.91';

export interface LoadedFingerprintCatalog {
  catalog: FingerprintCatalog;
  db: CatalogGeneratorDb;
}

/** 同步加载是因为生成/审计 API 本身为同步纯调用；只读仓库内不可变 JSON，不访问网络。 */
export function loadFingerprintCatalog(version: string): LoadedFingerprintCatalog {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(version)) {
    throw missingCatalog(version, '版本号格式无效');
  }
  try {
    const path = fileURLToPath(new URL(`../catalog/chrome-${version}.json`, import.meta.url));
    const catalog = parseFingerprintCatalog(JSON.parse(readFileSync(path, 'utf8')));
    if (catalog.chromeVersion !== version) {
      throw new Error(`快照内容为 ${catalog.chromeVersion}`);
    }
    return { catalog, db: catalogToGeneratorDb(catalog) };
  } catch (error) {
    throw missingCatalog(version, error instanceof Error ? error.message : String(error), error);
  }
}

function missingCatalog(version: string, reason: string, cause?: unknown): ShadowEdgeError {
  return new ShadowEdgeError(
    'E_CATALOG_SNAPSHOT_MISSING',
    `指纹素材快照 ${version} 缺失或损坏，已停止生成/审计，禁止回退最新素材`,
    { details: { catalogVersion: version, reason }, cause },
  );
}
