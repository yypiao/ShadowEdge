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
  --version 156.0.8078.91 \
  --out packages/fingerprint/catalog/chrome-156.0.8078.91.json
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

## 运行时版本绑定

- 历史环境绑定 `131.0.6778.86` 或 `156.0.8078.73`，当前新建环境绑定 `156.0.8078.91`，与 Chromium 内核版本一致。
- `generateFingerprint({ catalogVersion })` 与 `auditFingerprint()` 按完整版本号加载 `chrome-<version>.json`；缺失或损坏会抛出 `E_CATALOG_SNAPSHOT_MISSING`，不会回退到其他素材。
- 旧快照只读。升级内核时新增快照，只让新环境使用；升级后必须对 131 历史画像与当前版本新画像分别跑真实探针。

```bash
SHADOWEDGE_KERNEL_EXECUTABLE=/path/to/Chromium \
  pnpm probe -- --seed legacy-regression --catalog-version 131.0.6778.86 \
  --label kernel-131 --fail-under 32
SHADOWEDGE_KERNEL_EXECUTABLE=/path/to/Chromium \
  pnpm probe -- --seed current-regression --catalog-version 156.0.8078.91 \
  --label kernel-156 --fail-under 32
```
