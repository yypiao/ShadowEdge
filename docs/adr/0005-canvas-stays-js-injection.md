# ADR 0005：Canvas 暂不下沉，保留确定性 JS 注入

- 状态：已接受（暂缓 C++，不是永久排除）
- 日期：2026-10-29
- 范围：T15 / Chromium 156；Screen、WebGL、Audio 的 C++ 下沉不受本决策影响

## 背景

T15 原计划把 Canvas / Audio / WebGL / Screen 全部下沉到 Chromium。前三项之外的
Canvas 同时涉及 `toDataURL` 与 `getImageData`、纯色保护、纹理判定、稀疏绘制噪声、
逐像素噪声、读取幂等和绘制后的缓存失效。完整 C++ 重写必须复现这些语义，并重新验证
premultiplied-alpha、`fillRect` 混合和不同 GPU 后端，不能只做“给像素加随机数”。

## 决策

1. **当前不实现 Canvas C++ 补丁，不阻塞 T15 收口。** 自研内核与 Patchright
   回退路径都继续使用 `packages/fingerprint/src/inject.ts` 的既有 Canvas JS 注入。
2. `coveredByKernel` 不声明 `canvas`，避免 JS 让位后出现无保护路径。
3. 将 Canvas 保留为独立后续研究项；没有新的失分证据时，不投入 C++ 重写。
4. 本决策不宣称 JS 与 C++ 完全等价，也不宣称“绝对不可检测”。已知残余风险继续登记。

## 收益证据（2026-10-29 实测）

### 可复现的专项对照

使用同一 Chromium 156 二进制，对未注入与当前 JS 注入做主世界对照。脚本：
`experiments/probes/canvas-evidence.mjs`；原始报告：
`experiments/probes/results/canvas-js-evidence-1793375676248.json`。

结果 **20/20**，证明当前实现满足本轮明确验收口径：

- `toDataURL` / `getImageData` 的直接 `toString()` 与原生逐字一致，
  `Function.prototype.toString.call` 不泄漏 JS 源码；`.name`、方法 descriptor 标志、
  对象 prototype/tag 与原生一致。
- Canvas 与 2D context 实例均无新增自有属性。
- 纯色画布的 PNG dataURL 和像素与原生逐字节一致。
- 复杂纹理的 dataURL 和像素确实产生变化；重读稳定；画布修改后缓存正确失效。
- `getImageData` 纹理测试有 12,234 / 49,152 个通道变化，最大通道差为 **1**；
  这里验证的是逐像素微扰，不错误宣称该入口是稀疏加噪。

复测命令：

```bash
pnpm --filter @shadowedge/fingerprint build
SHADOWEDGE_KERNEL_EXECUTABLE=/path/to/Chromium \
  node experiments/probes/canvas-evidence.mjs
```

专项脚本只覆盖函数和像素语义，采用 about:blank 主世界直接求值；导航前注入、
ServiceWorker 与外部检测站仍由全量探针负责，不能用这 20 项替代全量回归。

### 既有端到端结果

- T15 最终 os1 全量矩阵 **31/31**，报告：
  `experiments/probes/results/kernel-156-t15-final-1793282828077.json`；
  CreepJS 为 **0% headless / 0% stealth**。
- 同次 Pixelscan 的 Browser、Fingerprint 及非代理一致性项通过，`maskingDetected=false`；
  总体 inconsistent 来自代理出口因素，不能误写为整站全绿。
- T15 的 Screen/WebGL/Audio 让位后，Canvas 仍由同一 JS 路径覆盖；BrowserLeaks 与本地
  WebRTC 候选检查均未发现真实出口之外的 IP 泄漏。

## 收益与边界

**现在的收益是：在已有实测未暴露 Canvas 失分的前提下，不新增一套高复杂度 C++ 像素
实现及其 GPU/rebase 回归面，把研发投入转向仍有明确差距的项目。** 这是基于测试结果和
风险范围的工程取舍，不虚构未测量的性能提升或人日收益。

C++ 仍有理论价值：可消除 JS Proxy、额外 `toString` 自有属性等包装面，并更接近原生
调用时序。因此不能把本 ADR 解读为“C++ 永远没有收益”。当前证据只能支持“边际收益
不足以抵消立即重写的成本与风险”。

## 已知残余风险

- 决策时 `Function.prototype.toString.call` 对 Proxy 返回匿名原生串；T16/0006 已在
  自研内核路径解决该共性问题，Patchright 回退路径仍保持匿名原生串。
- 精细的 Proxy、函数自有属性、调用时序或 descriptor 深度检测仍可能区分 JS 包装。
- 不同 OS/GPU、更多图像格式、Worker OffscreenCanvas 与复杂合成不能由单次 macOS 样本穷举。

## 重新评估触发条件

满足任一项即重开本决策，先做最小复现再决定是否实现 Canvas C++ 补丁：

1. CreepJS / Pixelscan 或可复现的真实目标平台出现**可定位到 Canvas JS 包装**的失分，
  同内核未注入对照不存在该失分。
2. 上述 20 项专项回归或全量矩阵出现 Canvas 相关失败，且不能通过小范围 JS 修复解决。
3. 产品需要覆盖的新世界/图像入口无法由当前 JS 路径触达。
4. 后续原生函数方案进一步消除 Canvas 包装面，并显著改变成本或风险假设。

重新启动时必须带失败样本、对照报告和验收矩阵；禁止仅因“C++ 理论更彻底”直接重写。
