# ShadowEdge 开工总纲

> 本文件是已确认的板块划分与工作顺序，后续所有开发从这里开始。
> 详细功能拆解见 `docs/FEATURE_MATRIX.md`，单项任务背景/产出/验收见 `docs/NEXT_TASKS.md`。
>
> **2026-09-18 路线变更**：内核方案由「自研补丁 Chromium / 闭源 CloakBrowser」改为
> 「开源双驱动：Camoufox 主 + Patchright 备，网络层用 Xray-core」，见
> [ADR 0003](adr/0003-open-source-kernel-drivers.md)；竞品逆向依据见
> [RESEARCH_ZINIAO_RE.md](RESEARCH_ZINIAO_RE.md)。本文中涉及自研 C++ 补丁、
> 自建指纹素材库的条目以 ADR 0003 为准。
>
> **2026-10-14 路线修订**：Chromium 优先——Patchright 升为主驱动，Camoufox 降为可选备驱动；
> 指纹补齐（方案 A：JS 注入 / 方案 B：C++ 补丁）待探针裁决实验定夺，见
> [ADR 0004](adr/0004-chromium-first-patchright-primary.md)。所有组件零付费绑定、
> 开发者环境零 C++ 工具链。

## 一、产品定位

对标紫鸟浏览器（指纹浏览器 + 多账号安全运营平台），在以下五点做差异化超越：

1. **内核级反检测** —— 集成开源源码级补丁内核（Camoufox 主 / Patchright 备），而非 JS hook；Worker/iframe 无死角，且不被闭源内核按并发抽成。
2. **指纹零漂移** —— seed 确定性生成，升级后环境指纹不变，且可审计篡改。
3. **启动一致性闸门** —— 指纹维度互相矛盾或与出口 IP 地理冲突时拒绝启动。
4. **端到端加密** —— 账密/Cookie 服务端不可见；密码由主进程注入，操作员接触不到明文。
5. **开放自动化** —— 链式代理、出口地理自动对齐、OpenAPI/CDP + RPA 人类化操作。

## 二、板块划分

| 板块 | 范围 | 核心包/目录 |
| --- | --- | --- |
| A. 浏览器环境 | 环境 CRUD、分组、批量创建、云迁移、切站点 | `packages/kernel`、`apps/desktop` |
| B. 指纹反检测 | 确定性画像、一致性校验、C++ 补丁、探针评分 | `packages/fingerprint`、内核补丁 |
| C. 网络与 IP | 代理导入/检测、链式代理、地理对齐、DNS 防泄露 | `packages/proxy`、`packages/kernel` |
| D. 账号安全 | 账密托管自动填充、水印、2FA、临时授权、交接、互斥锁 | `packages/crypto`、desktop、server |
| E. 团队协作审计 | RBAC、资源 ACL、操作时间线、截图回放、哈希链审计 | `apps/server`、`packages/core` |
| F. 自动化 RPA | 工作流引擎、CDP 操作、录制回放、定时任务、平台模板 | `packages/rpa`、`packages/sdk` |
| G. 平台与商业 | 平台策略包（300+ 站点）、套餐计费、敏感页拦截 | server、策略库 |

## 三、工作顺序（已确认）

原则：**先建技术护城河，再补商业功能。** 团队/计费无技术风险随时可加；指纹与隔离做不好产品不成立。

### 阶段 0 — 骨架（已完成 ✅）
- monorepo、core 契约、IPC 白名单、8 个领域包、Electron/Fastify 骨架
- seed 指纹生成器、信封加密、18 个单测全绿

### 阶段 1 — 指纹护城河（当前，先做）
- [x] **T0（新增，最先）** 探针裁决实验：Patchright+JS注入 vs Camoufox vs 紫鸟对照，
      CreepJS/browserleaks 信任分对照，裁决 ADR 0004 的指纹补齐方案
      → 已完成（2026-10-15）：方案 A 通过，报告见 docs/T0_PROBE_REPORT.md；紫鸟对照与
      信任分自动抓取列入下一轮补测
- [ ] **T2** 指纹一致性交叉校验（UA/CH 自洽、屏幕差值、平台与 GPU/触摸点相容、字体子集）
- [ ] **T8（部分）** 探针页雏形，先能量化指纹分数

### 阶段 2 — 本地可用闭环
- [x] **T1** SQLite 持久层（替换内存 Map，代理密码密文存储）→ 2026-10-18 完成（node:sqlite）
- [x] **T3** 代理健康检查真实化（真实出口 IP/地理/延迟/风险评分）——三组真实代理实测通过
- [x] **T5** 真实 Chromium 进程启动 + 安全启动参数（DNS 走代理、禁 QUIC）
      → 2026-10-18 完成主体：KernelDriver 接口 + Patchright 驱动（持久化目录隔离、
      主世界确定性注入、WebRTC 禁非代理 UDP、禁 headless、CDP 端口分配）；
      DNS 走代理/禁 QUIC 待 T3 代理链路真实化时一并验证
- [x] **T4** 启动前闸门（指纹一致 → 代理可达 → 地理对齐，三检不过拒绝启动）
- [x] **T6** 环境/代理管理 UI，进入 dogfooding——应用可启动，待人工走查「创建→预览→启动→停止」
- [x] **T8** 本地代理中继网关（SOCKS5 认证 + 双跳链接入 Chromium）→ 2026-10-19 完成：
      中继 + 内核自动接入；curl 与真实 Chromium 经「本地翻墙→海外静态」双跳实测，
      出口 IP 与健康检查一致（德国/英国两组）

里程碑：**能真实创建环境、绑代理、启动隔离浏览器并稳定使用。**

### 阶段 3 — 反检测内核
- [ ] Chromium 补丁：自动化痕迹清除（webdriver/plugins/runtime 等）
- [ ] 指纹拦截：Canvas/WebGL/Audio/ClientRects/字体/WebRTC/时区
- [ ] 自动化补丁 rebase 流水线
- [ ] 探针矩阵全量打分（唯一性/稳定性/一致性/隐蔽性/隔离性）

### 阶段 4 — 账号与团队
- [ ] 账密托管 + 主进程自动填充（D 板块最高优先）
- [ ] 屏幕水印、互斥锁、2FA、超时锁定、临时授权
- [ ] server：组织/成员/RBAC/资源 ACL
- [ ] 审计时间线 + 截图回放 + 哈希链锚定

### 阶段 5 — 自动化
- [ ] **T7** RPA 引擎与节点库（navigate/click/type/extract/screenshot）
- [ ] 人类化操作（贝塞尔鼠标、打字抖动、停留分布）
- [ ] 录制回放、定时调度、平台操作模板

### 阶段 6 — 云端与商业
- [ ] 环境云迁移、加密 Cookie 增量同步
- [ ] 手机端远程控制
- [ ] 平台策略包（Shopee/Amazon/TikTok 优先）
- [ ] 套餐计费、IP 资源对接

## 四、每次开工约定

1. 从本文档确认当前任务，任务细节查 `docs/NEXT_TASKS.md` 的对应编号。
2. 改代码前先读 `AGENTS.md`（铁律、依赖方向、指纹特别约定）。
3. 契约先行：新能力先改 `packages/core`，再实现。
4. 完成后跑 `pnpm typecheck && pnpm test`，全绿才算完。
5. 做完一个任务，回到本文档勾选，并在 `NEXT_TASKS.md` 标记完成。
