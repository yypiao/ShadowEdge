# ShadowEdge

反检测指纹浏览器与跨境电商多账号运营平台。对标紫鸟浏览器（ZiNiao），在内核级隔离、指纹一致性、团队协作与自动化能力上做超越。

## 为什么做

紫鸟的核心价值是「一台电脑管理数百个店铺账号且不被平台关联封号」。它的短板集中在：

| 维度 | 紫鸟现状 | ShadowEdge 目标 |
| --- | --- | --- |
| 指纹方案 | JS 层 hook 为主，部分维度可被 CDP 探针识破 | Chromium C++ 层补丁，`navigator.webdriver` 等痕迹从源码消除 |
| 指纹一致性 | UA / Client Hints / 时区 / 语言偶有互相矛盾 | 单一 seed 确定性生成 + 启动前一致性审计闸门 |
| 代理能力 | 单跳为主 | 链式代理、出口地理与时区自动对齐、IP 质量风控 |
| 自动化 | 内置 RPA 功能有限，扩展性弱 | 图形化 DSL + CDP 开放端口 + OpenAPI SDK，可接 Playwright |
| 协作安全 | 账号密码托管，权限粒度粗 | 密码永不落到操作员手上，RBAC + 资源级 ACL + 哈希链审计 |
| 跨平台 | Windows 为主 | Windows / macOS / Linux 同等支持 |

## 架构总览

```
apps/
  desktop/       Electron 桌面客户端（主进程编排 + React 渲染层）
  server/        Fastify 团队协作后端（组织、权限、同步、审计）
packages/
  core/          领域模型、IPC 契约、错误模型 —— 唯一事实来源
  fingerprint/   指纹画像确定性生成与一致性审计
  proxy/         代理池、健康探测、地理一致性
  kernel/        浏览器内核适配层（启动、隔离、CDP）
  rpa/           工作流 DSL 与执行引擎
  sync/          环境数据端到端加密同步
  crypto/        信封加密与凭据保险箱
  sdk/           OpenAPI 客户端
```

数据流：渲染层只能经 preload 白名单调用 `IpcApi` → 主进程 handlers 做鉴权与编排 → 各 package 执行领域逻辑 → 内核层启动隔离浏览器实例。

详见 `docs/ARCHITECTURE.md`。

## 快速开始

```bash
pnpm install
pnpm build          # 构建所有 packages
pnpm dev:desktop    # 启动桌面客户端
pnpm dev:server     # 启动后端服务
pnpm typecheck      # 全量类型检查
```

## 文档

- `docs/ARCHITECTURE.md` — 分层架构、模块边界、数据流
- `docs/ROADMAP.md` — 分阶段交付计划
- `docs/ANTI_DETECTION.md` — 反检测技术方案与验证矩阵
- `docs/SECURITY.md` — 威胁模型与安全基线
- `AGENTS.md` — AI 协作开发规范（改代码前必读）

## 合规声明

ShadowEdge 面向合法的多账号运营场景（跨境电商店铺矩阵、广告投放、QA 测试、隐私保护）。禁止用于欺诈、绕过法律限制或侵害第三方权益的行为。
