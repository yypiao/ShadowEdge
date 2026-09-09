# ShadowEdge AI 协作开发规范

本文件是 AI 代理在本仓库工作的强制约束。修改任何文件前必读。

## 0. 铁律

1. **`packages/core` 是唯一事实来源。** 任何跨模块的数据结构、错误码、IPC 通道，必须先在 `core` 中定义，再被其他包引用。禁止在 app 层就地定义领域类型。
2. **禁止绕过类型系统。** 不允许 `any`、`as unknown as X`、`@ts-ignore`。确实需要逃逸时，写 `// SAFETY: <原因>` 并说明为什么类型系统无法表达。
3. **渲染进程零特权。** React 层不得引入 `node:*`、`electron` 主进程模块或直接发起网络请求。所有能力经 `IpcApi` 白名单通道。
4. **敏感数据不落明文。** 代理密码、Cookie、账号凭据一律经 `@shadowedge/crypto` 信封加密；日志输出前经 `redact()`。
5. **不提交生成物。** `dist/`、`profiles/`、`data/`、`chromium-build/` 已在 `.gitignore`，不要强制添加。

## 1. 依赖方向

```
core  ←  crypto, fingerprint, proxy, sdk
      ←  kernel (+fingerprint, proxy)
      ←  rpa (+kernel)
      ←  sync (+crypto)
      ←  apps/*
```

依赖只能向左。若发现需要反向依赖，说明抽象位置错了 —— 把共享部分上提到 `core`，不要加反向引用。

## 2. 添加功能的标准流程

以「新增一个 IPC 能力」为例：

1. 在 `packages/core/src/ipc.ts` 的 `IpcApi` 增加方法签名，并把通道名加入 `IPC_CHANNELS`。
2. 在 `packages/core/src/types.ts` 补齐所需领域类型（若有）。
3. 在 `apps/desktop/src/main/handlers.ts` 实现 —— `Handlers` 类型会强制你实现，漏了就编译失败。
4. 在渲染层通过 `window.shadowedge.api['channel:name'](payload)` 调用。
5. 补单元测试：领域逻辑测在对应 package，编排逻辑测 handlers。

**不要跳过第 1 步直接在 handlers 里加方法** —— 契约先行是本仓库可被多个 AI 并行开发的前提。

## 3. 错误处理

- 抛错必须用 `ShadowEdgeError` 并带上 `ErrorCode`。新错误场景先在 `core/errors.ts` 增加 code。
- 可重试的错误（网络、代理超时）标 `retryable: true`。
- 批量操作（多环境启动、批量代理检测）用 `Result<T>` 而非异常，避免一个失败中断整批。

## 4. 指纹模块特别约定

指纹的**可复现性是硬需求**：同一 `seed` 在任意机器、任意版本必须产出完全相同的画像，否则用户环境会在升级后「变脸」而被平台判定异常。

- 只能用 `SeededRandom`，禁止 `Math.random()`、`Date.now()`、`randomUUID()` 参与指纹生成。
- 向 `DEFAULT_DB` 追加素材时**只能在数组末尾追加**，不可插入或重排 —— `rng.pick()` 依赖索引，重排会让所有历史环境指纹漂移。
- 任何指纹维度的新增，必须同时更新 `auditFingerprint()` 的校验项和 `docs/ANTI_DETECTION.md` 的验证矩阵。

## 5. 代码风格

- TypeScript ESM，`.js` 后缀导入（NodeNext 要求）。
- 注释解释**为什么**，不解释**做什么**。函数名说不清的才加注释。
- 中文注释可用于业务语义说明；标识符一律英文。
- 单文件超过 400 行考虑拆分。

## 6. 提交前检查

```bash
pnpm typecheck && pnpm test
```

两者必须全绿。不要为了让测试通过而删除或跳过测试。

## 7. 不要做的事

- 不要引入新的运行时依赖来解决可以用 20 行代码解决的问题。
- 不要重构与当前任务无关的代码。
- 不要修改 `.gitignore` 来提交本应忽略的文件。
- 不要在未被要求时改动 CI 配置或版本号。
