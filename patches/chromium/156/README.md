# patches/chromium/156 — Chromium 156.x 补丁集

## 编号规范

- 文件名：`NNNN-<slug>.patch`，从 `0001` 起按 apply 顺序编号，不留空洞。
- 每个补丁必须能独立 `git apply --check` 通过；补丁之间的依赖必须在文件头注释说明。
- 一行一个补丁的索引维护在本文件下方「补丁索引」。

## rebase 流程（升级 Chromium 版本时）

1. 新建 `patches/chromium/<new-major>/`，复制本目录。
2. 在内核源码树：`git checkout <new-tag>` 后逐个 `git apply --check`，
   失败的补丁用 `git apply --3way` 落进去再 `git diff` 重新导出。
3. 全部通过后更新根目录 `chromium.version` 的 tag，并在 PR 里附探针回归报告。

## 画像入口约定

所有补丁只从 `--shadowedge-fingerprint=<base64-json>` 读取画像；
禁止补丁内使用 `Math.random()` / `Date.now()` 参与指纹值（AGENTS.md §4）。

## 补丁索引

| # | 文件 | 内容 | 验收 |
| --- | --- | --- | --- |
| 0001 | 0001-shadowedge-fingerprint-switch.patch | `--shadowedge-fingerprint=<base64-json>` 开关（content_switches）、随 renderer 进程下发（render_process_host_impl 的 kSwitchNames）、browser 进程早期校验非法值拒启（browser_main_loop Init） | 垃圾值启动 FATAL 拒启；合法值正常启动 |
| 0002 | 0002-webdriver-always-false.patch | `Navigator::webdriver()` C++ 层恒 false | headless/自动化启动下 `navigator.webdriver === false` |

| 0003 | 0003-serviceworker-init-script.patch | `--shadowedge-init-script=<base64-js>` 开关 + renderer 下发 + base64 校验；`WorkerGlobalScope::RunWorkerScript` 在 ServiceWorker 作用域内、SW 自身脚本前求值注入脚本（复用整套 JS 注入层，无第二套指纹逻辑） | SW 内 UA/hc/mem/UA-CH 与画像一致、自有属性为空、探针 SW 4 项全过 |

后续：画像的消费（各维度读取）在 T15 补丁中按模块接入，统一从
`CommandLine` 的 `kShadowEdgeFingerprint` 解析，不各自读文件。
Dedicated/Shared Worker 仍走 JS 层 Worker 包装注入；0003 目前只对
`IsServiceWorkerGlobalScope()` 生效，刻意控制爆炸半径。
