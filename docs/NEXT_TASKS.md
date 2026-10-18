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

## T2 — 指纹一致性交叉校验

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

## T3 — 代理健康检查真实实现

**背景**：`ProxyManager.check()` 目前返回硬编码假数据。

**产出**：
- 通过代理请求 IP 查询服务，取真实出口 IP、地理位置、时区、ASN
- 测量真实延迟（三次取中位数）
- 失败时返回 `reachable: false` 并填 `error`，不要抛异常
- 增加 `checkAll()` 并发批量检测，用 `Result<T>` 收集结果，单个失败不影响其他

**验收**：对一个不存在的代理执行 `check()`，返回 `reachable: false` 而非抛错。

**注意**：`ProxyManager.upsert()` 目前用 base64 假装加密（`enc:` 前缀），必须换成 `@shadowedge/crypto` 的 `EnvelopeCrypto.seal()`。

---

## T4 — 启动前一致性闸门

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

## T6 — 环境创建/编辑 UI

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
