# UA / UA-CH 素材目录

目录快照用于给新环境提供更新的 Chrome UA 与 Client Hints，同时保持旧环境不漂移。

## 更新

联网更新 Chrome stable：

```bash
pnpm update-ua-catalog
```

离线或指定版本（完整版本号必须是 `major.minor.build.patch`）：

```bash
pnpm --filter @shadowedge/fingerprint build
node packages/fingerprint/dist/catalog-cli.js \
  --version 150.0.7339.80 \
  --out packages/fingerprint/catalog/chrome-150.json
```

生成物默认写入 `catalog/chrome-stable.json`，也可以按版本号保存为不可变快照。

## 使用

```ts
import {
  auditFingerprint,
  catalogToGeneratorDb,
  generateFingerprint,
  parseFingerprintCatalog,
} from '@shadowedge/fingerprint';

const catalog = parseFingerprintCatalog(JSON.parse(readFileSync(catalogPath, 'utf8')));
const db = catalogToGeneratorDb(catalog);
const fingerprint = generateFingerprint({ seed, platform: 'host', db });

auditFingerprint(fingerprint, { db });
```

## 漂移约束

- 新版本只能生成新的 catalog 文件，不能修改旧文件。
- 环境需要持久化自己使用的 catalog 版本；审计必须传入同一份 catalog。
- 不要直接向 `DEFAULT_DB` 插入或重排素材；历史 seed 依赖候选池顺序与长度。
