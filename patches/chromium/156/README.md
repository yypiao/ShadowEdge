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

| #    | 文件                                     | 内容                                                                                                                                                                                          | 验收                                                  |
| ---- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| 0001 | 0001-shadowedge-fingerprint-switch.patch | `--shadowedge-fingerprint=<base64-json>` 开关（content_switches）、随 renderer 进程下发（render_process_host_impl 的 kSwitchNames）、browser 进程早期校验非法值拒启（browser_main_loop Init） | 垃圾值启动 FATAL 拒启；合法值正常启动                 |
| 0002 | 0002-webdriver-always-false.patch        | `Navigator::webdriver()` C++ 层恒 false                                                                                                                                                       | headless/自动化启动下 `navigator.webdriver === false` |

| 0003 | 0003-serviceworker-init-script.patch | `--shadowedge-init-script=<base64-js>` 开关 + renderer 下发 + base64 校验；`WorkerGlobalScope::RunWorkerScript` 在 ServiceWorker 作用域内、SW 自身脚本前求值注入脚本（复用整套 JS 注入层，无第二套指纹逻辑） | SW 内 UA/hc/mem/UA-CH 与画像一致、自有属性为空、探针 SW 4 项全过 |

| 0004 | 0004-screen-webgl-kernel.patch | 新增 `platform/shadowedge_fingerprint.h`（header-only 画像访问器，含 Fnv1a）；`Screen::width/height/avail*/colorDepth` 返回画像值；WebGL `UNMASKED_VENDOR/RENDERER` 返回画像值（Worker OffscreenCanvas 同分支，天然跨世界一致） | 探针 23/23 |
| 0005 | 0005-audio-kernel-noise.patch | `AudioBuffer::getChannelData` 的 **IDL 入口重载**叠加 xorshift 微噪声（每 499 样本、±5e-6），per-buffer 一次性 | 同 156 内核下 JS 与 C++ 注入 audioFp 逐值一致 |
| 0006 | 0006-named-native-tostring.patch | V8 `FunctionPrototypeToString` 仅解包带 ShadowEdge handler 自有标记且 target 为非用户 JS 的 Proxy；普通 Proxy、原型污染、revoked Proxy 保持原行为 | Worker/Blob/Canvas 带名原生串；普通 Proxy 负例与 CreepJS 不回退 |
| 0007 | 0007-network-user-agent-metadata.patch | 浏览器进程从同一画像生成原生 `UserAgentMetadata`，覆盖导航、子资源与 Worker 的 `Accept-CH` 高低熵协商 | 首次请求不偷发高熵头；协商后完整版本、品牌、平台、架构等与画像一致，不泄露真实二进制版本 |
| 0008 | 0008-all-worker-init-script.patch | 将 0003 的 ServiceWorker 原生求值扩展到所有 classic/module Worker 全局作用域；同一脚本在 Worker 自身代码前执行，覆盖 Dedicated、Shared 与嵌套 Worker | 五类真实 Worker 场景画像一致；内核模式不再包装 Worker/Blob/URL，也不携带自引用注入源码 |

**0005 关键教训**：加噪必须放在带 `ExceptionState` 的 IDL 入口重载，而非无异常版——
内部 C++ 路径（如 OfflineAudioContext 渲染结果拷贝）走无异常版，若在空 buffer 上
提前加噪，真实渲染数据 memcpy 时会连噪声一起覆盖，且一次性标记已被消耗。
这对应 JS 版天然特性：proxy 只拦 JS 调用，不拦内部 C++ 调用。

后续：画像的消费（各维度读取）统一从 `CommandLine` 的 `shadowedge-fingerprint`
经 `platform/shadowedge_fingerprint.h` 读取，不各自解析。
0003 提供 ServiceWorker 注入入口，0008 将同一入口扩展到全部 Worker；
chromium-cdp 的 kernel 模式不再走 JS 层 Worker/Blob/URL 包装，Patchright 回退路径保持不变。

## Canvas 决策（T15 收口）

不生成 Canvas C++ 补丁（0006 编号已用于 T16 V8 补丁）。Canvas 继续使用 JS 注入，Screen/WebGL/Audio 才由 0004/0005
接管；不要在 `coveredByKernel` 中添加 `canvas`。同内核专项对照、残余风险和重启条件见
`docs/adr/0005-canvas-stays-js-injection.md`。
