# 竞品逆向：紫鸟浏览器 macOS 客户端隔离技术分析

- 分析日期：2026-09-18
- 样本版本：外壳 `ziniao` v6.26.6.6（`com.ziniao.fzzixun`，Electron 应用）
- 内核版本：Chromium 150.1.4.103（Framework 自报构建号 150.0.7871.123），内核包构建于 2026-08-13
- 分析方式：仅静态分析（应用包结构、Mach-O 符号表、字符串表、应用支持目录），未运行动态调试

## 1. 总体架构

紫鸟是「Electron 管理台 + 独立定制 Chromium 内核 + 本地网络网关」的三部件结构：

```
ziniao.app（Electron 外壳：环境管理 UI、编排）
  └─ 运行时下载定制内核到 ~/Library/Application Support/ziniaobrowser-kernel/
       chrome_64_150.1.4.103_darwin_ziniaobrowser.zip（174MB，解压后 370MB）
  └─ envkit/（随包分发的原生可执行文件）：本地网络与编排守护进程
```

关键判断：**紫鸟的指纹方案是源码级补丁 Chromium（fork 后重编译），不是 JS 注入**。这与 CloakBrowser 闭源内核属于同一技术路线，但紫鸟为自研。

## 2. 部件清单与证据

### 2.1 外壳：Electron 管理台

- 证据：`Contents/Info.plist` 中 `NSPrincipalClass = AtomApplication`、`ElectronAsarIntegrity` 哈希、标准 Electron Helper 四件套。
- 业务代码在 `Resources/app.asar`，含 `better_sqlite3.node`（本地持久化）。
- URL scheme：`superbrowser://`、`superbrowserv6://`。

### 2.2 指纹：C++ 层补丁 Chromium

内核包为完整 Chromium app 结构（`ziniaobrowser Framework.framework`，主二进制 233MB arm64 Mach-O）。

决定性符号（直接出现在 Framework 二进制中）：

- `AddCanvasFingerprint` —— Canvas 指纹在 C++/Blink 层处理（叠加噪声/改写派）
- `AddWebGLFingerprint` —— WebGL vendor/renderer 等在底层改写
- 品牌串被系统性替换为自有标识，深入 Chromium 组件层：
  `org.ZiXun.ziniaobrowser.webauthn`、`.webauthn-uvk`、`.devicetrust`、
  `.secure-payment-confirmation`、`.unexportable-keys`

推论：

- 改动深入到 Blink 与组件目录，非表面换 UA；Worker/iframe 场景天然覆盖。
- Canvas 方案是「确定性噪声」派（与 seed 可复现诉求相容），但噪声分布是否贴近真实人群仍需探针实测。
- 内核按 `chrome_64_<version>_<os>_ziniaobrowser.zip` 命名并运行时下发，支持热更新内核而不动外壳。

### 2.3 环境隔离：进程级 + 独立 user-data 目录

- 启动参数确认使用 Chromium 原生 `--user-data-dir`。
- 每个环境独立目录：`~/Library/Application Support/ziniaobrowser/instances/userdata1/`
  内含独立 `Cookies`、`Cache`、`Code Cache`、`Crashpad` 等。
- 无容器/VM 级隔离：macOS 上是同用户多进程 + 文件目录隔离。

### 2.4 网络隔离：本地 V2Ray/Xray 网关

`Contents/Resources/app.asar.unpacked/envkit/` 下五个原生二进制：

| 文件 | 架构 | 职责（基于符号/字符串） |
| --- | --- | --- |
| `v2ctl`（13MB） | x86_64 | 实锤为 V2Ray/Xray 控制面：符号含 `v2fly`、`vmess`、`vless`、`shadowsocks`、`proxy/vmess/inbound/config.proto` |
| `ziniao-gateway`（33MB） | arm64 | 本地代理网关守护进程，Chromium 流量统一经此按环境分流 |
| `ziniao-agent`（20MB） | x86_64 | 环境编排/代理 |
| `env-kit`（15MB） | arm64 | 环境生命周期编排（数据目录 `env-kit/Core`、`.identify`） |
| `z-tracking-client`（15MB） | arm64 | 行为/遥测采集 |

架构：业务浏览器 → 本地 gateway → V2Ray 出站（vmess/vless/ss 等）→ 对应环境的代理出口。
相比简单的 `--proxy-server`，优点是协议丰富、链路可观测、可做环境级流量策略；代理凭据留在主进程侧，渲染层不可见。

### 2.5 自动化：魔改 WebDriver + 分析模块

内核包 `Contents/MacOS/` 下：

- `webdriver`（16.9MB）：完整 WebDriver BiDi/CDP 服务（session、Storage/Cookie 命令等），即魔改 ChromeDriver，用于在驱动侧消除自动化痕迹并支撑 RPA。
- `analysis`（2.8MB）：内嵌大量真实网页语料，疑似页面行为/风控分析模块。

### 2.6 其他

- `main.dat` 内容为相对路径 `../../../../../MacOS/紫鸟浏览器`，用于启动器定位。
- 崩溃上报走 Chromium Crashpad（`ziniaobrowser/Crashpad`）。

## 3. 对 ShadowEdge 的映射

| 紫鸟能力 | 技术本质 | ShadowEdge 对策 | 自研程度 |
| --- | --- | --- | --- |
| 指纹伪造 | 自研补丁 Chromium（C++） | 主驱动用 Camoufox（开源 Firefox C++/Rust 补丁）；备份 Patchright/rebrowser（Chromium 补丁集自建） | 集成，不自建补丁 |
| 环境隔离 | `--user-data-dir` 多实例 | `packages/kernel` 进程管理 + 每环境独立数据目录 | 自研（薄） |
| 网络隔离 | 本地 Xray 网关 | 直接集成开源 Xray-core，环境级出站分流，凭据进 crypto 保险箱 | 集成 + 编排自研 |
| 自动化 | 魔改 ChromeDriver/CDP | Camoufox 原生 Playwright 直连；`packages/rpa` 做编排与人类化 | 自研编排 |
| 遥测/风控分析 | 原生 tracking client | 建探针评分体系（CreepJS/browserleaks）做环境自检，而非监控用户 | 自研 |

## 4. 验证待办（实证阶段）

- [ ] Camoufox 同 seed 双开访问 CreepJS / browserleaks / Iphey，记录信任分与各维度
- [ ] Canvas 噪声做「分布合理性」检查（多次采样是否落入真实人群分布，而非只看值是否变化）
- [ ] Xray 本地网关按环境分流实测：DNS 走代理、WebRTC 无泄漏、出口 IP 与指纹时区/语言一致
- [ ] 记录 Camoufox 包体积、冷启动耗时，与紫鸟 370MB/内核基线对照

## 5. 合规说明

本文件为互操作性与安全研究目的的静态分析，不分发紫鸟的任何专有代码或二进制。ShadowEdge 不得复制其专有资产；所有集成对象仅限许可证明确允许再分发的开源项目。
