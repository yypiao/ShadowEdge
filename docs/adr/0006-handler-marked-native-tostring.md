# ADR 0006：用 handler 内部标记恢复带名原生 toString

- 状态：已接受
- 日期：2026-10-29
- 范围：T16 / Chromium 156 / V8 `Function.prototype.toString`

## 背景

ShadowEdge 使用 Proxy 包装原生函数。V8 对任意 callable Proxy 默认返回
`function () { [native code] }`，丢失了 `Worker`、`Blob` 等原生名称。
曾在 JS 全局替换 `Function.prototype.toString`，CreepJS stealth 从 0% 升至 20%，
因此 JS 全局补丁不再考虑。

## 路线比较

### A. V8 对 ShadowEdge 包装做受控原生解包（本 spike）

在 `_proxy` 创建的 handler 内部对象上放置 `__shadowedge_native_proxy__` 自有数据标记。
V8 `FunctionPrototypeToString` 仅在以下条件全部满足时，把序列化委托给原生 target：

1. receiver 是 JSProxy；
2. handler 的**自有**数据属性标记为 true，查找使用 `LookupIterator::OWN`；
3. target 是 JSFunction 且 `IsUserJavaScript()==false`。

其余情况完全走 V8 原有分支。标记不放在 Proxy 上，页面也无法通过标准 JS 从 Proxy
取回 handler；读取不执行 getter。OWN 查找防止页面通过污染 Object.prototype 批量改变
普通 Proxy 行为。

相较维护“包装函数 → 名称”的全局名称表，此方案不复制名称，不在 renderer 间维护
额外生命周期，直接复用 target 的 SharedFunctionInfo 原生名称。

### B. Blink 避免 Proxy，另写原生函数并携带画像上下文

需要把 Navigator、Worker、Blob、Canvas、Audio、WebGL 等大量 JS 包装逐一改成
Blink/V8 binding，并复制 apply/construct、缓存、异常与跨世界语义。爆炸半径远大于
一个 V8 序列化分支；在 A 可满足验收时不采用。

### C. 全局解包所有 Proxy / JS 全局 patch（拒绝）

- 全局解包会改变普通页面 Proxy 的可观察行为，错误实现还可能泄漏 JS target 源码。
- JS 全局 patch 已有 CreepJS stealth 20% 的实证回退，不重复尝试。

## 安全与兼容性验收

目标项之外必须同时通过负例，避免“修好 Worker、引入新检测面”：

- `Worker` / `Blob` / `toDataURL` 返回各自带名原生串；
- 未包装原生函数保持原名；
- 普通原生 Proxy 仍返回匿名原生串；
- 即使 handler 带同名标记，普通 JS target 也不泄漏源码；
- Object.prototype 污染不能改变普通 Proxy；
- revoked Proxy 保持匿名原生串且不新增异常；
- marker 不出现在 Proxy 自有属性；
- CreepJS 保持 `0% headless / 0% stealth`，全量矩阵不掉分。

## 当前状态

实现补丁：`patches/chromium/156/0006-named-native-tostring.patch`。
探针：`experiments/probes/run.mjs` 的 `nativeToString` 组。
Chromium 156 增量构建通过；直连矩阵 **32/32**，报告：
`experiments/probes/results/kernel-156-t16-direct-1793283566402.json`。
最终 os1 全量矩阵 **40/40**，报告：
`experiments/probes/results/kernel-156-t16-full-1793283724731.json`。
Worker/Blob/Canvas 带名目标项与普通 Proxy、防源码泄漏、原型污染、revoked Proxy 等
负例全部通过；CreepJS 保持 **0% headless / 0% stealth**，Pixelscan Browser/Fingerprint
及非代理项通过，`maskingDetected=false`，BrowserLeaks 未发现非出口 IP。
0001–0006 已完成逆向拆解、顺序 apply 重放与逐文件一致性检查，因此接受路线 A。
