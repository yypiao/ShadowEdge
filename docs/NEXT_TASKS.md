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

## T17 — 内核版本化分发与防裸启（T17A 已完成，T17B 待做）

> **T17A 本机启动授权（2026-11-02）**：桌面驱动每次启动签发独立随机 KEK 的 30 秒
> `auth-token` 信封，Chromium 0009 在浏览器进程原生解封并检查时效，随后清除 KEK 环境。
> 真实内核已验证合法启动，以及无令牌、错 KEK、密文篡改、过期四类拒启。该边界不替代
> 文件签名，也不宣称抵御本机 root/逆向。当前 156 生产画像本地探针 32/32，
> t1 代理外站全链路 40/40，Pixelscan `consistent`、无 masking，CreepJS headless/stealth 均为 0%。
> T17B 的签名分发、下载更新、原子切换与回滚仍待做。

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
