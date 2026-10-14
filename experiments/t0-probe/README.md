# T0 探针裁决实验

对应 `docs/T0_PROBE_REPORT.md` 与 ADR 0004。

## 组成

- `scripts/collect.js` — 页面内指纹采集器（navigator/screen/WebGL/Canvas/Audio/注入痕迹）
- `scripts/experiment-a.mjs` — 实验 A：Patchright + seed 确定性注入，两次启动 + CreepJS
- `scripts/experiment-b.py` — 实验 B：Camoufox 默认配置，两次启动 + CreepJS
- `results/` — 原始数据 JSON

## 实验 A 运行

```bash
npm install
npx patchright install chromium
node scripts/experiment-a.mjs
```

注意：Patchright 的 `page.evaluate` 在隔离 world 执行，主世界采集必须走
`ctx.newCDPSession(page)` + `Runtime.evaluate`（脚本中已示范）。

## 实验 B 运行

```bash
python3.14 -m venv .venv
./.venv/bin/pip install "camoufox[geoip]"
./.venv/bin/python scripts/experiment-b.py
```

### Camoufox 二进制手动安装（GitHub API 限流时）

`camoufox fetch` 依赖 GitHub Releases API，代理出口易被限流。绕过方法：

1. 从 `browser-pin.json` 拿到 tag（如 `v156.0.1-beta.36`），拼直链：
   `https://github.com/daijro/camoufox/releases/download/<tag>/camoufox-<ver>-mac.arm64.zip`
2. 分段并行下载（单连接易被重置）：Range 分 20 片 curl，拼接后 `unzip -t` 校验。
3. 解压到 `~/Library/Caches/camoufox/browsers/official/<version>-<build>/`，
   写 `version.json`（version/build/prerelease/interface:1），
   写 `~/Library/Caches/camoufox/config.json` 的 `active_version`，
   touch `.0.5_FLAG`，`chmod -R 755`。
4. fpgen 指纹模型（1.5MB）首次启动自动下载；失败时重跑
   `python -c "from camoufox.fpgen_model import ensure_fpgen_model; ensure_fpgen_model()"`。
