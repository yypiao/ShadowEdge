# 安全基线与威胁模型

## 1. 威胁模型

| 攻击者 | 能力 | 我们的防御 |
| --- | --- | --- |
| 恶意操作员 | 有客户端登录态，想窃取店铺账号密码另开店 | 密码由主进程解密并直接注入页面，明文不经过渲染层与剪贴板；`operator` 角色无 `profile:export-cookie` |
| 离职员工 | 曾持有客户端与部分凭据 | 撤销成员后其 KEK 分片失效，无法解封环境数据；审计链留存全部历史操作 |
| 服务端管理员 / 云厂商 | 可读数据库全部内容 | 环境数据端到端加密，服务端只存密文与被 KEK 包裹的 DEK，无解密能力 |
| 网络中间人 | 可观测流量 | TLS + 证书固定；环境数据在传输前已加密 |
| 恶意网页 | 在业务浏览器内执行 JS | 业务 Chromium 与 Electron 进程完全隔离；渲染层 CSP 禁止内联脚本与外部资源 |
| 供应链攻击 | 污染 npm 依赖 | 依赖锁定 + `pnpm audit` 纳入 CI；主进程依赖保持最小化 |

## 2. Electron 安全基线

全部为强制项，CI 应校验：

```ts
webPreferences: {
  sandbox: true,           // 渲染进程 OS 级沙箱
  contextIsolation: true,  // preload 与页面隔离
  nodeIntegration: false,  // 渲染层无 Node
  webSecurity: true,       // 不禁用同源策略
}
```

- `setWindowOpenHandler` 一律 `deny`，外链交系统浏览器。
- CSP：`default-src 'self'; script-src 'self'`，不允许 `unsafe-eval`。
- preload 只暴露 `IPC_CHANNELS` 白名单，不暴露 `ipcRenderer` 本体。
- 不加载任何远程 URL 到应用窗口。

## 3. 密钥层级

```
用户口令
  └─ PBKDF2 ─→ 用户密钥
        └─ 解封 ─→ 组织 KEK（服务端存被用户密钥包裹的副本）
              └─ 包裹 ─→ 每个环境的 DEK
                    └─ AES-256-GCM ─→ Cookie / Storage 密文
```

- DEK 一环境一密钥，泄露不横向扩散。
- AAD 绑定用途（`KeyPurpose`），防止密文被跨用途重放。
- 密钥轮换：换 KEK 只需重新包裹 DEK，不必重加密全部数据。

## 4. 敏感数据处理

- 日志与审计写入前经 `redact()`，屏蔽 `password` / `cookie` / `token` 等键。
- 账号密码使用 `account-secret` 用途标签做信封加密，数据库只保存密文、被包裹的 DEK 与 IV；相同用途标签之外不能解封。
- 不提供密码 reveal IPC。密码仅在主进程的自动填充调用期间解密，返回给渲染进程的结果不包含用户名或密码，审计同样不记录这两项。
- 自动填充只接受精确的协议 + 主机 + 端口匹配；业务站点强制 HTTPS，HTTP 仅允许本机回环地址。origin 不允许路径、查询参数、片段或用户信息，校验错误不得回显原始输入。
- 填充用户名和密码之前必须确认密码选择器指向 `type=password`；填充过程中再次检查页面 origin，默认只填充，只有显式 `submit: true` 才点击登录。
- 代理密码在内存中的存活时间最小化，用完即置零。
- 崩溃报告不上传 `userDataDir` 内容。
- 环境导出功能默认不含 Cookie，需显式勾选且记录审计事件。

当前账密托管的安全边界是**单客户端本地加密存储与填充**。团队授权、云端零知识同步、设备撤销和服务端 KEK 分片尚未实现，不能把本地链路描述为已经完成团队端到端加密。

## 5. 审计不可篡改

`AuditEvent.hash = sha256(prevHash || canonicalJson(event))`，形成单向链。服务端每日把链尾哈希提交到外部时间戳服务，使得连管理员也无法在事后重写历史而不被发现。

## 6. 已知残余风险

- 若攻击者获得操作员机器的 root 权限，可 dump 主进程内存拿到解密后的密码。缓解：短生命周期 + 可选硬件密钥（Phase 3+）。
- 平台方若采用行为生物特征（打字节律、鼠标微动）检测，纯指纹伪造不足。缓解见 `ANTI_DETECTION.md` §4。
- Chromium 补丁需跟随上游版本维护，滞后期间存在已知 CVE 暴露窗口。缓解：补丁最小化 + 自动化 rebase 流水线。
