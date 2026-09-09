# 反检测技术方案

## 1. 为什么 JS 注入不够

主流指纹浏览器（含紫鸟部分维度）用 `Page.addScriptToEvaluateOnNewDocument` 注入脚本覆写 `navigator` 属性。这种方案的暴露点：

1. **函数 toString 泄露** —— 被覆写的原生函数 `Function.prototype.toString` 结果异常，探针一测就露。
2. **原型链痕迹** —— `Object.getOwnPropertyDescriptor` 可看出属性从 getter 变成 value，或 descriptor 的 `configurable` 异常。
3. **执行时序竞争** —— 注入脚本在页面首个 script 之前执行不总是可靠，iframe / worker 场景经常漏覆盖。
4. **Worker 上下文逃逸** —— `new Worker()`、`SharedWorker`、`ServiceWorker` 有独立全局对象，JS 注入难以全覆盖，探针在 Worker 里读原始值即可穿透。
5. **CDP 自身痕迹** —— `Runtime.enable` 会让 `console` 行为变化，`Error.stack` 出现异常帧。

因此 ShadowEdge 采用 **Chromium 源码级补丁**：在 C++ 层拦截 Blink 的 API 实现，从渲染引擎内部返回伪造值。JS 层看不到任何 hook 痕迹，Worker 与 iframe 自动继承。

## 2. 补丁清单

### 2.1 自动化痕迹清除
| 目标 | 补丁位置 | 做法 |
| --- | --- | --- |
| `navigator.webdriver` | `third_party/blink/renderer/core/frame/navigator.cc` | 直接返回 `false`，移除 `--enable-automation` 的联动 |
| `window.cdc_*` 变量 | ChromeDriver 注入点 | 不使用 ChromeDriver，改用直连 CDP |
| `Runtime.enable` 痕迹 | `content/renderer/` | 延迟启用，或用 isolated world 执行 |
| `--enable-automation` infobar | `chrome/browser/ui/` | 移除 switch 检测 |
| `navigator.plugins` 为空 | `navigator_plugins.cc` | 注入符合真实 Chrome 的 PDF Viewer 等 5 项 |
| `navigator.mimeTypes` 为空 | 同上 | 与 plugins 对应填充 |
| `Notification.permission` 异常 | permission 模块 | headless 下返回 `default` 而非 `denied` |
| `chrome.runtime` 缺失 | `extensions/renderer/` | 保留最小 `chrome` 对象骨架 |

### 2.2 指纹维度伪造

| 维度 | 拦截点 | 策略 |
| --- | --- | --- |
| Canvas 2D | `CanvasRenderingContext2D::getImageData`, `toDataURL` | 按 seed 对像素施加确定性微扰（±1 LSB），肉眼无差异但哈希稳定唯一 |
| WebGL | `WebGLRenderingContext::getParameter` | 替换 `VENDOR`/`RENDERER`/`UNMASKED_*`；`readPixels` 施加噪声 |
| AudioContext | `AudioBuffer::getChannelData`, `AnalyserNode` | 对浮点样本乘以 seed 派生的极小系数 |
| ClientRects | `Element::getBoundingClientRect` | 对返回值加 seed 派生的亚像素偏移 |
| 字体枚举 | `FontCache::GetFontData` | 仅命中白名单字体，其余回退默认字体 |
| WebRTC | `PeerConnection` ICE 候选生成 | 用代理出口 IP 替换本地候选，或完全禁用 mDNS 候选 |
| 时区 | `blink::TimeZoneController` | 从环境配置读取，不读系统时区 |
| 语言 | `Navigator::languages` | 从环境配置读取 |
| 地理位置 | Geolocation service | 返回代理出口 IP 对应坐标 |
| 硬件参数 | `Navigator::hardwareConcurrency`, `deviceMemory` | 从环境配置读取 |
| 媒体设备 | `MediaDevices::enumerateDevices` | 返回配置的虚拟设备列表，deviceId 由 seed 派生 |
| Battery | `BatteryManager` | 返回配置值 |
| Screen | `Screen::width` 等 | 从环境配置读取，且 `availHeight` 需减去合理任务栏高度 |

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

搭建自有探针站（`scripts/probe/`）采集全部维度，并交叉验证：

1. **唯一性** —— 100 个环境的指纹哈希两两不同。
2. **稳定性** —— 同一环境重启 20 次，指纹哈希不变。
3. **一致性** —— 交叉约束全部满足。
4. **隐蔽性** —— 第三方检测站（CreepJS / BrowserLeaks / Pixelscan 等）无自动化告警。
5. **隔离性** —— 环境间 Cookie / Storage / IP 互不可见。
