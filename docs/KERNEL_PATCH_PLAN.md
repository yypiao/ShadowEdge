# Chromium 内核补丁执行方案

目标：解决 JS 注入无法彻底消除的两类差距，并与紫鸟 EngTk2 的内核能力对齐。

1. Dedicated / Shared / Service / Nested Worker 等独立作用域的指纹注入。
2. `Function.prototype.toString.call(nativeFn)` 返回带函数名的原生串。

## 1. 基线原则

- 固定 Chromium 主版本与 commit，不允许 `main` 漂移后直接出包。
- 所有补丁放在 `patches/chromium/<version>/`，按顺序编号，可独立 rebase。
- 画像只通过一个入口传入：启动参数 `--shadowedge-fingerprint=<base64-json>`。
- 渲染进程、Worker、ServiceWorker 共用同一份画像，禁止各自读不同来源。
- 补丁只读取画像，不调用 `Math.random()` / `Date.now()` 参与指纹值计算。

## 2. 补丁点

### P0 启动参数与画像解析

- 新增 `content/public/common/content_switches.cc` 的 `shadowedge-fingerprint`。
- 在浏览器进程解析并校验画像，再随 renderer / worker 进程参数下发。
- 解析失败直接拒绝启动，避免半套画像进入页面。

### P1 自动化痕迹

- `third_party/blink/renderer/core/frame/navigator.cc`：`webdriver` 恒为 false。
- 保留 `--disable-blink-features=AutomationControlled` 之外的自动化开关清理。
- `navigator.plugins` / `mimeTypes` 使用真实 Chrome 的 PDF Viewer 结构。

### P2 Worker / ServiceWorker

- `third_party/blink/renderer/core/workers/worker_navigator.cc`：UA、platform、语言、硬件。
- `third_party/blink/renderer/core/workers/worker_global_scope.cc`：0003 + 0008 在 classic/module
  Worker 自身代码前原生求值同一注入脚本，覆盖 Dedicated / Shared / Service / Nested Worker。
- `third_party/blink/renderer/core/workers/worker_navigator_ua_data.cc`：Worker UA-CH。

验收：classic/module Dedicated Worker、SharedWorker、ServiceWorker 与 Blob 嵌套 Worker
内读取 UA、UA-CH、核数、GPU 与主世界一致，且 `Object.getOwnPropertyNames(navigator)` 为空；
kernel 模式不再生成 JS Worker/Blob/URL 包装。

### P3 Screen / WebGL / Audio（已完成）；Canvas（暂缓）

- `third_party/blink/renderer/modules/webaudio/audio_buffer.cc`：浮点样本微扰（0005）。
- `third_party/blink/renderer/modules/webgl/webgl_rendering_context_base.cc`：vendor/renderer（0004）。
- `third_party/blink/renderer/core/frame/screen.cc`：宽高、可用区、色深、pixelDepth（0004）。
- **Canvas C++ 下沉暂不做**：`html_canvas_element.cc` / `canvas_rendering_context_2d.cc`
  不下沉，保留现有确定性 JS 注入，不在 `coveredByKernel` 声明 `canvas`。
  同内核专项对照 20/20；证据、收益边界及重新评估触发条件见 ADR 0005。
  若未来重启，必须同时复现纯色保护、纹理判定、幂等缓存与 alpha 混合语义，
  不能只实现随机像素扰动。

### P4 带名原生 Function.prototype.toString（已完成，0006）

- 入口：V8 `FunctionPrototypeToString`；禁止 JS 层全局 patch。
- 采用 handler 自有标记 + 原生 target 受控解包，不做全局 Proxy 解包，不复制名称表。
- `LookupIterator::OWN` 防原型污染；用户 JS target 永不解包，避免源码泄漏。
- 验收已达：Worker 返回 `function Worker() { [native code] }`，普通/Revoked Proxy
  保持匿名原生串，CreepJS 0%/0%，os1 全量 40/40。设计与报告见 ADR 0006。

### P5 网络层 UserAgentMetadata（0007）

- `components/embedder_support/user_agent_utils.cc`：浏览器进程从同一画像生成
  原生 `UserAgentMetadata`，覆盖 `Accept-CH` 协商后的完整版本列表、平台版本、
  架构、位宽、型号与 form-factors。
- 保留 Chromium 原生协商语义：首次请求只发送低熵头，不无条件附加全部高熵头。
- 验收使用本地真实服务端比较首跳/次跳请求；页面 UA-CH 与服务端高低熵头必须同源，
  历史画像不得泄露当前自研二进制的真实完整版本。

### P6 一次性启动令牌（0009）

- 主进程在每次启动时生成随机 256 位 KEK、随机 DEK/IV 与 nonce，复用
  `EnvelopeCrypto` 的 `auth-token` 用途生成 30 秒短期信封令牌。
- 密文令牌经 `--shadowedge-launch-token` 传入；KEK 只经本次子进程环境
  `SHADOWEDGE_LAUNCH_KEK` 传递，不写磁盘、不编入应用或内核。
- 浏览器进程在 `BrowserMainLoop::Init()` 用 BoringSSL AES-256-GCM 解封并校验版本、
  nonce、签发时间与过期时间，然后立即清除 KEK 环境变量。缺失、错密钥、篡改或过期均拒启。
- 该机制防止无 launcher 的直接浏览器启动，不等同于内核文件完整性签名，也不宣称抵御
  已控制本机账户的逆向或内存读取。分发包哈希/签名属于 T17B。

## 3. 构建流水线

```bash
# 一次性环境
fetch --nohooks chromium
cd src && ./build/install-build-deps.sh

# 固定版本
git checkout <pinned-chromium-tag>
gclient sync --with_branch_heads --with_tags

# 应用补丁
for patch in patches/chromium/<version>/*.patch; do git apply "$patch"; done

# 构建
gn gen out/ShadowEdge --args='
  is_debug=false
  symbol_level=0
  is_component_build=false
  enable_nacl=false
  blink_symbol_level=0
'
autoninja -C out/ShadowEdge chrome
```

产物：`out/ShadowEdge/Chromium.app`（macOS）/ `chrome`（Linux）。签名、公证和自动更新不在本仓库处理。

## 4. 验证与发布门槛

1. `pnpm typecheck && pnpm test` 全绿。
2. `pnpm probe -- --seed kernel-check --proxy os1 --fail-under 40` 全绿（Patchright 回退为 31）。
3. CreepJS：`0% headless`、`0% stealth`。
4. 全 Worker 探针：classic/module/shared/service 与嵌套 Worker 的 UA/UA-CH/GPU/核数与主世界一致。
5. `Function.prototype.toString.call` 命名原生串检查通过。
6. 同一 `seed` 在 JS 版本与内核版本产出完全相同的画像值。

## 5. 工程边界

- 不把 Chromium 源码放进主仓库；主仓库只存补丁、构建参数和校验脚本。
- 不允许在补丁里引入网络请求、遥测或账号数据。
- 补丁失败时回退到现有 Patchright 驱动，并明确标记 `kernel: chromium-cdp`。
