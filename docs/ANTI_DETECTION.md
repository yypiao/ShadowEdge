# 反检测技术方案

## 1. 为什么最终不能只靠 JS 注入

主流指纹浏览器（含紫鸟部分维度）用 `Page.addScriptToEvaluateOnNewDocument` 注入脚本覆写 `navigator` 属性。这种方案的暴露点：

1. **函数 toString 泄露** —— 被覆写的原生函数 `Function.prototype.toString` 结果异常，探针一测就露。
2. **原型链痕迹** —— `Object.getOwnPropertyDescriptor` 可看出属性从 getter 变成 value，或 descriptor 的 `configurable` 异常。
3. **执行时序竞争** —— 注入脚本在页面首个 script 之前执行不总是可靠，iframe / worker 场景经常漏覆盖。
4. **Worker 上下文逃逸** —— `new Worker()`、`SharedWorker`、`ServiceWorker` 有独立全局对象，JS 注入难以全覆盖，探针在 Worker 里读原始值即可穿透。
5. **CDP 自身痕迹** —— `Runtime.enable` 会让 `console` 行为变化，`Error.stack` 出现异常帧。

ShadowEdge 分两阶段推进：当前阶段以 **Patchright + 主世界 init script** 为唯一主驱动，
先在不引入 C++ 工具链的前提下把可检测面压到第三方探针可接受的水平；高风控场景再升级到
**Chromium 源码级补丁**，在 C++ 层拦截 Blink API，从渲染引擎内部返回画像值。两条路线共享同一份
`FingerprintProfile` 和探针矩阵，迁移时不允许破坏 seed 可复现性。

## 2. C++ 内核阶段补丁清单

以下为阶段二目标，不代表当前 Patchright 路线已经完成；当前已落地的过渡能力见 §6。

### 2.1 自动化痕迹清除

| 目标                           | 补丁位置                                             | 做法                                                |
| ------------------------------ | ---------------------------------------------------- | --------------------------------------------------- |
| `navigator.webdriver`          | `third_party/blink/renderer/core/frame/navigator.cc` | 直接返回 `false`，移除 `--enable-automation` 的联动 |
| `window.cdc_*` 变量            | ChromeDriver 注入点                                  | 不使用 ChromeDriver，改用直连 CDP                   |
| `Runtime.enable` 痕迹          | `content/renderer/`                                  | 延迟启用，或用 isolated world 执行                  |
| `--enable-automation` infobar  | `chrome/browser/ui/`                                 | 移除 switch 检测                                    |
| `navigator.plugins` 为空       | `navigator_plugins.cc`                               | 注入符合真实 Chrome 的 PDF Viewer 等 5 项           |
| `navigator.mimeTypes` 为空     | 同上                                                 | 与 plugins 对应填充                                 |
| `Notification.permission` 异常 | permission 模块                                      | headless 下返回 `default` 而非 `denied`             |
| `chrome.runtime` 缺失          | `extensions/renderer/`                               | 保留最小 `chrome` 对象骨架                          |

### 2.2 指纹维度伪造

| 维度         | 拦截点                                                | 策略                                                             |
| ------------ | ----------------------------------------------------- | ---------------------------------------------------------------- |
| Canvas 2D    | `CanvasRenderingContext2D::getImageData`, `toDataURL` | 按 seed 对纹理像素施加确定性微扰；纯色块/边界保持原样，无落点时直接走原生编码 |
| WebGL        | `WebGLRenderingContext::getParameter`                 | 替换 `VENDOR`/`RENDERER`/`UNMASKED_*`；`readPixels` 施加噪声     |
| AudioContext | `AudioBuffer::getChannelData`, `AnalyserNode`         | 对浮点样本乘以 seed 派生的极小系数                               |
| ClientRects  | `Element::getBoundingClientRect`                      | 对返回值加 seed 派生的亚像素偏移                                 |
| 字体枚举     | `FontCache::GetFontData`                              | 仅命中白名单字体，其余回退默认字体                               |
| WebRTC       | `PeerConnection` ICE 候选生成                         | 用代理出口 IP 替换本地候选，或完全禁用 mDNS 候选                 |
| 时区         | `blink::TimeZoneController`                           | 从环境配置读取，不读系统时区                                     |
| 语言         | `Navigator::languages`                                | 从环境配置读取                                                   |
| 地理位置     | Geolocation service                                   | 返回代理出口 IP 对应坐标                                         |
| 硬件参数     | `Navigator::hardwareConcurrency`, `deviceMemory`      | 从环境配置读取                                                   |
| 媒体设备     | `MediaDevices::enumerateDevices`                      | 返回配置的虚拟设备列表，deviceId 由 seed 派生                    |
| Battery      | `BatteryManager`                                      | 返回配置值                                                       |
| Screen       | `Screen::width` 等                                    | 从环境配置读取，且 `availHeight` 需减去合理任务栏高度            |

### 2.3 一致性闸门

**指纹伪造最常见的翻车不是某一项被识破，而是各项互相矛盾。** 平台风控看的是组合合理性：

- UA 说 Windows，但 `navigator.platform` 是 `MacIntel` → 立刻判定异常。
- UA 说 Chrome 131，但 Client Hints `fullVersion` 是 130 → 异常。
- 时区 `Asia/Shanghai`，但代理出口在美国 → 异常。
- 屏幕 `1920x1080` 但 `availHeight` 也是 `1080`（无任务栏）→ 可疑。
- WebGL renderer 是 Apple M1，但 UA 是 Windows → 异常。
- `maxTouchPoints > 0` 但 macOS 平台 → 异常。

`auditFingerprint()` 在启动前强制校验这些交叉约束，不通过则拒绝启动并抛 `E_FINGERPRINT_INCONSISTENT`。这是相对竞品的关键增强 —— 宁可不启动，也不要用一个自相矛盾的身份去登录。

## 3. 代理与网络层

- **DNS 全走代理** —— `--proxy-server` 配合 `--host-resolver-rules` 防止 DNS 泄露暴露真实 ISP。
- **QUIC 禁用** —— `--disable-quic`，避免 UDP 绕过 HTTP 代理。
- **出口地理对齐** —— 启动前用 `ProxyHealth.geo` 校正环境的 timezone / languages / geolocation。
- **IP 质量风控** —— 出口 IP 若被标记为数据中心或黑名单，启动前告警。
- **链式代理** —— `upstreamId` 支持住宅代理 + 中转的双跳，隐藏中转机房特征。

## 4. 行为层（Phase 4+）

指纹过关后，平台风控的下一层是行为特征。RPA 引擎需要：

- 鼠标轨迹用贝塞尔曲线而非直线跳转
- 输入速度带人类化抖动（80–260ms 间隔，含偶发退格）
- 页面停留时长符合对数正态分布
- 滚动带惯性与回弹

## 5. 验证方法

`experiments/probes/run.mjs` 跑真实产品链路，并用 CreepJS / BrowserLeaks / Pixelscan 交叉验证：

1. **唯一性** —— 100 个环境的指纹哈希两两不同。
2. **稳定性** —— 同一环境重启 20 次，指纹哈希不变。
3. **一致性** —— 交叉约束全部满足。
4. **隐蔽性** —— 第三方检测站（CreepJS / BrowserLeaks / Pixelscan 等）无自动化告警。
5. **隔离性** —— 环境间 Cookie / Storage / IP 互不可见。

## 6. 探针回归实测记录（2026-10-21，os1 德国双跳链路）

基线报告：
- os1 德国：`experiments/probes/results/os1-final-audit-1792553903844.json`，seed `ps-final-audit`，**27/27**。
- os2 英国：`experiments/probes/results/os2-final-audit-1792554019160.json`，seed `ps-final-audit`，**27/27**。

通过 `pnpm probe -- --seed <seed> --proxy os1|os2 --label <name>` 复现。

| 观测点                                   | 结果                                                                       |
| ---------------------------------------- | -------------------------------------------------------------------------- |
| CreepJS                                  | `0% headless`、`38% like headless`、`0% stealth`、`lies = 0`               |
| BrowserLeaks                             | 无 WebRTC 本机 IP 或非出口公网 IP 泄漏                                     |
| Pixelscan Browser / Location / Bot check | 全部通过                                                                   |
| Pixelscan Fingerprint                    | `No masking detected`                                                      |
| Pixelscan Proxy                          | `Proxy detected`：os1/os2 为静态住宅/ISP 代理，ip-api 显示 `hosting=false`、`proxy=false`；Pixelscan 仍按代理检测库单独标记，不伪造绕过 |
| Pixelscan 综合                           | `nonProxyConsistent = true`（除代理类型外所有非代理因素一致）              |

本轮修复的深层问题：

| 漏洞                | 现象                                                                                             | 修复                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Worker 源码读取失败 | Pixelscan 禁止同步 XHR 读取 `blob:` URL，旧包装静默回退，Worker 暴露真实 `Chrome/156 + Apple M4` | 在 `Blob` 构造与 `URL.createObjectURL()` 时登记源码，Worker 构造直接取用；不再依赖 XHR                    |
| Worker GPU 裸奔     | Worker 无 `WebGLRenderingContext` 全局构造器，OffscreenCanvas 返回的上下文未被覆盖               | 包装 `OffscreenCanvas.prototype.getContext`，从实例原型套用 WebGL spoof；兼容 `WorkerNavigator.prototype` |
| Canvas 噪声可被回读 | 持久修改原画布会让重复读取累积漂移，并可能破坏纯色检测块                                         | `toDataURL` 先做 8×8 网格纯色采样；纯色直接原生编码；纹理才复制到临时画布，并只在 5×5 邻域颜色数 ≥5 的位置落点；`getImageData` 只改返回副本 |
| UA / UA-CH 不一致   | HTTP Client Hints 不受页面 JS 注入影响，服务端看到内核真实版本                                   | `buildClientHintHeaders()` 覆盖 `sec-ch-ua*`；页面侧 `userAgentData` 与 UA 同源、稳定对象、高熵接口补齐   |
| Navigator 伪造痕迹  | 属性挂在 `navigator` 实例上，`Object.getOwnPropertyNames(navigator)` 非空                        | 全部属性定义到 `Navigator.prototype` / `WorkerNavigator.prototype`                                        |
| SDP 候选泄漏        | 只过滤 ICE 事件时，`localDescription.sdp` 仍含 host/srflx IP；mDNS 候选因正则只认 IP 字符集而漏删 | 同步过滤 `c=` 与 `a=candidate` 行；地址匹配改为 `[^\s]+`，覆盖带连字符的 mDNS；`0.0.0.0` / `::` 归为 unspecified |
| 包装函数 toString   | Worker / SharedWorker 包装器暴露源码；Proxy 默认返回 32 字符匿名原生串，Pixelscan C14 直接判失败   | Proxy 增加 `toString` / `name` get 陷阱：`fn.toString()` 返回带名原生串（`toDataURL` 为 38 字符），`Function.prototype.toString.call` 仍不泄漏源码 |
| Worker 注入中断     | Canvas 噪声代码在 Worker 中引用不存在的 `CanvasRenderingContext2D`，整段 Worker 注入抛错并超时    | 给 Canvas 原型方法循环加 `typeof CanvasRenderingContext2D !== "undefined"` 守卫                              |
| Screen 实例属性     | `screen` 被挂成实例自有属性，`Object.getOwnPropertyNames(screen)` 从 `[]` 变成 5 项               | 改挂 `Screen.prototype`；实例自有属性恢复为空                                                              |
| screen 位深矛盾     | `colorDepth` 被改成 24，但 `pixelDepth` 仍是宿主机的 30                                          | `pixelDepth` 与 `colorDepth` 同源返回画像值                                                                 |
| DPR descriptor      | 只定义 `window.devicePixelRatio` getter，原生 setter 被覆盖成 `undefined`                         | 保留原生 descriptor 的 setter，并让 getter 继续返回画像值                                                   |
| UA-CH 实例属性      | 手工构造的 `userAgentData` 带 `brands/mobile/platform/getHighEntropyValues` 自有属性               | 返回原生对象，getter/method 全部落在 `NavigatorUAData.prototype`；`brands` 每次返回新的冻结数组              |
| MediaDevices 源码   | `enumerateDevices` 挂成实例方法，`toString()` 直接输出注入用 async 源码                            | 改为 `MediaDevices.prototype` 上的 Proxy 方法，实例无自有属性，`toString()` 为原生串                         |
| WebRTC / Battery    | WebRTC 包装把 `addEventListener` / `onicecandidate` / `localDescription` 挂到连接实例；battery 同样落到实例 | WebRTC 改为原型级拦截（构造器保持原生）；BatteryManager 属性改挂原型；实测实例自有属性均为空               |

修复后 Worker 实测与画像一致：UA `Chrome/131`、UA-CH `Chromium/Google Chrome 131`、
`hardwareConcurrency = 12`、GPU `Google Inc. (Apple) / Apple M1 Pro`、`navigator` 无自有属性；
同一 seed 重复读取 Canvas 与像素结果稳定，纯色块像素严格保持 `255,0,0,255`。

Pixelscan 的 `checkFingerprintMasking()` 组合判定已逐项核对：固定红块哈希、Worker 跨世界、
UA / Client Hints、平台 / 语言 / 硬件合理性、字体与 OS 匹配、纯色 Canvas 噪声检测均通过。
其中 C14 `canvasNoiseOn2d()` 会校验 `toDataURL.toString()` 长度必须为 38/42，并读取 14 个纯色块；
这两点分别由「命名 toString」与「纯色保护」修复。

**已知边界**：嵌套 Worker（Worker 里再建 Worker）不递归注入；ServiceWorker 仍通过屏蔽迫使探针回退；
`Function.prototype.toString.call(Worker/Blob)` 仍是匿名原生串（紫鸟为带名原生串），
全局补丁 `Function.prototype.toString` 会让 CreepJS stealth 升到 20%，已放弃 JS 层方案，留待 C++ 内核层；
静态住宅/ISP 代理仍会被 Pixelscan 单独标为 `Proxy detected`，这属于代理检测而非指纹伪装失败；
os1 德国与 os2 英国两组住宅代理均已复跑，非代理因素全部通过，Pixelscan 无 `masking detected`。
