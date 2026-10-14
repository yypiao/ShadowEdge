# 紫鸟内核补丁技术清单（基于静态逆向）与 ShadowEdge 实现对照

- 日期：2026-09-18
- 依据：对 `chrome_64_150.1.4.103_darwin_ziniaobrowser` 的 Mach-O 符号/字符串分析
- 说明：符号表已 strip，以下来自残留源码路径、mojom 接口名、JSON 键名与日志串，属机制级推断，非逐行还原
- 配套：整体架构见 `RESEARCH_ZINIAO_RE.md`，路线决策见 `adr/0003-open-source-kernel-drivers.md`

## 0. 补丁组织方式（最重要的架构发现）

紫鸟没有把改动散落在 Chromium 各处，而是作为一个独立第三方目录整体注入：

```
third_party/superBrowser/src/
  chrome/browser/response_monitor/      # 网络响应监控（URLonload 前拦截）
  chrome/browser/ui/views/              # 自有 UI 气泡
  chrome/renderer/response_monitor/     # 渲染端 throttle
  client_invoke/sb_client_invoke.cpp    # 外部调用入口（自动化/RPA 桥）
  components/policy/policy_loader.cc    # 企业策略下发
  dialog/                               # 原生对话框
  service/
    sbipc_mojo_impl.cpp                 # Mojo IPC 实现
    super_ipc.cpp                       # IPC 总线
    ip_checker.cpp                      # IP 校验（代理一致性）
```

指纹数据**不是硬编码进二进制**，而是运行期由数据文件提供：二进制中存在
`FingerprintDataLoader`、`getFingerprints`、JSON 键 `seed` —— 即「内核补丁负责 hook，
画像内容由云端/本地数据按环境下发」。这与 ShadowEdge「seed → 画像参数 → 启动注入」的设计同构。

## 1. 指纹伪造：渲染进程 IPC 拉取模式

补丁新增一组 Mojo 接口（Chromium 的进程间通信 IDL，编译为 `.mojom`）：

| 接口 | 位置 | 职责 |
| --- | --- | --- |
| `sbipcFactory` | 全局 | 通道工厂 |
| `sbipcInBrowser` / `sbipcInChild` | 浏览器进程/子进程 | 浏览器侧能力，如 `getExtraPermissionsById` |
| `sbipcNetworkHost` | 网络服务 | 网络层伪装（代理/DNS/出口一致性） |
| `sbipcRendererClient` | 渲染进程 | 渲染端拉取指纹数据 |
| `sbipcRendererHost` | 浏览器进程 | 响应渲染端请求，从 FingerprintDataLoader 取数据 |

已确认的渲染端方法：

- `sbipcRendererClient::getCanvasFingerprintingData`
- `sbipcRendererClient::getWebGLFingerprintingData`

工程含义：渲染进程在执行 Canvas/WebGL API 时，**同步向浏览器进程请求该环境的伪造数据**
（日志前缀 `fp_stack:` 是指纹调用栈记录）。好处：

- 同一环境的所有标签页/Worker 拿到的值强一致（数据源在浏览器进程单点）；
- 伪造数据不落地渲染进程，按环境隔离；
- Canvas/WebGL 之外，从数据键名可确认覆盖维度：

| 维度 | 证据（二进制中的键/符号） |
| --- | --- |
| Canvas 2D | `AddCanvasFingerprint`、`getCanvasFingerprintingData`、`"canvas"` |
| WebGL | `AddWebGLFingerprint`、`getWebGLFingerprintingData`、`webgl_allowed/blocked/status` |
| AudioContext | `"audio"`、`"audioBuffer"`、`"audioBufferParams"`、`"audioConstraints"`、`"audioStreamOptions"` |
| 字体 | `"font"`、`"fontFamily"`、`"fontId"`、`"fontSettings"`、`"fontSize"` |
| 屏幕 | `"screen"`、`screenMagnifier`、`screenLockSecured` |
| 区域 | `"locale"` |
| 渲染帧率 | `"fps"` |
| 种子 | `"seed"`（确定性来源） |

字符串中未见 `hardwareConcurrency`/`deviceMemory`/`timezone` 的私有键——这些维度大概率
走 Chromium 原生开关（如 `Emulation.setGeolocationOverride` 等 CDP 通道）或数据键命名不同，
需动态分析才能最终确认。

## 2. 网络层：代理一致性与响应监控

- `service/ip_checker.cpp` + `sbipcNetworkHost`：在网络服务进程内做出口 IP 校验，
  配合本地 Xray 网关保证「指纹国家/时区/语言 ↔ 出口 IP 地理」一致（对标语义：IP 不符即拒绝启动）。
- `response_monitor/*`（browser + renderer 双端 throttle）：在 URL 加载管线中插入
  URLLoaderThrottle，按云端 JSON 规则（URL regex + content-type + 计数）匹配响应体
  （`ResponseMonitorBodyReader`），命中后上报（`rule matched`/`count exceeded`）。
  用途是平台风控页面/探测请求的识别与采集，是「理解平台怎么检测」的数据通道。

## 3. 权限、策略与管控

- `components/policy/policy_loader.cc`：把 Chromium 企业策略体系拿来做环境策略下发
  （禁功能、锁配置），比自己 hook 设置项更稳，随上游升级不易碎。
- `sbipcInChild::getExtraPermissionsById`：按环境/权限组动态调整 API 权限
  （摄像头/麦克风/通知等），对应团队版「操作员最小权限」。

## 4. 自动化桥

- `client_invoke/sb_client_invoke.cpp`：外部进程调用内核的统一入口（RPA/魔改 webdriver 经此进入）。
- 内核随附 16.9MB 魔改 `webdriver`（WebDriver BiDi/CDP 服务），自动化痕迹在驱动与内核双侧消除。
- `dialog/superbrowser_message_box.cc`、`ui/views/superbrowser_webview_bubble_view.cc`：
  原生对话框/气泡替换（文件选择、授权确认等场景的自动化接管）。

## 5. 品牌与分发

- WebAuthn 内部 origin 全部改名（`org.ZiXun.ziniaobrowser.*`），说明补丁深入 components 层。
- 内核运行时热更新：`env-kit/Core/chrome_64_<version>/` + `.etag`，外壳与内核版本解耦。
- 数据目录 `.identify`（32 字节）：设备标识文件。

## 6. ShadowEdge 实现对照（哪些要做、用什么做）

| 紫鸟部件 | 是否需要复刻 | ShadowEdge 做法 |
| --- | --- | --- |
| Canvas/WebGL/Audio/字体 hook | 要，但不写 C++ | **Camoufox 已在 C++/Rust 层覆盖**；验收见探针矩阵 |
| 指纹数据按环境加载（seed → 数据） | 自研（薄） | `packages/fingerprint`：seed 派生 BrowserForge 画像 → Camoufox 启动配置；`FingerprintDataLoader` 对应我们的 profile repository |
| 渲染/浏览器进程一致单点 | 架构已保证 | Camoufox 配置在内核启动时注入，天然全标签页/Worker 一致 |
| `ip_checker` 出口一致性 | 自研 | `packages/proxy`：启动前查出口 IP 地理，与时区/语言/Accept-Language 交叉校验（T 系列任务之一） |
| Xray 本地网关 | 集成 | Xray-core 开源替代，按环境出站分流，凭据走 crypto 保险箱 |
| response_monitor 风控采集 | 二期自研 | 有差异化价值：用 CDP 响应监听做「平台探针识别」，无需 C++；先不做 |
| policy_loader 环境策略 | 二期 | 桌面端 RBAC + 启动参数白名单即可覆盖 80% |
| sb_client_invoke + 魔改 webdriver | 不做魔改驱动 | Camoufox 由 Playwright 直连；`packages/rpa` 在其上做编排与人类化 |
| 品牌/origin 改名 | 不做 | 改名不是反检测能力，反而增加维护面 |
| 内核热更新 | 一期做 | 下载器 + etag/版本校验的思路直接借鉴（`env-kit/Core` 布局） |

## 7. 结论

紫鸟真正的技术含量集中在三点：(1) Blink 层 Canvas/WebGL/Audio/字体 hook；
(2) 指纹数据按环境运行期注入、渲染进程 IPC 拉取保证强一致；(3) 网络进程内的 IP 一致性校验。
其中 (1) 由 Camoufox 承接，(2)(3) 正是 ShadowEdge 要在 `fingerprint`/`proxy`/`kernel`
里自研的部分——而且都在 Node 层，不需要维护 Chromium fork。
