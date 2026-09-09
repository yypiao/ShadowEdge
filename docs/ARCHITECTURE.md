# ShadowEdge 架构设计

## 1. 分层

```
┌─────────────────────────────────────────────────────────┐
│  渲染层 (React, sandbox=true, contextIsolation=true)     │
│  零特权：无 Node、无网络、无文件系统                       │
└──────────────────────┬──────────────────────────────────┘
                       │ preload 白名单桥 (IpcApi)
┌──────────────────────▼──────────────────────────────────┐
│  编排层 (Electron 主进程 handlers)                        │
│  鉴权 · 参数校验 · 事务边界 · 事件广播                     │
└──────────────────────┬──────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────┐
│  领域层 (packages/*)                                     │
│  fingerprint · proxy · kernel · rpa · sync · crypto      │
└──────────────────────┬──────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────┐
│  基础设施：SQLite(本地) · Chromium 补丁内核 · 远端 API     │
└─────────────────────────────────────────────────────────┘
```

关键约束：**每一层只能向下调用**。渲染层无法跳过编排层，编排层不直接操作 Chromium 进程细节。

## 2. 为什么用 Electron + 自研 Chromium 双层

紫鸟的做法是完全自研内核 + 自研壳。我们分离关注点：

- **UI 壳用 Electron**：迭代快，跨平台一致，团队能用 Web 技能栈开发管理界面。
- **业务浏览器用打过补丁的 Chromium**：作为独立进程启动，与 Electron 完全隔离。这样即使 Electron 版本升级，业务环境的指纹稳定性不受影响。

两者通过 CDP 通信。`packages/kernel` 是唯一知道 Chromium 存在的地方。

## 3. 环境隔离模型

每个 `BrowserProfile` 拥有：

- 独立 `userDataDir` —— Cookie、LocalStorage、IndexedDB、CacheStorage 物理隔离。
- 独立代理出口 —— 通过 `--proxy-server` 传入，且所有 DNS 走代理（`--proxy-bypass-list` 置空防泄露）。
- 独立指纹画像 —— 由 `seed` 确定性推导，见 `ANTI_DETECTION.md`。

隔离验证：两个环境同时访问同一探针站点，`localStorage`、Cookie、指纹哈希、出口 IP 必须四项全不相同。

## 4. 数据存储

**本地（SQLite via better-sqlite3）**
- `profiles` —— 环境元数据 + 指纹 JSON
- `proxies` —— 代理配置，密码列存密文
- `sessions` —— 运行历史
- `audit_local` —— 本地操作日志

**远端（Postgres）**
- 组织、成员、角色权限
- 环境元数据的权威副本（多设备同步的仲裁者）
- 加密的环境数据快照（服务端无解密能力）
- 审计事件哈希链

同步策略：元数据用 `remoteRevision` 单调递增做乐观锁；环境数据（Cookie 等）用「最后写入者胜出 + 冲突快照保留」，因为强制合并 Cookie 会导致登录态损坏。

## 5. 权限模型

三层叠加：

1. **角色（Role）** —— owner / admin / leader / operator / auditor 的默认权限集。
2. **权限覆盖（permissionOverrides）** —— 成员级的显式授予或撤销。
3. **资源 ACL（sharedWith）** —— 环境级的协作授权。

关键设计：`operator` 可以 `profile:launch` 但没有 `profile:export-cookie`，也拿不到平台账号密码 —— 密码由主进程在启动后自动填充，明文不经过渲染层。这是相对紫鸟的核心安全增强。

## 6. 审计哈希链

每条 `AuditEvent` 的 `hash = sha256(prevHash + 事件内容)`。任何篡改会断链。服务端定期把链尾哈希锚定到外部时间戳服务，防止管理员整链重写。

## 7. 扩展点

- **内核适配** —— 实现 `BrowserKernel` 接口即可接入新内核（如 Gecko）。
- **RPA 节点** —— 在 `RpaNodeKind` 增加类型并注册执行器。
- **指纹素材** —— 向 `DEFAULT_DB` 末尾追加（不可重排，见 AGENTS.md）。
- **外部自动化** —— 开启 `remoteDebugging` 后可用 Playwright / Puppeteer 直连 CDP。
