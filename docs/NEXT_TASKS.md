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

## T5 — Chromium 启动参数与真实进程 ✅ 生命周期闭环完成（2026-11-01）

> 实现沿用已验证的 Patchright persistent context，而非重复维护一套 `spawn` 启动器。
> 现通过 browser target 的 `SystemInfo.getProcessInfo` 读取真实主进程 PID，无法获取时省略，
> 不再返回 `pid: 0`。驱动统一上报 `onExit`，`BrowserKernel` 负责去重、清理运行记录及代理中继；
> 桌面 handlers 同步更新 SQLite、会话和 `profile:status`，启动失败也会回滚为 idle。
>
> 真实内核验收：`Browser.close` 手动关窗与 `SIGKILL` 异常退出均自动回收，随后立即重启成功；
> 三次启动均取得非零 PID，最终无未关闭会话。单元覆盖重复启动、幂等关闭、启动失败、
> 自然退出后重启；测试见 `packages/kernel/test/browser-kernel.test.ts`、
> `apps/desktop/test/profile-lifecycle.test.ts` 和 `kernel-runtime-smoke.test.ts`。

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

## T7 — RPA 执行引擎 ✅ 核心执行链路完成（2026-11-01）

> 已落地 core 类型化 `RpaGraph`、节点执行器注册表和真实运行状态机，支持
> `navigate / click / type / wait / extract / screenshot`。通过 `BrowserKernel`
> 直接复用当前环境的 BrowserContext，**无需开放远程调试端口**；新增 `rpa:get`
> 查询最终状态与产物，`rpa:progress` 上报节点、重试和完成进度。
>
> 支持 `stop / continue /retry`、AbortController 取消、同环境执行锁、批量独立失败、
> `{{inputs.key}}` 参数、提取 JSON 与 PNG 产物（目录 0700、文件 0600）。点击使用
> 贝塞尔鼠标轨迹，逐字输入使用 80–260ms 抖动。工作流持久化、可视化编辑器、
> condition/loop/script/http 节点及录制回放不在本卡，后续单独实现。
>
> 验收：结构化页面测试覆盖六节点、重试、继续、停止、取消、环境冲突和异常；
> 真实自研 Chromium 在未开放 CDP 端口时跑通「打开 → 输入 Ada → 点击 → 提取
> Hello Ada → PNG 截图 + JSON」。测试见 `packages/rpa/test/engine.test.ts`、
> `apps/desktop/test/rpa-smoke.test.ts`。

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
当时 `Function.prototype.toString.call(Worker/Blob)` 仍是匿名原生串；后续 T16 已在内核路径解决，Patchright 回退仍为匿名。

**后续优先级**（已展开为阶段四任务卡，见文末）：

1. T11 内核构建流水线 → T13–T16 内核补丁（ServiceWorker 注入 + 带名原生 `Function.prototype.toString` 等）。
2. T12 把 catalog 版本写入 `FingerprintProfile` 持久化字段，让历史环境审计自动选对素材快照。
3. 运维-夜间回归通电：配置 `shadowedge-probe` 自托管 runner 与 `SHADOWEDGE_TEST_PROXIES_JSON` secret（启用清单见文末）。
4. T17 内核版本化分发与防裸启、T18 catalog 定期更新自动化。

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
`[self-hosted, macOS, shadowedge-probe]` runner 上跑 os1/t1 全量探针，
`--fail-under 40`（Patchright 回退 31）低于阈值直接失败，并上传 JSON 报告。

启用操作清单（按序执行，预计 1–2 小时）：

1. 选一台常驻 macOS 机器（本机即可起步），确认已登录图形会话且不会自动锁屏
   （headful Chromium 必需）；`pnpm install` 与 `pnpm build` 在该机已跑通。
2. 仓库 Settings → Actions → Runners → New self-hosted runner（macOS/arm64），
   按官方指引下载安装；`config.sh` 时附加 labels：`macOS,shadowedge-probe`；
   `svc.sh install` 注册为 launchd 服务保证开机自启。
3. 仓库 Secrets 新增 `SHADOWEDGE_TEST_PROXIES_JSON`，内容与本机
   `experiments/.secrets/test-proxies.json` 完全一致（含 os1/t1 凭据）。
4. 仓库 Variables 新增 `SHADOWEDGE_PROBE_UPSTREAM`（可选，默认 `http://127.0.0.1:7897`，
   指 runner 机器的本地翻墙端口，双跳链路需要）。
5. 手动触发一次 workflow_dispatch 验证：两个 job 全绿、Artifacts 里能下载 JSON 报告；
   再故意把 `--fail-under` 临时调高一档确认会红（验证告警链路真实有效），随后还原。
6. 失败通知：Actions 通知开启到维护者邮箱；后续再接飞书/钉钉 webhook。

验收：连续三晚定时任务全绿，且第 5 步的故意失败能被收到并定位到具体探针项。

---

# 阶段四：Chromium 内核工程（P0 · 对标紫鸟内核能力）

> 背景：紫鸟的指纹是源码级补丁 Chromium（符号证据见 `docs/RESEARCH_ZINIAO_RE.md`），
> 我们的 JS 注入层已对齐其主体能力且探针 27/27，但有四个 JS 层无法根治的死角：
> ServiceWorker 作用域、带名原生 `toString`、注入层自身的可检测性、plugins/mimeTypes 结构。
> 本阶段按 `docs/KERNEL_PATCH_PLAN.md` 落地内核路线。
>
> **依赖顺序**：T11（构建流水线）是所有内核任务的前置；T12 独立小任务随时可做；
> T13 → T14 → T15 按序合并；T16 是独立研究项可并行；T17/T18 在 T11 之后启动。
>
> **通用约束**（每张卡都适用）：
>
> - 补丁只读画像，禁止 `Math.random()` / `Date.now()` 参与指纹值（AGENTS.md §4 同源要求）。
> - Chromium 源码与构建产物不进仓库；主仓库只存补丁、构建参数、校验脚本。
> - 补丁内不得引入网络请求、遥测或账号数据。
> - 内核驱动不可用时回退 Patchright，并明确标记 `kernel: patchright`，不静默降级。
> - 每张卡合并前：`pnpm typecheck && pnpm test` 全绿 + 探针 `--fail-under 27` 全绿。

---

## T11 — Chromium 构建流水线（一切内核工作的前置）✅ dev 链路完成（2026-10-29）

> 进展：
>
> - 已落地：`chromium.version`（锁定 156.0.8078.73 stable）、`scripts/build-chromium.sh`
>   （dev/release 双模式、tag 锁定校验、补丁全量 --check 后应用）、`scripts/verify-kernel.sh`
>   （版本串 + headless CDP 冒烟）、`patches/chromium/156/README.md`、`docs/KERNEL_BUILD.md`。
> - 工作区：外置盘 ExFAT 不能直接用，已在其上建 430GB sparsebundle（APFS）挂到
>   `/Volumes/ChromiumBuild`，对本机数据零风险；重启后需重新 attach（命令见 KERNEL_BUILD.md §2）。
> - 网络：googlesource 需走 `http://127.0.0.1:7897` 代理（git 与 cipd/gsutil 都要）。
> - 源码拉取中（fetch --no-history，~35GB）。
> - ~~阻塞项：无完整 Xcode~~ 已解决：Xcode 27.1 已安装；用 `DEVELOPER_DIR=/Applications/
Xcode.app/Contents/Developer` 环境变量切换（无需 sudo 改 xcode-select）。
> - 踩坑：Xcode 27 的 Metal Toolchain 是独立按需组件，ANGLE Metal shader 编译报
>   `missing Metal Toolchain`；修复 `xcodebuild -downloadComponent MetalToolchain`（839MB）。
> - 源码已锁定 `156.0.8078.73`（commit 2f9a1109…，已回填 chromium.version）；
>   拉取阶段 googlesource 经代理偶发 HTTP 429，gclient sync 用 `-j 4` + 重试循环解决。
> - dev 全量编译完成（M4/16GB 约 3.5h），`verify-kernel.sh` 冒烟通过：
>   Chromium 156.0.8078.73 自构建产物 CDP 正常。release 模式按任务卡约定延后到 T17 前。
> - T13 首批补丁已入库并通过冒烟：`0001-shadowedge-fingerprint-switch.patch`
>   （开关 + renderer 下发 + 非法画像拒启）、`0002-webdriver-always-false.patch`。
>   两补丁对干净树 `git apply --check` 零 fuzz；plugins/mimeTypes 实测原生即有真实
>   5 插件结构，无需补丁。

**背景**：`patches/chromium/` 目前只有 README，没有可复现的构建入口；
`KERNEL_PATCH_PLAN.md` §3 的构建命令还只是一段示意。没有流水线，后续每张补丁卡都无法验证。

**产出**：

- `scripts/build-chromium.sh` —— 全链路：`fetch`（如缺）→ checkout 锁定 tag →
  `gclient sync --with_branch_heads --with_tags` → 按序 `git apply patches/chromium/<version>/`
  → `gn gen`（参数固化在脚本内）→ `autoninja chrome`。支持 `--skip-fetch` 增量构建。
  接受 `--mode dev|release` 两种构建模式（见下方「16GB 内存策略」）。
- `chromium.version` —— 锁定文件：Chromium tag + 期望的 commit SHA + depot_tools 版本下限。
  脚本启动时校验实际 checkout 与锁定一致，不一致直接退出，防止「main 漂移后出包」。
- `scripts/verify-kernel.sh` —— 冒烟：启动产物 → 读版本串比对锁定文件 →
  打开 `about:blank` 经 CDP 确认进程存活 → 退出。作为每张补丁卡的最低验证。
- `patches/chromium/<version>/README.md` —— 补丁编号规范（`0001-*.patch` 起按序）、
  每个补丁一行说明、rebase 流程（升版本时 `git rebase --onto` 的操作步骤）。
- `docs/KERNEL_BUILD.md` —— 构建机要求（磁盘 ≥150GB、预计耗时）、
  常见故障（gclient 代理、Xcode CLT 版本、sip 与签名）排查表。

**16GB 内存策略**（当前构建机只有 16GB，实测可行但要分两档）：

- **dev 模式（日常补丁迭代，本机跑）**：`is_debug=false is_component_build=true
symbol_level=0 dcheck_always_on=false`。组件构建把单一巨型链接拆成上百个
  小 dylib 链接，单任务内存峰值从 ~20GB 降到 ~2GB，代价是产物启动慢、体积大，
  但补丁功能验证完全够用。并发限制 `autoninja -j6`（M 系 8–10 核时），
  编译期关掉浏览器/Docker 等吃内存应用。
- **release 模式（出分发产物，T17 才需要）**：`is_component_build=false` 的
  静态链接是内存峰值所在（`Chromium Framework` 单链接可能 16GB+）。本机方案：
  `symbol_level=0 blink_symbol_level=0 enable_nacl=false` + `autoninja -j4`，
  预留 30GB+ 空闲磁盘给 macOS swap，过夜跑；若仍 OOM，再考虑云端 Mac
  （MacStadium / GitHub larger runner 的 14GB 档不够，要 32GB 档）。
- 关键认知：**T13–T16 全部补丁开发都在 dev 模式完成**，release 构建只在
  T17 打包分发前需要，不阻塞内核路线推进。

**验收**：从干净状态执行 `scripts/build-chromium.sh --mode dev` 产出可启动的
`Chromium.app`；`verify-kernel.sh` 通过；无补丁时全部 apply 干净
（`git apply --check` 零 fuzz）；release 模式构建成功一次（可延后到 T17 前补做）。

**注意**：第一优先级是确认磁盘 ≥150GB 空闲（源码 + 构建目录），不足时先解决磁盘
再开工，不要边清边编译。构建不进 CI（资源不合算），但脚本要保证任何一台达标
机器可复现。

---

## T12 — catalog 版本写入 FingerprintProfile ✅（2026-10-31）

> 已落地 131/156 不可变快照与 `catalog-store`，画像生成、审计、桌面及 server 新建环境
> 均按版本取素材；业务 overrides 不能修改版本，缺失/损坏快照明确抛
> `E_CATALOG_SNAPSHOT_MISSING`。DB migration id=2 给老环境回填 131 并写审计日志，
> 新环境固定为与内核一致的 156。桌面 IPC 创建 → SQLite → 重启恢复 → 审计全链路有测试。
>
> 真机验收：131、156 直连探针分别 **32/32**；156 + os1 全量 **40/40**，
> CreepJS **0% headless / 0% stealth**。报告：
> `kernel-131-catalog-1793376469745.json`、`kernel-156-catalog-1793376482008.json`、
> `kernel-156-catalog-os1-1793377130858.json`。
>
> 同期完成桌面内核配置 UI、原子持久化、严格禁止回退模式及实际 `kernelUsed` 展示。
> 多环境真实内核验收通过：并行 Cookie/localStorage/指纹隔离、os1+t1 双代理出口隔离、
> 同环境连续重启 20 次数据与画像稳定（65.3 秒）。测试见
> `apps/desktop/test/profile-isolation-smoke.test.ts`。过期 os2 凭据已于 2026-11-01 删除，
> 后续双代理回归默认使用 os1+t1；历史 os2 报告仅作归档证据。

**背景**：T10 遗留项。catalog 按「只增不改」滚动新快照后，`auditFingerprint()`
默认加载最新素材，对历史环境复现必然误报漂移。历史环境必须记录自己出生时的 catalog 版本。

**产出**：

- `packages/core/src/types.ts`：`FingerprintProfile` 增加 `catalogVersion: string`。
- `apps/desktop/src/main/services/db.ts`：新增迁移，老数据回填为历史 131 catalog 版本
  （回填值写入迁移日志，便于事后核对）。
- `profile-repository.ts`：创建环境时写入当前 catalog 版本。
- `packages/fingerprint`：生成与审计链路默认按画像记录的版本加载对应快照；
  快照缺失时抛带 `ErrorCode` 的明确错误（先加 code，如 `E_CATALOG_SNAPSHOT_MISSING`），
  不允许悄悄退回最新素材。

**验收**：新建环境落库含 `catalogVersion`；旧快照审计旧环境通过；故意指定不存在的版本
得到上述明确错误而非模糊 mismatch。`pnpm typecheck && pnpm test` 全绿。

---

## T13 — 内核补丁 P0+P1：画像入口与自动化痕迹 ✅ 驱动链路完成（2026-10-29）

> 已完成：
>
> - 内核补丁 `0001`（`--shadowedge-fingerprint` 开关、校验拒启、renderer 下发）+
>   `0002`（webdriver C++ 层恒 false）。冒烟：垃圾画像 FATAL 拒启 / 合法画像正常 /
>   plugins 原生 5 项结构（无需补丁）。
> - `packages/kernel/src/drivers/chromium-cdp.ts`：自研内核驱动，executablePath 指向
>   自构建产物（`SHADOWEDGE_KERNEL_EXECUTABLE` 或构造参数）；复用同一套画像组装；
>   内核缺失/启动失败回退 Patchright 并在 `LaunchResult.kernelUsed` 显式标记（core 契约已加该字段）。
>   单测 4 例；`BrowserKernel` 默认驱动已切换为 ChromiumCdpDriver（自带回退，CI 不受影响）。
> - 真机 E2E：自研内核实际承载（`Browser.getVersion=Chrome/156.0.8078.73`）、
>   `kernelUsed=chromium-cdp`、webdriver=false（C++ 层）、JS 注入层在新内核上正常工作。
> - 探针：直连模式 **19/19 全过**（含 Worker 穿透/WebRTC/WebGL）；`run.mjs` 支持
>   `SHADOWEDGE_KERNEL_EXECUTABLE` 切换内核。报告 `kernel-156-direct-1793254219171.json`。
>
> 遗留：
>
> 1. ~~带代理全量回归缺 secrets~~ 已恢复并跑通（见 T14 全量基线）。
> 2. 「无画像参数裸启拒绝」属 T17 启动令牌范畴，0001 只拒绝非法画像。

**背景**：`KERNEL_PATCH_PLAN.md` §2 的 P0/P1。画像必须有单一入口且解析失败拒绝启动，
避免半套画像进入页面；自动化痕迹要从 C++ 层消除而不是靠 CDP flag 擦。

**产出**（`patches/chromium/<version>/0001-…00xx-*.patch`）：

- `content/public/common/content_switches.cc`：新增 `--shadowedge-fingerprint=<base64-json>`；
  浏览器进程解析 + schema 校验，失败直接拒绝启动（退出码非零 + stderr 明确原因）。
- 画像随 renderer / worker 进程参数下发，三类进程同源，禁止各自读不同来源。
- `navigator.cc`：`webdriver` 恒 false；清理 `AutomationControlled` 相关残留状态。
- `navigator.plugins` / `mimeTypes`：返回真实 Chrome 的 PDF Viewer 结构（5 项插件 + 对应 MIME）。
- `packages/kernel/src/drivers/` 新增 `chromium-cdp.ts` 驱动：指向自构建内核，
  优先级高于 patchright；启动失败按工程边界回退并标记 `kernel: patchright`。

**验收**：`KERNEL_PATCH_PLAN.md` §4 第 1/2/3 条；探针矩阵在内核驱动下 27/27；
不带画像参数直接启动内核被拒（为 T17 防裸启打基础）。

---

## T14 — 内核补丁 P2：Worker / ServiceWorker 同源画像 ✅ 完成（2026-10-29）

> 设计调整：Dedicated/Shared Worker 已被 JS 注入层覆盖，真正缺口只有 ServiceWorker。
> 因此 0003 补丁不做逐维度 C++ 重写，而是把**现有整套 JS 注入脚本**经
> `--shadowedge-init-script` 送进 SW 全局作用域（`WorkerGlobalScope::RunWorkerScript`，
> SW 自身脚本前求值）——单一补丁点、零第二套指纹逻辑。Blink 不能依赖 //content，
> 开关名在 Blink 侧用本地字面量镜像（注释已说明）。
>
> 落地：
>
> - 补丁 `0003-serviceworker-init-script.patch`（开关+下发+base64 校验+SW 求值）。
> - `buildInjectionScript(fp, { serviceWorker: 'shield'|'kernel' })`：kernel 模式不再屏蔽 SW；
>   chromium-cdp 驱动传 kernel 模式并携带 init-script 开关；Patchright 维持 shield。
> - 探针矩阵升级：内核模式 +4 项 SW 检查（UA/hc/mem/自有属性），shield 模式 +1 项屏蔽验证。
> - 实测：**内核直连 23/23 全过；Patchright 回归 20/20 全过**。
>   报告 `kernel-156-sw2-1793255611458.json`、`patchright-sw-regression-1793255625225.json`。
>
> 踩坑记录：① 排查时 UA/UA-CH/langs 由 Chromium 浏览器进程级管道覆盖到 SW，
> 只有 hc/mem 能证明 JS 注入真实执行；② 期望值字段在 `fp.hardware.*` 不在顶层，
> 一度误判注入未生效；③ Chromium 静态局部 string 要 `base::NoDestructor`，
> `String::NewFromUtf8` 长度需显式 int 转换。
> **全量基线（2026-10-29，自研内核 + os1 德国住宅代理）：31/31 全过**，
> 含 CreepJS 0%/0%、BrowserLeaks 无泄漏、Pixelscan 全卡片通过 + SW 4 项。
> 报告 `kernel-156-full3-1793256417314.json`。
> 探针坑位：经代理时本地 HTTP 服务收到 absolute-form 请求行，路径匹配需先归一化；
> Pixelscan 经住宅出口偶发超时，重试即可（非指纹问题）。
> ~~遗留：嵌套 Worker 递归注入仍未覆盖（0003 只对 SW 生效）。~~ 已由 T21 / 0008 解决。

**背景**：这是与紫鸟的最大单点差距——它能在 ServiceWorker 内覆盖指纹（C++ 层能力），
我们目前只能屏蔽迫使探针回退（`COMPARISON_ZINIAO.md` §2）。

**产出**（补丁点见 `KERNEL_PATCH_PLAN.md` §2 P2）：

- `worker_navigator.cc` / `worker_global_scope.cc` / `service_worker_global_scope.cc`
  / `worker_navigator_ua_data.cc`：Dedicated / Shared / ServiceWorker 全部下发同源画像。
- 探针页 `experiments/probes/` 增加 ServiceWorker 采集项，纳入 27 项矩阵
  （升级矩阵版本号，预期变为 28+/28+）。

**验收**：三类 Worker 内 UA、UA-CH、核数、GPU 与主世界一致，
`Object.getOwnPropertyNames(navigator)` 自有属性为空；JS 层的 ServiceWorker
屏蔽逻辑降级为「仅 patchright 驱动时生效」的兼容路径；CreepJS 仍 0%/0%。

---

## T15 — 内核补丁 P3：Screen / WebGL / Audio 下沉 ✅（2026-10-29；Canvas 明确暂缓）

> 已完成 0004/0005，补丁序列 0001–0005 可复现（按序 apply 零冲突）；
> 最终 os1 全量探针 **31/31**（`kernel-156-t15-final-1793282828077.json`），
> CreepJS **0% headless / 0% stealth**，Pixelscan Browser/Fingerprint 与非代理项通过：
>
> - **0004 Screen+WebGL**：新增 `platform/shadowedge_fingerprint.h`（header-only 画像访问器
>   - Fnv1a）。Screen 五值 + colorDepth 返回画像；WebGL vendor/renderer 返回画像
>     （Worker OffscreenCanvas 同分支，天然跨世界一致，比 JS 包装更彻底）。
> - **0005 Audio**：getChannelData 的 IDL 入口重载叠加 xorshift 微噪声。
>   同 156 内核下 JS 与 C++ 注入 audioFp **逐值一致**（172.67165166332416）。
> - JS 让位机制：`InjectionOptions.coveredByKernel`，chromium-cdp 驱动声明
>   `['screen','webgl','audio']`，Patchright 全 JS 路径不变。
>
> 踩坑记录：① Audio 加噪必须放 IDL 入口（带 ExceptionState 重载）——内部 C++ 渲染拷贝
> 走无异常版，在空 buffer 上提前加噪会被真实数据 memcpy 覆盖；② 组件构建用 `base::span`
> 替代裸指针（-Wunsafe-buffer-usage）、`String::FromUtf8`（小写 tf）、`base::NoDestructor`。
>
> **Canvas C++ 下沉明确暂缓，不属于本次未完成遗漏**：保留现有 JS 注入，不声明
> `coveredByKernel: ['canvas']`。同一 156 内核“原生 vs JS”专项对照 **20/20**，覆盖
> 原生字符串/descriptor、纯色逐字节不变、纹理微扰、重读稳定及缓存失效；原始证据与
> 重启条件见 `docs/adr/0005-canvas-stays-js-injection.md` 和
> `experiments/probes/results/canvas-js-evidence-1793375676248.json`。
> 当前收益是避免新增高复杂度 C++ 像素/GPU 回归面，而非宣称 JS 与 C++ 完全等价。

**背景**：JS 注入层（574 行 `inject.ts`）本身就是攻击面——Proxy、descriptor 形态、
实例自有属性都需要精心伪装。下沉到 C++ 后这些伪装需求整体消失。

**产出**（补丁点见 `KERNEL_PATCH_PLAN.md` §2 P3）：

- ~~`html_canvas_element.cc` / `canvas_rendering_context_2d.cc`~~：**暂缓，未实施**；
  Canvas 保留 JS 路径，触发条件和证据见 ADR 0005。
- `audio_buffer.cc`：浮点样本微扰，与 JS 版同 seed 同输出。
- `webgl_rendering_context_base.cc`：vendor/renderer 按画像返回。
- `screen.cc`：宽高、可用区、colorDepth/pixelDepth 同源。
- `inject.ts` 改造：检测内核能力标记后对应维度让位，避免双重噪声叠加；
  保留 patchright 驱动的完整 JS 路径。

**验收**：Screen/WebGL/Audio 与画像同源，Audio 在同 156 内核的 JS/C++ 路径逐值一致；
内核全量探针 31/31。Canvas 不列为 C++ 验收项，但现有 JS 路径须持续通过专项 20/20、
纯色保护、纹理重读稳定与全量探针；若出现 Canvas 失分则按 ADR 0005 重估。

---

## T16 — 内核补丁 P4：带名原生 Function.prototype.toString ✅（2026-10-29）

> 已落地 0006 V8 补丁与 ADR 0006：只在 ShadowEdge handler 带自有标记且 target 为
> 非用户 JS 时复用 target 的原生名称，不做全局 Proxy 解包或 JS 全局 toString 替换。
> Worker/Blob/Canvas 均返回带名原生串；普通 Proxy、Object.prototype 污染、JS 源码防泄漏、
> revoked Proxy 和 marker 不暴露等负例全部通过。直连 **32/32**，os1 全量 **40/40**，
> CreepJS **0% headless / 0% stealth**；报告 `kernel-156-t16-full-1793283724731.json`。
> 0001–0006 顺序 apply 重放与逐文件一致性检查通过。

**背景**：JS Proxy 无法让 V8 返回带名原生串；全局补丁会让 CreepJS stealth 升到 20%
（已回退，见 `COMPARISON_ZINIAO.md` §2）。这是紫鸟已具备而我们缺的最后一处指纹细节。

**产出**：

- 先交 spike 报告（`docs/adr/` 新增 ADR）：对比两条路线——
  (a) V8 层维护「包装函数 → 原生名称表」，序列化时回填；
  (b) Blink 侧避免 Proxy，直接返回真原生函数对象并携带内部指纹上下文。
  选定路线需论证对 CreepJS stealth 各项探针的影响。
- 按 ADR 实现补丁 + 对应探针断言。

**验收**：`Function.prototype.toString.call(Worker)` 返回
`function Worker() { [native code] }`；CreepJS 仍 `0% stealth`；探针矩阵不掉分。

**注意**：难度最高、风险最大，与 T13–T15 并行推进，不阻塞它们合并；
若 spike 证明两条路线都会引入新检测面，允许结论为「暂不做」并在 ADR 记录证据。

---

## T17 — 内核版本化分发与防裸启（T17A / T17B 完成）

> **T17A 本机启动授权（2026-11-02）**：桌面驱动每次启动签发独立随机 KEK 的 60 秒
> `auth-token` 信封，Chromium 0009 在浏览器进程原生解封并检查时效，随后清除 KEK 环境。
> 真实内核已验证合法启动，以及无令牌、错 KEK、密文篡改、过期四类拒启。该边界不替代
> 文件签名，也不宣称抵御本机 root/逆向。当前 156 生产画像本地探针 32/32，
> t1 代理外站全链路 40/40，Pixelscan `consistent`、无 masking，CreepJS headless/stealth 均为 0%。
> **T17B 离线分发（2026-11-04）**：新增 Ed25519 签名 ZIP 打包、主进程原生选包安装、
> 文件级 SHA-256 校验、多版本共存、原子激活与回滚。启动缓存内核前重新验签并逐文件校验；
> 可执行路径以签名清单为准。可信公钥只从主进程环境或文件读取，渲染层不能替换。
> 完整 dev component 包曾成功验签安装（870 文件，约 4.1 秒），但其 518 个 dylib 在内置盘
> 冷加载约 124 秒，超过 60 秒授权协议上限；因此暂存脚本已拒绝 component 分发包。
> 2026-11-04 本机 16GB、`-j4` 的 release 非 component 全量构建以 3 小时 28 分成功完成；
> 352 文件的 `156.0.8078.73` 签名包真实安装约 3.7 秒，验签后启动、CDP 检查和关闭合计约 9.6 秒，
> `kernelUsed=chromium-cdp`、`navigator.webdriver=false`，全过程无其他内核回退。一次性私钥及临时
> 签名目录已清理，日志保存于 `experiments/probes/results/t17b-release-smoke.log`。
> 0008 Release Worker 修复后重新产出 352 文件签名包，并再次通过真实验签安装、启动与关闭；
> 复验日志：`experiments/probes/results/t17b-release-worker-fix-smoke.log`。
> 在线下载更新仍未做，不将离线链路冒充完整商业更新系统；按环境固定版本和灰度升级见 T36。

**背景**：紫鸟内核按 `chrome_64_<ver>_<os>_ziniaobrowser.zip` 运行时下发，外壳不动换内核；
且内核校验 launcher 令牌拒绝裸启（防提取/防二次分发）。我们目前内核跟随 patchright
依赖，没有独立分发与保护能力。前置：T11、T13。

**产出**：

- 打包：`scripts/package-kernel.sh` 产出 `shadowedge-kernel_<ver>_<os>_<arch>.zip`
  - 清单（文件级 sha256 + 总签名）。
- 更新器（desktop 主进程）：下载 → 校验签名与哈希 → 解压到
  `Application Support/shadowedge/kernels/<ver>/` → 原子切换软链；多版本并存，
  支持按环境固定版本与全局回滚。
- 启动令牌：主进程为每次启动生成一次性加密串（复用 `@shadowedge/crypto`），
  经 `--shadowedge-launch-token` 传入；内核校验失败拒绝启动。
  密钥不落明文盘，令牌含过期时间防重放。
- 内核升级后的指纹回归：升级通道必须先跑探针验证「旧环境 seed 画像不变」再放行。

**验收**：断网时用已缓存内核正常启动；手工改一个字节的内核启动被拒；
模拟升级内核后旧环境探针复跑 40/40（画像零漂移，AGENTS.md §4 硬需求）。

---

## T18 — catalog 定期更新自动化

**背景**：T10 的机制已建好，但机制 ≠ 执行——`DEFAULT_DB` 仍停在 Chrome 130/131，
紫鸟 UA 与内核同版（150）。不滚动就是「静止画像」，时间越久越像机器人。前置：T12。

**产出**：

- `.github/workflows/ua-catalog-weekly.yml`：每周跑 `pnpm update-ua-catalog`，
  检测到 Chrome stable 新大版本时自动开 PR（标题含版本号，正文附三平台快照 diff 摘要）。
- PR 合并后触发夜间探针加跑一轮「新 catalog 新建环境」对照，
  确认新素材下一致性审计与探针矩阵全绿。
- 运营规则写入 `packages/fingerprint/catalog/README.md`：新版 Chrome 稳定版发布后
  N 天内必须跟进；旧快照永不删除。

**验收**：用历史版本号模拟一次升级流程，从 PR 自动创建到探针对照常跑全链路
无需手工命令；历史环境审计不受新快照影响（由 T12 保证）。

**注意**：本卡涉及新增 CI workflow，执行前先与维护者确认（AGENTS.md §7 对 CI 改动的约束）。

---

## T19 — 账号凭据托管与安全自动填充 ✅ 本地链路完成（2026-11-01）

> 已在 `packages/core` 定义账号凭据、自动填充结果及 `account:list / upsert / delete / autofill`
> 契约；桌面主进程新增 SQLite migration 3、`AccountRepository` 与自动填充服务，渲染层新增
> “账号”管理页。密码使用 `EnvelopeCrypto` 的 `account-secret` 用途做信封加密，更新时省略
> 密码会保留原密文，删除环境会级联删除凭据。
>
> 安全边界：没有密码 reveal IPC；自动填充只在主进程短暂解密，列表、返回值和审计均不包含
> 密码。业务 origin 强制 HTTPS，HTTP 仅限回环地址；页面必须精确匹配 origin，密码选择器
> 必须指向 `type=password`，默认只填充，显式 `submit: true` 才提交。非法 origin 的错误
> 信息不回显原始输入，避免 URL userinfo 中的凭据进入日志。
>
> 验收：仓储测试覆盖密文落库、相同 KEK 重启解密、保留密文、级联删除和 origin/userinfo
> 负例；真实自研 Chromium 跑通错误 origin 拒绝、非密码框拒绝、正确页面填充与提交，最终
> 提取 `alice:ok`，审计不含用户名或密码。完整类型检查、单元测试、lint 与 Electron 构建通过。
>
> 本卡完成的是本地核心功能，不包含团队授权、云端同步、2FA、设备撤销或密码轮换提醒。

---

## T20 — 网络层 Client Hints 同源 ✅（2026-11-02）

> 问题证据：页面 UA 已伪装为 Chrome 130，但服务端通过 `Accept-CH` 请求高熵信息后，
> `Sec-CH-UA-Full-Version-List` 仍返回真实 `Chromium 156.0.8078.73`。低熵
> `extraHTTPHeaders` 和页面 JS 注入都无法修复这个网络层矛盾。
>
> 已落地 `0007-network-user-agent-metadata.patch`：在
> `components/embedder_support/user_agent_utils.cc` 的浏览器进程共同入口，从
> `--shadowedge-fingerprint` 生成原生 `UserAgentMetadata`。品牌、完整版本、平台、
> 架构、位宽、型号、mobile 与 form-factors 均来自画像；保留原生 `Accept-CH` 协商，
> 不向首次请求无条件附加高熵头。
>
> 验收：dev 增量编译通过；真实 Chromium 首跳/次跳测试确认高熵完整版本不再泄露，
> 导航、302 跳转、fetch 的高低熵头与画像一致，Worker 脚本遵循原生协商策略且无真实
> 版本泄露。测试见 `apps/desktop/test/client-hints-smoke.test.ts`。
> 原有自研内核探针回归 32/32；完整 TypeScript 测试 123 passed / 9 skipped，
> lint、Electron 生产构建与 `verify-kernel.sh` 均通过。

---

## T21 — 全 Worker 作用域原生画像注入 ✅（2026-11-02）

> 问题证据：0003 只覆盖 ServiceWorker，Dedicated/Shared Worker 仍依赖 JS 构造器包装；
> Blob Worker 内再创建的子 Worker 没有主世界包装器，能够读到宿主机核数与内存。
>
> 已落地 `0008-all-worker-init-script.patch`：复用
> `WorkerGlobalScope::RunWorkerScript()` 的共同入口，在 classic/module Worker 自身脚本前
> 求值同一份 `--shadowedge-init-script`。原生入口覆盖每次 Worker 创建，嵌套 Worker 不再需要
> 递归转发源码。chromium-cdp 的 kernel 模式不再生成 Worker/Blob/URL.createObjectURL 包装，
> 也不再携带 `P.__injectSrc`；Patchright 的 shield 回退路径保持原实现。
>
> 验收：dev 增量编译通过；真实 Chromium 测试覆盖 classic、module、Shared、Service 以及
> Blob 外层/嵌套 Worker，UA、platform、languages、核数、内存、触摸点、UA-CH 与 navigator
> 自有属性全部和画像一致，原生 Worker/Blob 构造器 toString 保持带名原生串。
> 可重复验收见 `apps/desktop/test/worker-scope-smoke.test.ts`。与 T20 的 Client Hints
> 真实测试联合回归 2/2 通过；自研内核探针 32/32、Patchright 回退探针 20/20。
> 完整 TypeScript 测试 124 passed / 10 skipped，typecheck、lint、Electron 生产构建、
> `verify-kernel.sh --mode dev` 与补丁反向 apply 校验均通过。

---

## T22A — 批量环境生命周期核心 API ✅（2026-11-02）

> 新增 `profile:createMany / launchMany / closeMany` 契约与主进程实现，统一复用单个
> 创建、启动、关闭处理器，确保启动闸门、审计、会话记录和状态事件不绕路。批量项按输入顺序
> 返回 `Result<T, ErrorPayload>`；错误使用 IPC 可结构化克隆的载荷，单项失败不中断后续项。
> 操作串行执行，避免 16GB 开发机批量启动时产生瞬时内存峰值。
>
> 验收：`profile-batch.test.ts` 覆盖创建/启动/关闭三段链路中的中间项失败与后续成功；
> 真实 Chromium 冒烟以两个独立环境验证批量启动、 `kernelUsed=chromium-cdp`、状态持久化和
> 批量回收。批量选择/批量创建表单等 UI 属于 T22B，不在本卡。

---

## T22B — 批量环境管理 UI ✅（2026-11-02）

> 创建对话框支持一次创建 1–50 个环境，按 `名称-01` 形式命名并派生独立 seed；环境列表
> 支持逐项选择、全选、批量启动与批量停止，仅处理符合当前状态的目标。界面显示独立成功/
> 失败计数及 Patchright 回退数量，操作后保留有效选择，便于连续启动和停止。
>
> 真实 Electron UI 冒烟已在临时用户目录完成：批量创建两个环境、全选、以两个
> `chromium-cdp` 实例启动、批量停止并回到空闲；SQLite 中两份完整画像不同，进程与临时
> 数据均已回收。
>
> 联调同时发现并修复桌面生产构建漏拷 `packages/fingerprint/catalog` 的问题；构建现在
> 保留 `dist/catalog` 相对布局，新建环境和指纹预览不再因快照缺失而失败。

---

## T23 — 环境生命周期可靠性 ✅（2026-11-02）

> 内核把启动中的 Promise 纳入环境占用状态，重复启动立即返回 `E_PROFILE_BUSY`；启动中
> 停止会等待启动收口，再关闭实例与代理中继。桌面启动处理器同步检查最终活跃状态，避免
> 浏览器退出与状态写回之间的竞态；运行或启动中的环境禁止删除。
>
> 应用启动时同时收口孤儿会话和 `running / launching` 假状态；正常退出等待全部启动与
> 运行实例回收，再归零状态、结束会话并关闭 SQLite。主进程复用与 IPC 相同的桌面内核实例，
> 不建立第二条浏览器管理链路。
>
> 验收：单元测试覆盖并发双启动、启动中停止、批量退出回收、并发失败不覆盖已有会话、
> 删除保护和数据库恢复。真实 Electron 冒烟完成两轮“运行中退出”，对应 Chromium PID
> 均消失；写入模拟崩溃状态后重启恢复为空闲、可再次启动，最终无未结束会话。

---

## T24 — RPA 工作流持久化与桌面闭环 ✅（2026-11-02）

> 新增 SQLite `rpa_workflows / rpa_runs` 与仓储，工作流保存、更新版本、删除和运行历史
> 均持久化；引擎在 queued/running/终态同步快照，重启时将未完成运行明确标记为中断失败。
> 新增 `rpa:save / delete / listRuns / openArtifact` 白名单契约，产物打开同时校验运行
> 记录和所属目录，渲染进程不能借此读取任意本地文件。
>
> 桌面自动化页支持六种已执行验证的线性节点（打开、点击、输入、等待、提取、截图）、
> 排序和失败策略，能够选择多个运行中环境、传 JSON 参数、取消运行并查看进度、输出和
> 产物。脚本/HTTP/分支/循环、录制回放和拖拽画布不在本卡，未以占位按钮冒充完成。
>
> 验收：仓储测试覆盖版本递增、历史读取、异常恢复和路径防穿越；真实 Chromium 联合
> 回归确认终态时间、输出与产物历史完整。Electron UI 冒烟通过界面创建并启动环境、添加
> 五个节点、保存、传入 Ada 运行，得到 `Hello Ada`，截图和 JSON 均真实落盘，切换页面后
> 工作流与运行结果仍可读取。

---

## T25 — 环境加密备份与迁移 ✅（2026-11-02）

> 新增 `.sebackup` 版本化备份格式与 `profile:export / import` 白名单契约。备份包含环境画像、
> 完整代理链及其凭据、Cookie、LocalStorage，并在 T30 扩展 IndexedDB；口令经 PBKDF2-SHA256（210000 次）派生
> KEK，再以 AES-256-GCM 信封加密。文件选择与读写由主进程原生对话框完成；导出结果和
> 成功导入均记录审计，用户取消导入时不创建环境或代理。
>
> 导出读取运行中环境的当前浏览器状态；导入严格校验信封、画像一致性和载荷结构，错误口令或
> 密文篡改均拒绝。每次导入生成全新环境/代理 ID 并重映射代理链，不覆盖现有环境。浏览器状态
> 使用本机 KEK 再加密存库，首次通过启动闸门后恢复；只有恢复成功才删除待恢复密文，失败可重试。
>
> 验收：单元测试覆盖密文不泄露敏感值、新 ID 与代理密码重映射、错误口令和篡改拒绝。真实
> Chromium 冒烟完成“源环境写入 Cookie/LocalStorage → 加密导出 → 新环境导入 → 首次启动恢复”，
> 并确认备份密文不包含环境名、Cookie、LocalStorage 或代理密码。完整 TypeScript 回归
> 135 passed / 17 skipped，typecheck、lint 与 Electron 生产构建通过。
>
> 当前边界：T30 起包含 IndexedDB，T33 起包含 OPFS；不迁移 SessionStorage、账号凭据库、RPA 工作流/
> 运行历史，不提供自动云同步；这些项目不得被描述为已经包含在环境备份内。

---

## T26 — 环境数据目录迁移与安全删除 ✅（2026-11-04）

> 新建和导入环境统一使用 Electron `userData/profiles/<环境ID>` 绝对路径。启动时只迁移旧版
> 精确的 `cwd/profiles/<ID>` 布局，新旧目录同时存在或路径越界时拒绝猜测/合并。删除先将目录
> 隔离改名，再事务删除 SQLite；数据库失败恢复原目录，提交后残留下次启动清理。环境删除会级联
> 清理账号凭据和状态快照，不再留下 Chromium Cookie/LocalStorage 文件。删除与关闭均采用
> 原子隔离目录：删除前崩溃会回滚，快照提交后的关闭残留可安全清理，不使用半个目录恢复。

---

## T27 — macOS Keychain 本地 KEK ✅（2026-11-04）

> macOS 本地随机 KEK 改由 Keychain 保管。旧 `vault.key` 在 Keychain 写入并读回逐字校验成功
> 后才删除；失败保留旧文件并停止解锁，不静默降级。`security` 的密码通过 stdin 双重输入，
> 不进入进程参数。测试环境可显式注入 `SHADOWEDGE_KEK`，不会读写开发者真实 Keychain。
> 其他平台暂时保留 0600 文件并明确记录边界，未冒充完成 DPAPI/Secret Service。

---

## T28 — 备份导入事务与载荷加固 ✅（2026-11-04）

> 代理、环境与加密状态在同一个 SQLite `BEGIN IMMEDIATE` 事务中写入，任一步失败全部回滚。
> 新增代理重复 ID、缺失上游、循环链、环境代理缺引用、端口和 IndexedDB 结构校验；导入不再
> 信任备份中的旧 `secretRef`。故障注入在最后一次状态写入抛错，确认环境、代理和快照均为零残留。

---

## T29 — 环境分组、编辑、搜索与启动 URL ✅（2026-11-04）

> 新增 SQLite 分组及白名单 IPC，桌面支持先建分组、创建/编辑环境、按名称搜索、按分组筛选和
> 安全删除。创建与编辑均可配置最多 20 个 HTTP(S) 启动页面，启动后真实打开；单个页面加载失败
> 只告警，不关闭已运行环境。`profile:update` 在运行时重建白名单对象，额外传入的状态、画像和
> 存储路径无法越过类型系统污染主进程。

---

## T30 — IndexedDB 加密迁移 ✅（2026-11-04）

> `.sebackup` 与本地快照统一使用 Patchright `storageState({ indexedDB: true })`，保留数据库
> 版本、对象仓库、索引、键和值。格式保持 v1 向后兼容，旧备份没有该字段时按零数据库处理。
> 真实 Chromium 已验证含对象仓库和索引的登录数据库跨环境导出、导入并首次启动恢复；备份
> 密文不包含 IndexedDB token，返回结果新增数据库计数。

---

## T31 — 正常退出加密快照与崩溃恢复 ✅（2026-11-04）

> 内核关闭新增捕获钩子，单独停止、启动中停止、批量停止和 Electron 退出均先捕获 Cookie、
> LocalStorage、IndexedDB，再关闭浏览器；快照写库成功后才清理环境目录。启动时保存基线快照，
> 不删除恢复后的快照。若上次异常退出留下目录，下次启动优先使用目录内较新的已落盘状态，
> 防止旧快照回滚；目录缺失的 Cookie 会从快照补回，同名同域路径以目录为准。快照保存失败
> 同样保留目录。真实 SIGKILL 测试验证恢复语义，LocalStorage
> 尚未刷盘的修改不承诺可恢复。SessionStorage、OPFS 仍不在本卡范围内。
>
> 最终回归：完整单元/集成测试 148 passed / 19 skipped，typecheck、lint 和桌面生产构建通过；
> 最新构建的七个真实 Chromium/Electron 联合场景全部通过，覆盖加密备份迁移、加密快照与崩溃恢复、
> 环境管理 UI、应用退出回收、批量生命周期、批量管理 UI 和 RPA UI。

---

## T32 — 双环境隔离与重启零漂移探针（2026-11-04）

> `scripts/probe/` 新增可提交的真实内核探针，覆盖主世界、Dedicated Worker、ServiceWorker、
> WebRTC 私网地址、Cookie、LocalStorage、IndexedDB 和双 seed 画像隔离；稳定性场景串行重启
> 20 次，避免 16GB 开发机并行耗尽内存。报告原子写入 `experiments/probes/results/`。
> 测试已迁入 desktop Vitest 工作区，默认仅注册不启动；设置 `SHADOWEDGE_PROBE_SMOKE=1`
> 和 `SHADOWEDGE_KERNEL_EXECUTABLE` 后执行真实浏览器。原 `pnpm probe` 外站基线保持不变，
> 新矩阵使用 `pnpm probe:matrix`；T36 起增加本地请求 UA/语言、首请求高熵头最小化及
> 协商后 UA-CH 检查，跨版本报告用 `pnpm probe:compare` 逐字段比较。
> 自研 Chromium 实测 13 项中 12 通过、0 失败、1 项代理出口检查因未配置预期 IP 而跳过；
> 20 次重启画像哈希零漂移。开发版报告：`experiments/probes/results/t32-final-1793756042.json`。
> Release `156.0.8078.73` 复跑同为 12 通过、0 失败、1 跳过及 20 次重启零漂移，报告：
> `experiments/probes/results/t32-release-156.0.8078.73.json`。该轮先发现直接 V8 执行导致
> Release-only Dedicated Worker 卡死；0008 已改用 Blink `ClassicScript` 标准入口，最小及完整注入均回归通过。

---

## T33 — OPFS 加密快照与备份迁移（2026-11-04）

> Cookie、LocalStorage、IndexedDB 之外，快照和 `.sebackup` 现包含 OPFS 目录及二进制文件；
> 备份计数、导入结构、规范 Base64 与路径穿越校验同步覆盖。全部 origin 合计最多 2000 个文件、
> 4000 个目录/文件条目和 128MB 解码内容，不能通过拆站点绕过预算；备份选择器上限相应调整为
> 320MB（覆盖 OPFS 与加密信封两次 Base64 膨胀），导出超限时不写出无法再次导入的文件。
> SessionStorage 仍不承诺跨会话恢复。
> 真实 Chromium 的加密备份跨环境恢复及 SIGKILL 崩溃快照两项 smoke 均通过，包含 2MB 二进制 OPFS 文件。

---

## T34 — RPA 条件分支、有限循环与运行预算（2026-11-04）

> 图契约新增条件真假分支、计数循环、最大执行步数和总超时；编辑器支持连线与
> `inputs` / `outputs` / `loop.<节点ID>.index` 插值。运行器逐环境互斥，循环限定 0..1000 次，
> 默认最多 10000 步、总超时 5 分钟；缺失输出的 `exists` / `notExists` 判断不会误报节点失败。
> 普通节点重试、失败后继续、取消和截图/JSON 产物保持兼容。

---

## T35 — Amazon / Shopee / TikTok 平台站点策略（2026-11-04）

> 内置常见区域站点及推荐语言、IANA 时区和出口国家/地区。创建环境时可应用站点推荐画像；
> 绑定代理时仍优先跟随真实出口。已有环境切换站点只更新平台标签、站点 ID 与启动页，seed 画像逐字段不变；
> 站点 ID 独立落库，编辑启动页不能造成区域策略误判；普通编辑会明确脱离一键站点策略。
> 运行中支持在当前上下文打开新站点。切换和启动均校验代理 `countryCode`，不匹配或缺失时拒绝，
> 防止“美区站点配德国出口”。目前是小规模内置策略，不宣称已覆盖紫鸟的全量站点库。

---

# 2026-11-04 复审：下一轮优先级

## T36 — 按环境固定内核版本与升级灰度（2026-11-05 完成）

> `BrowserProfile.kernelVersion` 与 SQLite migration 8 已落地。使用签名安装目录时，新环境固定创建时
> 版本，历史环境只回填一次；全局安装、激活或回滚不再改变旧环境。显式开发路径模式不自动固定版本。
> 启动按环境直接解析 `versions/<version>/payload`，每次仍重新验签和逐文件校验；缺版本或历史环境未固定
> 且遇到安装目录时分别报 `E_KERNEL_VERSION_NOT_FOUND` / `E_KERNEL_VERSION_NOT_PINNED`，不静默换内核。
>
> 桌面“内核升级”入口实现“创建验证克隆 → 人工探针对照 → 明确确认 → 原环境迁移”。克隆保持 seed 画像
> 不变，复制加密站点状态、使用独立目录和 local-only 同步；未确认、关系不匹配、环境忙碌或目标未安装均拒绝。
> 备份导入保留原固定版本，旧备份按导入时默认版本固定，并清除原设备的灰度关系。准备和提交均写审计。
>
> 两个真实 Release 已完成验收：`156.0.8078.73`（`2f9a1109`）与 `156.0.8078.91`
> （`e7e3e86b`），不是同一二进制修改版本号。`.91` 在 16GB、`-j4` 下构建 2 小时 32 分成功，
> 9 个补丁均干净应用。两版分别通过 16 项矩阵中的 15 项、0 失败、1 项代理出口跳过及 20 次重启零漂移；
> 新增本地网络探针覆盖首请求高熵头最小化、协商后 UA-CH、请求 UA/语言、WebRTC、主世界与两类 Worker。
> 基线：`experiments/probes/results/t36-baseline-156.0.8078.73.json`；候选：
> `experiments/probes/results/t36-candidate-156.0.8078.91.json`。
>
> `pnpm probe:compare` 对检查状态与详情逐字段比较，结果为 16 项不变、0 项差异；临时端口和 Referer
> 在采集时不计入画像，其他差异不会自动豁免。对照报告：
> `experiments/probes/results/t36-comparison-156.0.8078.73-to-156.0.8078.91.json`。
> 两个 352 文件签名包使用同一测试公钥；真实安装后的“旧版原环境 → 新版验证克隆 → 明确确认 →
> 原目录新版重启”三阶段画像一致，日志：`experiments/probes/results/t36-real-upgrade-smoke.log`。
> 在线更新服务仍不在本卡范围内。

## T37 — RPA 硬超时与取消语义（2026-11-04）

> 所有节点执行统一经过硬取消收口：总 deadline 会限制 navigate 和元素等待的节点超时；取消或总超时时关闭
> 当前 RPA 页面，迫使挂起的 CDP 调用失败，并等待原调用实际落定后才释放环境互斥锁，避免后台节点继续修改
> 页面或写入截图。总超时仍记录为 `failed`，手动取消记录为 `cancelled`；后续节点不执行，下一工作流可在同
> 环境创建新页面继续运行。同步抛错也会清理 abort listener。
>
> RPA 单元测试 24 项通过；`rpa-cancellation-smoke.test.ts` 使用本地挂起 HTTP 导航和真实开发版 Chromium，
> 已分别验证总超时、手动取消、页面关闭、无后续截图产物和环境锁释放。其他 CDP 节点共用同一收口路径，
> 本卡不把挂起 navigate 的实测扩大描述为所有 CDP 调用均已逐项实测。后续再做录制回放和定时调度。

## T38 — RPA 单标签页录制与回放（2026-11-04）

> 新增主进程录制器及 `rpa:startRecording / stopRecording` 白名单契约。桌面可选择运行中环境和起始 URL，
> 在真实 Chromium 标签页操作后生成可编辑工作流。记录主框架导航、可信点击和普通输入 change；选择器优先
> 唯一 ID、`data-testid` / `data-test` / `name` / `aria-label`，回退到带 `nth-of-type` 的 DOM 路径。
> 初始化脚本可释放，停止后不会在新文档继续累积监听器；单次最多 500 个操作，文本最多 10000 字符。
>
> 密码及 `current-password` / `new-password` 字段只统计数量，不读取或发送密码值；普通文本属于工作流内容，
> 保存前仍需用户审阅。录制期间同环境 RPA 独立失败，不影响其他批量项；RPA 运行中也禁止开始录制。
>
> 真实 Chromium 已验证“导航 → 输入 Ada → 输入密码 → 点击 → 生成图”，密码哨兵未出现在录制结果或持久化
> 工作流中，随后立即回放得到相同页面结果。Electron UI 已验证开始/停止后生成一个可编辑导航节点。
> RPA 单元测试 27 项通过。当前边界是单标签页、导航/点击/文本输入；不宣称支持多标签页、下拉框、
> contenteditable、文件上传、自动提取或 script/http 节点录制。定时调度留到下一卡。

## T39 — RPA 持久化定时调度（2026-11-04）

> SQLite migration 9/10 新增每工作流一份定时配置及加密输入。支持 1..10080 分钟固定间隔、环境多选、
> 启停和下次/上次错误展示；输入 JSON 使用独立 `rpa-schedule-input` 信封加密，列表 IPC 不回传参数值。
> 到期任务逐环境串行执行，空闲环境自动启动，结束后只关闭本次自动启动的环境；用户预先打开的环境保持运行。
>
> 应用重启后的过期任务只补跑一次，从当前时间计算下一周期，不追赶停机期间的历史次数。失败写入 `lastError`
> 且不会阻断后续周期；配置在执行期间被修改或停用时不会被旧快照覆盖。退出先停止调度并等待当前调度收口，
> 再关闭浏览器和数据库。定时器只在桌面进程存活时有效，不是系统级唤醒或云端调度服务。
>
> 单元测试覆盖到期、环境去重、停机补跑、失败恢复、停用和加密输入；IPC 测试覆盖持久化与删除级联。
> Electron UI 已实测启用/停用；真实 Chromium 已分别验证“空闲环境自动启动→成功提取→自动关闭”和
> “预启动环境成功执行→保持运行”。当前为固定间隔，不包含 cron、时区日历或并发调度策略。

## T40 — 真实代理、外站探针与目标站点验收（2026-11-05）

> Release `156.0.8078.91` 经 `t1` 真实双跳代理完成外站复测，40/40 通过；CreepJS
> headless/stealth 均为 0%，BrowserLeaks 无真实 IP 泄漏，Pixelscan 为 `consistent`，Browser、
> Fingerprint、Location、Bot check 均通过。首次 Pixelscan 前页面/浏览器退出造成 36/40，增加生命周期
> 日志后完整复测未复现，不将首次失败描述成内核指纹缺陷。成功报告：
> `experiments/probes/results/t40-release-156-91-rerun-1793892464646.json`。
>
> 本地矩阵补齐 `--proxy/--proxy-file/--upstream`，通过产品现有 `BrowserKernel → 本地中继 → 真实代理`
> 链路验证出口，不再用直连 IP 冒充代理结果。真实出口、双环境隔离、Worker/ServiceWorker、WebRTC、
> 网络画像及 20 次重启共 16/16、0 跳过，报告：`experiments/probes/results/t40-matrix-156.0.8078.91.json`。
>
> Amazon DE 使用德国 `os1` 通过地区闸门，但两次公开首页验收分别为连接错误和空页面；绕过 Chromium
> 的原始代理隧道同样得到 HTTP 202、0 字节正文，已归类为 Amazon/出口链路外部阻塞，未记为站点通过。
> 当前中国出口不满足 Amazon/Shopee/TikTok 已配置站点地区，德国出口只匹配 Amazon DE；Shopee 与
> TikTok 仍需对应地区代理后再验收，未绕过地区闸门，也未尝试账号登录或验证码。

---

## T41 — Chromium 156.0.8078.91 UA Catalog（2026-11-05）

> 新增不可变 `chrome-156.0.8078.91.json`，新建环境默认 Catalog 与当前内核一致；131 和
> 156.0.8078.73 快照保持只读。测试对两个历史 Catalog、两个固定 seed 的完整画像 JSON 固定
> SHA-256，防止仅比较“同代码重算”而漏掉跨版本漂移。91 画像经真实代理矩阵 16/16、20 次重启
> 零漂移，报告：`experiments/probes/results/t41-matrix-156.0.8078.91.json`。
> 2026-11-06 深回归中，91 Catalog 外站同样 40/40，Pixelscan `consistent` 且未提示 masking，报告：
> `experiments/probes/results/t41-release-156-91-full-1793924994388.json`；历史 73 Catalog 也在当前
> 内核通过真实代理 16/16 与 20 次重启零漂移，报告：
> `experiments/probes/results/t41-legacy-matrix-156.0.8078.73.json`。
> 在线 Catalog 更新与 CI 自动 PR 仍后置，本次是离线固定版本快照。

---

## T42 — RPA 复杂控件与多标签页（2026-11-05）

> 新增 `select/check/upload/download/newTab/switchTab` 节点及桌面编辑器配置；`click/type/extract`
> 和新增控件节点支持 `frameSelector`，开放 Shadow DOM 由 Patchright 原生 CSS 穿透。下载等待与点击
> 并发执行，文件名清理后保存为 0600 产物；切换标签后后续节点和硬取消都作用于当前页。
>
> 真实 Chromium 验收通过：Iframe 输入/下拉/勾选、Shadow DOM 输入/提取、弹窗、新建与切换标签、
> 文件上传、真实下载及内容逐字校验。日志：`experiments/probes/results/t42-rpa-controls.log`。
> 高级节点的自动录制由 T44 补齐；文件上传本机路径仍不自动记录。

---

## T43 — 全量加密环境备份（2026-11-05）

> 在 Cookie、LocalStorage、IndexedDB、OPFS 之上补齐按标签页保存的 SessionStorage、账号凭据、
> RPA 工作流、调度配置及加密输入。备份仍使用口令 PBKDF2 + 信封加密，导入后用本机 KEK 再加密；
> 代理、环境、状态、账号、工作流与调度在同一 SQLite 事务中写入。旧 v1 备份缺少扩展字段时继续兼容。
>
> 导入调度默认停用并清除过期执行状态，避免旧备份立即触发自动化，用户审阅后再启用。真实 Chromium
> 已验证两个同 origin 标签页的 SessionStorage 分别恢复，账号密码、工作流和调度输入完整迁移；
> 密文不包含 session/account/schedule 敏感哨兵。日志：`experiments/probes/results/t43-profile-backup.log`。
> 2026-11-06 扩展审查修正了工作流导入校验：`validateGraph()` 返回 `valid/errors` 而非抛错，导入器现在
> 强制检查 `valid`；新增无效入口拒绝和最后一次调度写入故障的全事务回滚测试。18 个真实
> Chromium/Electron 测试文件串行回归全部通过，覆盖账号填充、网络 Client Hints、启动令牌、环境隔离、
> 快照/备份/批量生命周期、RPA 运行/取消/复杂控件/录制/调度、Worker、三组 Electron UI 和退出回收。
> 最终门禁：189 passed / 28 skipped，typecheck、lint、Electron 生产构建及 `git diff --check` 全绿。

---

## T44 — RPA 高级录制与多标签页闭环（2026-11-06）

> 在 T38 的导航/点击/普通文本基础上，新增单选下拉框、checkbox/radio、`contenteditable`、开放
> Shadow DOM、单层 Iframe、新建标签页、链接弹窗和切回主页的录制。普通文本改为在 `input` 时增量记录并
> 合并同目标事件，停止录制时不会丢失尚未失焦的最后一段文本；密码仍只统计数量，不读取值。
>
> Shadow DOM 在每个 root 内生成唯一选择器，以 `host >> css=target` 回放；动态 root 通过 MutationObserver
> 和短周期扫描发现，不改写 `attachShadow` 原生函数。Iframe 使用短期随机 DOM 标记识别文档，再于父框架生成
> `frameSelector`，停止后清理。T46 已在此基础上补齐嵌套 Iframe 和 multiple select；文件上传仍不生成
> 错误节点，计入 `droppedActions`，文件本机路径及内容不进入工作流。
>
> 无 opener 的页面记录为 `newTab`；链接弹窗记录为原点击加 `switchTab`，避免回放时重复创建标签页。
> `switchTab` 新增最多 30 秒的可选有界等待，录制图默认 10 秒，以覆盖点击后弹窗尚未出现的竞态。
> T44 的关闭页面边界已由 T46 解除：现在生成真实 `closeTab` 节点，并按压缩后的标签页索引继续录制。
>
> 真实 Chromium 已验证“高级控件/Shadow DOM/Iframe → 手工新标签 → 链接弹窗 → 返回主页”录制、保存和
> 回放后的逐字段状态，并验证文件名和文件内容不落图；原密码录制回放同步回归通过。证据：
> `experiments/probes/results/t44-rpa-recording-regression.log`。
> 最终门禁：190 passed / 29 skipped，typecheck、lint 全绿；19 个真实 Chromium/Electron
> 测试文件串行回归全部通过，汇总：`experiments/probes/results/full-smoke/summary.json`。

---

## T45 — 平台策略目录版本化与历史环境固定（2026-11-06）

> 平台站点策略从主进程硬编码上提到 `packages/core` 的不可变目录快照。`2026-11-04.1`
> 完整保留原 9 个站点；`2026-11-06.1` 原字段不变，追加 Amazon CA、Shopee TW、TikTok JP。
> 两个快照的完整 JSON 均有固定 SHA-256，历史站点前缀一致性与防御性副本由测试保证。
>
> `BrowserProfile.platformPolicyVersion`、SQLite migration 11 和仓储映射已落地。历史平台环境只回填
> `2026-11-04.1` 一次并写迁移审计；新环境固定当前目录，启动区域闸门按环境版本解析，未知版本不
> 回退。显式切换站点才升级目录并记录前后版本，seed 画像逐字段不变；普通编辑继续脱离一键站点策略。
>
> IPC 返回带版本的完整目录，桌面创建页显示目录版本。加密备份自动携带版本：旧备份按导入时目录
> 固定，已有版本原样恢复，未知版本或不匹配站点在事务前拒绝。规则与后续更新流程见
> `docs/PLATFORM_POLICIES.md`。真实 Electron 已验证版本展示、新站点选项及原管理闭环，日志：
> `experiments/probes/results/t45-platform-policy-ui.log`。新增站点仅完成配置和 UI 验收，没有
> 匹配地区代理时不宣称真实站点通过。最终门禁：197 passed / 29 skipped，typecheck、lint、
> Electron 生产构建及 `git diff --check` 全绿；19 个真实 Chromium/Electron 套件串行回归全部通过。

---

## T46 — RPA 录制边界：嵌套框架、多选与关闭标签页（2026-11-06）

> Core 契约新增 `closeTab`、完整 `frameSelectors` 路径和多选 `values`，保留旧 `frameSelector` 与单值
> `select.value` 兼容。执行器支持 1–8 层 Iframe、最多 100 个选中值；关闭后台页不改变当前页，关闭当前页后
> 优先回退到同索引页面，越界时回退到最后一个剩余页面。录制器使用相同的索引压缩和回退规则，图生成及桌面
> 编辑器同步支持新节点和参数。
>
> 录制注入改为 BrowserContext 级 `exposeBinding` 与 init script，利用 `source.page` 路由事件，新页面首个文档
> 自动继承录制能力；binding 事件先于 page 事件到达时会先纳管页面。就绪标记等待监听器和 binding 均可用，
> 不靠固定延时规避竞态。真实 Chromium 连续验证多选 US/CA、两层 Iframe 输入、三个新标签页输入、关闭后台页、
> 关闭当前页及保存后完整回放，所有字段和最终单标签页状态一致。
>
> 四个真实 RPA 录制/控件套件回归通过，日志：`experiments/probes/results/t46-rpa-recording-regression.log`。
> 最终门禁：198 passed / 30 skipped，typecheck、lint、Electron 生产构建和 `git diff --check` 全绿；20 个真实
> Chromium/Electron 套件串行通过，汇总：`experiments/probes/results/full-smoke/summary.json`。

---

## T47 — 多 Chromium 实例并行隔离与录制关闭竞态（2026-11-06）

> 新增三个真实 Chromium 实例同时运行的隔离验收：三个环境使用相同页面结构和选择器，并行写入不同的
> Cookie、LocalStorage、SessionStorage、主框架/嵌套 Iframe 文本及新标签页文本，随后同时停止录制、保存并
> 并发回放。逐环境断言图中没有任何其他环境标记，标签页关闭和嵌套路径完整，回放后存储、字段、UA 画像和
> 用户目录仍各自匹配。修复后连续 5 轮全部通过，证据：
> `experiments/probes/results/t47-multi-instance-stress.log`。
>
> 压测第二轮发现标签页输入偶发丢失，但没有串入其他环境。原因是页面实际关闭后，已送达的关闭前 binding
> 事件被 `page.isClosed()` 提前丢弃；现在允许已纳管页面的关闭前事件进入原环境队列。修复后 5/5 轮通过，
> 原 RPA 录制边界和完整真实套件均回归通过。双实例 `os1/t1` 真实代理出口隔离也通过，日志：
> `experiments/probes/results/t47-parallel-proxy-isolation.log`。
>
> 最终门禁：198 passed / 31 skipped，typecheck、lint、Electron 生产构建和 `git diff --check` 全绿；21 个真实
> Chromium/Electron 套件串行通过，汇总：`experiments/probes/results/full-smoke/summary.json`。


---

## T48 — 代理风险真实化、来源状态与健康缓存（2026-11-06）

> 删除固定 `blacklisted=false` 的误导语义。代理健康结果现在分别表达总体 `clear/caution/high/unknown`、
> DNSBL `clear/listed/unknown`、可选地理分类与风险分；任一 Spamhaus ZEN 或 SpamCop 有效名单记录命中直接判高风险，
> 单来源超时或服务失败只将该来源标为 `unknown`，不会冒充安全，也不会把可达代理误判为不可达。DNSBL 只表示
> 垃圾邮件/滥用名单状态，不宣称等同电商平台风控结论。
>
> 健康检查增加按代理隔离的 5 分钟 TTL 缓存与在途请求去重；手动检查强制刷新，代理编辑主动失效，
> 过期或失败结果不会作为新鲜结果返回。桌面 UI 分来源展示名单状态、地理分类、实时/缓存与到期时间。
> `os1,t1` 真实代理专项通过，日志：`experiments/probes/results/t48-proxy-risk-real.log`。

---

## T49 — RPA 定位韧性、动作等待与持久化失败诊断（2026-11-06）

> 录制目标在保留原首选 CSS 的同时，最多追加 5 个唯一属性、ARIA role 和语义文本候选，旧工作流无需迁移。
> 回放时在节点总超时内轮询全部候选，不再让失效首选独占超时；点击、输入、选择和勾选要求元素可见、启用且
> 位置稳定，上传允许 attached/hidden。真实 Chromium 已验证录制后删除元素 ID、延迟重建、暂时禁用和移动元素，
> 仍能依靠候选恢复执行。
>
> 最终失败新增结构化节点诊断：节点 ID/类型、错误码、实际尝试次数、去 query/hash 的页面 URL，以及可选截图。
> 截图与 `failure.json` 权限均为 0600，JSON 不保存工作流输入值；retry 只在最终失败采集一次，continue 不生成
> 最终失败诊断。SQLite migration 12 持久化诊断，旧数据库升级和关闭重开恢复均有测试。真实专项与六个 RPA
> 录制/并行隔离套件已通过，日志：`experiments/probes/results/t49-rpa-resilience.log`、
> `experiments/probes/results/t49-rpa-resilience-regression.log`。
>
> Canvas C++ 按 ADR 0005 的触发条件重新复评：当前 Chromium `156.0.8078.91` 原生/JS 对照仍为 20/20，
> 未发现必须下沉的新证据，继续维持 JS 注入，不创建 C++ Canvas 补丁。该结论不扩展到未测的 OffscreenCanvas、
> 所有格式或所有 OS/GPU；后续必须先提供失败样本与原生对照再重开决策。
>
> 最终门禁：209 passed / 33 skipped，typecheck、lint、Electron 生产构建和 `git diff --check` 全绿；22 个真实
> Chromium/Electron 套件串行通过，真实代理风险专项通过，汇总：`experiments/probes/results/full-smoke/summary.json`。

---

## 后续 P1/P2

- Windows DPAPI、Linux Secret Service 本地 KEK，及对应真实系统测试（当前仅 macOS Keychain 完整落地）。
- 团队 RBAC、环境共享、加密云同步与审计协作；在单机核心链路稳定后推进。
- 平台策略目录已由 T45 版本化；补充 Shopee SG/MY/PH、TikTok US/UK 及 Amazon 其他地区的匹配代理后，继续 T40 真实站点验收。
- 在线内核更新、catalog CI 自动 PR、夜间 runner 属于发布/运维链路，按当前“开发优先”决定继续后置；
  本卡未修改 CI，也不把本地脚本描述成已启用的自动化服务。
