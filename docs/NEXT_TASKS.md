# 下一步任务清单（供 AI 逐项执行）

每项任务都做成自包含的：交代背景、明确产出、验收标准。执行前先读 `AGENTS.md`。

---

## T1 — 本地 SQLite 持久层

> ✅ 已完成（2026-10-18）。
> 实现调整：存储引擎用 **Node 内置 `node:sqlite`**（Electron 已升级到 44.9.0）替代
> better-sqlite3 —— 本机无 Xcode CLT，原生模块无法编译；零原生依赖同时免除
> Electron ABI 重编译问题。产物：`services/db.ts`（连接+迁移+唯一类型断言出口）、
> `keyring.ts`（本地 KEK，0600）、`profile-repository.ts`、`proxy-repository.ts`
> （密码 EnvelopeCrypto 密文落库 + reveal 仅限内核链路）、`local-records.ts`
> （审计 + 会话 + 孤儿清理）、`test/repositories.test.ts` 7 个用例。

**背景**：`apps/desktop/src/main/handlers.ts` 目前用内存 `Map` 存环境，重启即丢。

**产出**：

- `apps/desktop/src/main/services/db.ts` —— 基于 `better-sqlite3` 的连接与迁移
- 表：`profiles`、`proxies`、`sessions`、`audit_local`
- `apps/desktop/src/main/services/profile-repository.ts` —— CRUD 仓储
- handlers 改为依赖仓储接口而非 `Map`

**验收**：创建环境 → 退出应用 → 重启 → 环境仍在，指纹完全一致。

**注意**：`proxies.password` 列必须存 `@shadowedge/crypto` 加密后的密文，不能存明文。

---

## T2 — 指纹一致性交叉校验 ✅（2026-10-22 完成）

> 已落地：`packages/fingerprint/src/consistency.ts`，覆盖 UA 操作系统 / UA-CH platform、
> Chrome/Edge 主版本与 brands/fullVersion、屏幕可用区差值、桌面触摸点、内存 2 的幂、
> Apple/D3D11/SwiftShader GPU 矛盾、平台字体子集；已接入 `auditFingerprint()` 与启动闸门。
> 13 个正反例测试见 `packages/fingerprint/test/consistency.test.ts`。

**背景**：`auditFingerprint()` 目前只校验「能否由 seed 复现」，没校验各维度之间是否自相矛盾。这是风控最容易抓的点，见 `docs/ANTI_DETECTION.md` §2.3。

**产出**：在 `packages/fingerprint/src/` 新增 `consistency.ts`，实现下列规则并接入 `auditFingerprint()`：

- UA 中的 OS 与 `platform`、`userAgentData.platform` 一致
- UA 中的 Chrome 主版本与 `userAgentData.brands`、`fullVersion` 一致
- `screen.availHeight < screen.height`，且差值在 20–80px 合理区间
- `screen.availWidth <= screen.width`
- macOS 平台 `maxTouchPoints === 0`
- WebGL renderer 描述的 GPU 厂商与 `platform` 相容（Apple GPU 不可能出现在 Windows）
- `hardware.deviceMemoryGb` 为 2 的幂且在 2–64 之间
- 字体白名单必须是对应平台字体库的子集

**验收**：为每条规则写一个正例与一个反例测试；`pnpm test` 全绿。

---

## T3 — 代理健康检查真实实现 ✅（2026-10-18 完成）

> 已落地：`packages/proxy/src/tunnel.ts`（零依赖 SOCKS5/HTTP CONNECT 隧道）+
> `health.ts`（多端点回退 ip-api → httpbin → api.ip.sb，每端点重试一次）。
> 三组真实住宅代理实测全过（出口 IP/地理/时区/风险分），见下「实测记录」。

**背景**：`ProxyManager.check()` 目前返回硬编码假数据。

**产出**：

- 通过代理请求 IP 查询服务，取真实出口 IP、地理位置、时区、ASN
- 测量真实延迟（三次取中位数）
- 失败时返回 `reachable: false` 并填 `error`，不要抛异常
- 增加 `checkAll()` 并发批量检测，用 `Result<T>` 收集结果，单个失败不影响其他

**验收**：对一个不存在的代理执行 `check()`，返回 `reachable: false` 而非抛错。

**注意**：`ProxyManager.upsert()` 目前用 base64 假装加密（`enc:` 前缀），必须换成 `@shadowedge/crypto` 的 `EnvelopeCrypto.seal()`。

---

## T4 — 启动前一致性闸门 ✅（2026-10-18 完成）

> 已落地：`apps/desktop/src/main/services/launch-gate.ts`，
> 三检（auditFingerprint → 代理可达 → 时区地理对齐）接入 `handlers.ts` 的 `profile:launch`。

**背景**：目前 `BrowserKernel.launch()` 不做任何前置校验就"启动"。

**产出**：在 `launch()` 开头依次执行：

1. `auditFingerprint()` 不通过 → 抛 `E_FINGERPRINT_INCONSISTENT`
2. 代理不可达（且未设 `ignoreProxyCheck`）→ 抛 `E_PROXY_UNREACHABLE`
3. 代理出口地理与环境 timezone 冲突 → 抛 `E_PROXY_GEO_MISMATCH`，并在错误 `details` 里给出建议的 timezone

**验收**：构造一个 timezone 为 `Asia/Shanghai` 但代理出口在美国的环境，启动被拒绝且错误信息含建议值。

---

## T5 — Chromium 启动参数与真实进程

**背景**：`BrowserKernel.launch()` 现在返回假的 `pid: 0`，没有真启动进程。

**产出**：

- `packages/kernel/src/args.ts` —— 由 `BrowserProfile` 编译出完整命令行参数
- 必须包含：`--user-data-dir`、`--proxy-server`、`--disable-quic`、`--host-resolver-rules`、`--lang`、`--window-size`、`--remote-debugging-port`
- 必须**不**包含：`--enable-automation`、`--disable-blink-features=AutomationControlled`（后者本身就是痕迹）
- 用 `child_process.spawn` 真实启动，监听 `exit` 更新环境状态
- 从 stderr 解析出 CDP WebSocket 端点

**验收**：为参数编译写快照测试；确认 `--proxy-bypass-list` 为空（防 DNS 泄露）。

---

## T6 — 环境创建/编辑 UI ✅（2026-10-19 完成）

> 已落地：`ProfilesPage`（卡片+启动/停止）、`CreateProfileDialog`（名称/平台/代理/种子+实时指纹预览）、
> `ProxiesPage`（列表/批量导入/健康检查结果展示）、全局 `Toasts`（订阅 `app:toast`）。
> 样式维持内联方案，未引入样式框架（避免无谓依赖）。
> 顺带修复：patchright 系在 electron-vite 下保持 external 并显式列为 desktop 依赖，否则打包后动态 require 断裂。

**背景**：渲染层目前只有一个只读列表。

**产出**：

- 环境创建对话框：名称、平台标签、代理选择、指纹预览（调 `fingerprint:preview` 实时展示）
- 环境卡片上的启动/停止按钮，绑定 `profile:launch` / `profile:close`
- 代理管理页：列表、批量导入文本框、健康检查按钮与结果展示
- 全局 toast，订阅 `app:toast` 事件

**验收**：能在 UI 上完成「创建环境 → 看到指纹预览 → 启动 → 状态变 running → 停止」全流程。

**注意**：目前是内联样式，若引入样式方案请在 ADR 记录选型理由。

---

## T7 — RPA 执行引擎

**背景**：`RpaEngine.run()` 只创建 run 记录，不执行任何节点。

**产出**：

- 节点执行器注册表，实现 `navigate` / `click` / `type` / `wait` / `extract` / `screenshot`
- 通过 CDP 操作目标环境
- 按 `graph` 拓扑推进，支持 `onError` 的 stop / continue / retry
- 执行过程通过 `rpa:progress` 事件上报
- 人类化输入：打字间隔 80–260ms 抖动，鼠标走贝塞尔曲线（见 `ANTI_DETECTION.md` §4）

**验收**：一个「打开页面 → 输入 → 点击 → 截图」的工作流能端到端跑完并产出截图产物。

---

## T8 — 探针站与验证矩阵

**产出**：

- `scripts/probe/` —— 采集全部指纹维度的静态页面
- `tests/e2e/isolation.test.ts` —— 验证两个环境的 Cookie/Storage/指纹/IP 四项全不相同
- `tests/e2e/stability.test.ts` —— 同一环境重启 20 次指纹哈希不变
- 输出 `docs/ROADMAP.md` 验证矩阵的实际得分

**验收**：矩阵中每一项都有自动化测试覆盖，并给出通过率数字。

---

## T8 — 本地代理中继网关（启动链路的硬前置）✅（2026-10-19 完成）

> 已落地：`packages/proxy/src/relay.ts`（CONNECT + 明文 HTTP 双模式、环回/内网直连分流、
> 关闭时主动断开存量连接）。`BrowserKernel.launch` 自动为带代理的环境起中继，
> Chromium 只指向 `http://127.0.0.1:<port>`，中继随环境关闭回收。
> 实测：curl 与真实 Chromium 经「本地 7897 → 海外静态」双跳，
> 出口 IP 与健康检查完全一致（os1 德国 / os2 英国均 MATCH）。
> 注意：e2e 脚本里不能用 `execSync` 调 curl——事件循环阻塞会让中继无法 accept（血的教训）。

**背景**（2026-10-19 自动化走查实测确认）：Chromium 自身有两个代理能力缺口——

1. **SOCKS5 不支持用户名密码认证**（我们全部五个测试代理都有认证）
2. **不支持代理链**（海外静态 IP 需要「本地翻墙 → 海外」双跳）

因此 `kernel` 不能把真实代理直接塞给 Chromium。正确做法（紫鸟同款思路）：
每个环境启动时在本机 `127.0.0.1` 起一个**临时 HTTP 代理端口**，把进入的请求经
`openTunnel()`（已支持双跳）转发出去，Chromium 只指向这个本地端口（无认证、无链）。

**产出**：

- `packages/proxy/src/relay.ts` — `startRelay(credential, password, upstream?) → { port, close() }`
- 内核启动参数改为 `--proxy-server=http://127.0.0.1:<port>`，环境关闭时回收端口
- 中继需按目标主机分流：直连名单（内网/localhost）不走隧道

**验收**：用带认证的 socks5 代理启动环境，浏览器内访问 ip 查询站显示的出口 IP
与健康检查结果一致；双跳链路同样成立。

---

## T9 — 指纹跟随代理 ✅（2026-10-19 完成）

> 已落地：`packages/fingerprint/src/geo-follow.ts`（deriveGeoOverrides：时区直通 + 国家码→语言映射
> 26 个市场 + 坐标 ±0.05° 确定性抖动）；`profile:create` 与 `fingerprint:preview`（新增可选 proxyId）
> 自动应用，显式 overrides 优先；主进程健康检查 5 分钟缓存（双跳探测 30s+ 不再重复）；
> 顺手修复启动闸门漏解析 upstream 导致双跳代理误判不可达的问题。
> UI 走查：选 os1-德国 → 预览自动 Europe/Berlin + de-DE + 法兰克福坐标 → 启动 running → 停止。
>
> 踩坑记录：patchright 的 page.evaluate 在隔离 world，看不到 contextBridge 桥，
> 自动化走查须用 CDP Runtime.evaluate 打主世界。

---

## 阶段三：探针回归网 ✅ 27/27 基线（2026-10-21）

> `experiments/probes/run.mjs`（`pnpm probe -- --seed <s> --proxy os1 --label <name>`）：
> 真实产品链路（fingerprint→注入→中继→Patchright）跑本地采集、Worker 穿透、WebRTC SDP 泄漏检查，
> 并接入 CreepJS / BrowserLeaks / Pixelscan，输出 27 项期望矩阵与 JSON 报告。
> 最新基线：`os1-final-audit-1792553903844.json`（德国）与
> `os2-final-audit-1792554019160.json`（英国），均为 **27/27**；CreepJS `0% headless / 0% stealth`，
> BrowserLeaks 无 IP 泄漏，Pixelscan Fingerprint 卡片为 `No masking detected`。
> 本轮修复 Worker Canvas 作用域回归、Canvas 纯色保护与 5×5 纹理判定、Proxy 命名 `toString`
> （Pixelscan C14 的 38/42 字符检查）、WebRTC mDNS 正则与 `0.0.0.0` 分类；
> 并完成注入层自查：消除 `screen` / `userAgentData` / `mediaDevices` / WebRTC / battery 的实例自有属性，
> 补齐 `screen.pixelDepth` 与 `colorDepth` 一致性，保留 `devicePixelRatio` 原生 setter descriptor。
> 详见 docs/ANTI_DETECTION.md §6。

紫鸟 EngTk2 对照已完成并归档到 `docs/COMPARISON_ZINIAO.md`：跨世界一致、WebRTC、Canvas/Audio、
UA 降版本等主体能力对齐；ShadowEdge 在 UA-CH 对象稳定性与代理出口地理跟随上更优。
仍差 ServiceWorker 作用域注入与带名原生 `Function.prototype.toString.call`，两者都需要内核层能力。

**已知边界**：os1/os2 为静态住宅/ISP 代理（ip-api `hosting=false`），Pixelscan 仍会单独显示 `Proxy detected`，不伪造绕过；
嵌套 Worker 不递归注入；ServiceWorker 采用屏蔽+回退策略；
`Function.prototype.toString.call(Worker/Blob)` 仍是匿名原生串（全局补丁会让 CreepJS stealth 升到 20%，已回退）。

**后续优先级**：

1. 按 `docs/KERNEL_PATCH_PLAN.md` 推进 Chromium 内核层补丁：ServiceWorker 注入 + 带名原生 `Function.prototype.toString`。
2. 把 catalog 版本写入 `FingerprintProfile` 持久化字段，让历史环境审计自动选对素材快照。
3. 配置 `shadowedge-probe` 自托管 runner 与 `SHADOWEDGE_TEST_PROXIES_JSON` secret，启用夜间回归。

---

## T10 — UA / UA-CH 素材目录更新机制 ✅（2026-10-22）

**产出**：

- `packages/fingerprint/src/catalog.ts`：版本化 `FingerprintCatalog`、运行时校验、`catalogToGeneratorDb()`。
- `packages/fingerprint/src/catalog-cli.ts`：从 Chrome for Testing stable 通道生成三平台 UA/UA-CH 快照。
- `pnpm update-ua-catalog`：联网更新；离线可用 `--version <fullVersion> --out <path>`。
- `generateFingerprint({ db })` 修复为真正合并 userAgents / uaDatas / screens / fonts / webglVendors。
- `auditFingerprint(current, { db, overrides })` 可用同一套素材复现并审计。

**漂移规则**：catalog 生成新快照，不修改旧快照；历史环境必须记录自己使用的 catalog 版本。
详见 `packages/fingerprint/catalog/README.md`。

---

## 运维 — 探针夜间回归 🟡（工作流已落地，待 runner）

`.github/workflows/probe-nightly.yml` 每天 18:00 UTC（新加坡 02:00）在
`[self-hosted, macOS, shadowedge-probe]` runner 上跑 os1/os2 全量探针，
`--fail-under 27` 低于阈值直接失败，并上传 JSON 报告。

启用前需要：

1. 自托管 macOS runner（必须有图形会话，headful Chromium 才能跑）。
2. GitHub secret `SHADOWEDGE_TEST_PROXIES_JSON`，内容与本地
   `experiments/.secrets/test-proxies.json` 相同。
3. 仓库变量 `SHADOWEDGE_PROBE_UPSTREAM`（可选，默认 `http://127.0.0.1:7897`）。
