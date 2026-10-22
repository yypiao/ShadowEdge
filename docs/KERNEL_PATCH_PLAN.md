# Chromium 内核补丁执行方案

目标：解决 JS 注入无法彻底消除的两类差距，并与紫鸟 EngTk2 的内核能力对齐。

1. ServiceWorker 等独立作用域的指纹注入。
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
- `third_party/blink/renderer/core/workers/worker_global_scope.cc`：Worker 全局补充。
- `third_party/blink/renderer/core/workers/service_worker_global_scope.cc`：ServiceWorker 同源画像。
- `third_party/blink/renderer/core/workers/worker_navigator_ua_data.cc`：Worker UA-CH。

验收：Worker / SharedWorker / ServiceWorker 内读取 UA、UA-CH、核数、GPU 与主世界一致，
且 `Object.getOwnPropertyNames(navigator)` 为空。

### P3 Canvas / Audio / WebGL / Screen

- `third_party/blink/renderer/core/html/canvas/html_canvas_element.cc`：`toDataURL` 确定性噪声。
- `third_party/blink/renderer/core/html/canvas/canvas_rendering_context_2d.cc`：`getImageData` 返回副本。
- `third_party/blink/renderer/modules/webaudio/audio_buffer.cc`：浮点样本微扰。
- `third_party/blink/renderer/modules/webgl/webgl_rendering_context_base.cc`：vendor/renderer。
- `third_party/blink/renderer/core/frame/screen.cc`：宽高、可用区、色深、pixelDepth。

### P4 带名原生 Function.prototype.toString

这是独立研究项，不要在 JS 层全局 patch：

- 入口在 V8 `Function.prototype.toString` 的 native 实现，Proxy 没有原生函数名。
- 可行方向是给 ShadowEdge 包装的原生函数维护一张“原生名称表”，在 V8 序列化时回填名称；
  或在 Blink 侧避免 Proxy，直接返回真正的原生函数对象并携带内部指纹上下文。
- 验收：`Function.prototype.toString.call(Worker)` 返回 `function Worker() { [native code] }`，
  且 CreepJS stealth 仍为 0%。

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
2. `pnpm probe -- --seed kernel-check --proxy os1 --fail-under 27` 全绿。
3. CreepJS：`0% headless`、`0% stealth`。
4. ServiceWorker 探针：UA/UA-CH/GPU/核数与主世界一致。
5. `Function.prototype.toString.call` 命名原生串检查通过。
6. 同一 `seed` 在 JS 版本与内核版本产出完全相同的画像值。

## 5. 工程边界

- 不把 Chromium 源码放进主仓库；主仓库只存补丁、构建参数和校验脚本。
- 不允许在补丁里引入网络请求、遥测或账号数据。
- 补丁失败时回退到现有 Patchright 驱动，并明确标记 `kernel: chromium-cdp`。
