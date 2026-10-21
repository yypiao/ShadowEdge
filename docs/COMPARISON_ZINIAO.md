# ShadowEdge × 紫鸟 EngTk2 对照报告（2026-10-21 更新）

- 方法：同一套 `probe-page.html` 采集主世界 / Worker / WebGL / Canvas / WebRTC，两侧使用同一口径。
- ShadowEdge 侧：`experiments/probes/ziniao-compare/run-shadowedge.mjs`（seed `ziniao-compare`，跟随宿主机平台）。
- 紫鸟侧：用户在本机 EngTk2 环境中通过 `file://` 打开探针页，UI 全选复制结果；
  原始报告 `experiments/probes/ziniao-compare/result-1792471246829.json`。
- 最终回归基线：`experiments/probes/results/os1-final-20261021-1792546993130.json`（27/27）。

## 1. 逐项对比

| 维度 | ShadowEdge（ziniao-compare） | 紫鸟 EngTk2 | 说明 |
| --- | --- | --- | --- |
| UA | Chrome/130.0.0.0，Mac 14_6 | Chrome/150.0.0.0，Mac 10_15_7 | 紫鸟 UA 与内核 150 同版；我们的 UA 库仍是 130/131 区间 |
| platform | MacIntel | MacIntel | 一致 |
| 核数 / 内存 | 4 / 8 GB | 4 / 8 GB | 一致 |
| 语言 / 时区 | en-US / Australia/Sydney（seed 决定） | en-GB / Europe/London | 都是环境配置值，不是宿主机真实值 |
| 屏幕 | 2560×1440，DPR 1，depth 30 | 1440×2560，DPR 1，depth 24 | 紫鸟是竖屏 + 24 位色深 |
| WebGL | `ANGLE (Apple, Apple M1 Pro, OpenGL 4.1)` | `ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro, Unspecified Version)` | 都做到同系 GPU，不出现 Windows/D3D11 矛盾 |
| UA-CH | 稳定对象 `stableObject=true`，品牌/完整版本与 UA 同源 | **`stableObject=false`**：两次读取不是同一对象 | 紫鸟此处反而是可被稳定性探针利用的弱点 |
| Canvas 纹理 | `a34b9bbc`，两次读取逐字节一致 | `631a6983`，两次读取逐字节一致 | 两者都有确定性噪声 |
| Canvas 纯色块 | `39756b3c`，像素严格等于 `255,0,0,255` | `39756b3c`，像素严格等于 `255,0,0,255` | 关键：纯色检测块不能被噪声污染 |
| Audio | `172.67165175`（微噪声） | `172.67165096`（较大噪声） | 量级不同，但都稳定 |
| Worker 世界 | UA / UA-CH / 核数 / GPU 全部与主世界一致，`navOwnProps=[]` | 同样全部一致，`navOwnProps=[]` | 跨世界一致性已对齐 |
| `Worker.toString` | `function () { [native code] }`（`Function.prototype.toString.call`） | `function Worker() { [native code] }` | 残余差异：Proxy 无法让引擎返回带名原生串 |
| `Blob.toString` | `function () { [native code] }` | `function Blob() { [native code] }` | 同上 |
| WebRTC | candidate 为空；SDP `c=IN IP4` 被改写为 `0.0.0.0`（unspecified） | candidate 为空；旧探针把地址标成 `public` | 旧版 `ipClass()` 把 `0.0.0.0` 误判为 public；原始地址未落盘，需 BrowserLeaks 复测确认 |
| ServiceWorker | **屏蔽** | **可用** | 紫鸟有内核层注入，我们目前用屏蔽迫使探针回退 |
| webdriver / CDC / native | 干净 | 干净 | 一致 |
| CreepJS | `0% headless / 0% stealth` | 未测（需其 API） | — |
| Pixelscan | 27/27，`No masking detected`（os1 数据中心代理单独标 `Proxy detected`） | 未测 | 住宅代理复跑仍待补 |

## 2. 结论

**能力主体已经对齐**：跨世界一致、WebRTC 防泄漏、Canvas/Audio 确定性噪声、UA 降版本、
UA-CH 与 HTTP 头同源、纯色检测块保护，这些紫鸟具备的维度 ShadowEdge 都已具备。

**两处我们做得更好**：

1. **UA-CH 对象稳定**。紫鸟 `stableObject=false`，同一环境两次读取 `navigator.userAgentData`
   得到不同对象；稳定对象探针可以直接把它记为异常。ShadowEdge 返回同一对象。
2. **指纹跟随代理出口自动化**。紫鸟仍依赖环境里手工配置语言/时区；ShadowEdge 从代理
   `ProxyHealth.geo` 派生 timezone / languages / geolocation，并在启动前做一致性闸门。

**两处仍需追赶**：

1. **ServiceWorker 作用域**。紫鸟能在 ServiceWorker 内覆盖指纹（C++ 内核层能力），
   我们尚未做到，只能屏蔽并迫使探针回退到 Dedicated/Shared Worker。
2. **包装函数的带名原生 `toString`**。紫鸟的 `Function.prototype.toString.call(Worker)`
   返回 `function Worker() { [native code] }`；Proxy 只能返回匿名原生串。
   曾尝试全局补丁 `Function.prototype.toString`，但 CreepJS stealth 从 0% 升到 20%，已回退。
   长期需要在 Chromium 内核层实现（C++ patch），而不是 JS 层。

**UA 库运营差距**：紫鸟 UA 150 与内核 150 同版，说明其 UA 库持续维护；我们的 `DEFAULT_DB`
仍是 130/131，需要建立版本更新机制，否则时间越久越像“静止画像”。

## 3. 本轮（2026-10-21）修复

- **Worker 注入回归**：Canvas 噪声代码在 Worker 中引用不存在的 `CanvasRenderingContext2D`，
  导致整段 Worker 注入抛错并超时；已加作用域守卫，Worker 数据恢复。
- **Canvas 纯色保护**：`toDataURL` 现在先做 8×8 网格纯色采样；纯色直接走原生编码，
  纹理才用 `drawImage` 复制并只在 5×5 邻域颜色数 ≥5 的位置落点。
  没有落点时直接编码原画布，保证纯色块逐字节不变。
- **Canvas 幂等**：同一 canvas + 参数按 `_canvasVersion` 缓存；`getImageData` 只改返回副本，
  纹理画布两次读取哈希一致（`textureDiffBytes=0`）。
- **包装函数命名 `toString`**：Proxy 增加 `toString` / `name` get 陷阱，
  `toDataURL.toString()` 返回 38 字符的 `function toDataURL() { [native code] }`，
  修复 Pixelscan C14 的“长度必须是 38/42”检查；`Function.prototype.toString.call` 仍不泄漏源码。
- **WebRTC mDNS / unspecified**：候选正则从 IP 字符集改为 `[^\s]+`，正确识别带连字符的 mDNS；
  `0.0.0.0` / `::` 归类为 `unspecified`，不再误报 public。

## 4. 紫鸟侧工程观察（供架构参考）

- 内核（Chromium 150 定制二进制）拒绝裸启：校验 launcher 令牌（`--store_data_path` 加密串），
  防提取 / 防二次分发。
- 本地 API（9481 端口）挂付费开放平台鉴权，可作为商业化 API 自动化接口的参考。
- 实例以 `userdata/chrome_<id>` 隔离，与我们的 `profiles/<id>` 同构。
- EngTk2 禁止 `127.0.0.1` 与 `file://` 到 localhost 的 POST；本次改用 UI 复制落盘，
  后续若要做自动化对照，需要走其 CDP/API 或独立采集通道。
