# ShadowEdge × 紫鸟 EngTk2 对照报告（T0 C 组补测）

- 日期：2026-10-19
- 方法：同一套采集维度跑两侧。ShadowEdge 侧为 `experiments/probes/run.mjs`（os1 德国双跳链路）；
  紫鸟侧为 `experiments/probes/ziniao-compare/`（用户 EngTk2 环境中打开探针页回传）。
- 基线：未打补丁的 Patchright Chromium（真实值）。

## 1. 逐项对比

| 维度 | ShadowEdge (os1-德国) | 紫鸟 EngTk2 | 未打补丁基线 |
| --- | --- | --- | --- |
| UA | Windows Edg/130（画像） | Mac Chrome/146（内核实为 150，刻意降版本） | Mac Chrome/156 |
| platform | Win32 | MacIntel | MacIntel |
| 核数/内存 | 6 / 16 | 8 / 8 | 10 / 16 |
| 语言/时区 | de-DE / Europe/Berlin（跟随代理出口） | zh-CN / Asia/Shanghai（环境配置） | en-US / Asia/Singapore |
| WebGL | RTX 3060 D3D11 | Apple M3 Max OpenGL（真实为 M4 Metal） | Apple M4 Metal |
| Canvas | seed 确定性噪声（已修复生效） | 有噪声（738e93c ≠ 真实 d9fa3cb8） | d9fa3cb8 |
| Audio | 微噪声（末位扰动） | 较大幅度噪声 | 172.67165154 |
| Worker 世界 | 全画像值（包装注入） | 全画像值 | 真实值（裸奔） |
| WebRTC | 无 candidate | 无 candidate | srflx 泄漏真实出口 |
| ServiceWorker | **屏蔽** | **可用** | 可用 |
| webdriver / cdc / native | 干净 | 干净 | 干净 |
| CreepJS FP ID 稳定性 | 同 seed 逐字节一致 | 未测（需其 API） | — |

## 2. 结论

**能力主体对齐**：紫鸟有的维度（跨世界一致、WebRTC 防泄漏、Canvas/Audio 噪声、UA 降版本）
ShadowEdge 全部具备，且我们多了「指纹跟随代理出口」的自动化链路。

**三个值得注意的差距/风险**：

1. **ServiceWorker 策略不同**。紫鸟能在 ServiceWorker 作用域内也覆盖指纹（C++ 内核层能力），
   我们选择屏蔽—— CreepJS 类探针可能把「无 serviceWorker」记为隐私强化特征。
   长期需要内核层方案（Patchright 补丁研究或自研 SW 注入）。
2. **伪装哲学不同**。紫鸟在 Mac 上选「同系微调」（MacIntel + M3 Max），我们默认全平台随机
   （Mac 用户装出 Windows+NVIDIA）。后者用户群更大但「Mac 主力机装 Win」在风控画像里偏少数派，
   建议画像生成增加「跟随宿主机平台」选项。
3. **UA 库运营**。紫鸟 UA 刻意落后内核 4 个大版本（146 vs 150）说明其 UA 库有持续维护；
   我们的 `DEFAULT_DB` 需要定期更新机制，否则随时间推移会成为静态特征。

## 3. 本次补测顺带修复

- Canvas 噪声双重 XOR 自抵消（哈希与真实值相同）——已修复并验证：
  确定性 ✓、按 seed 区分 ✓、与真实值不同 ✓。
- `navPropsCount 36 vs 84` 虚惊一场：非安全上下文（about:blank）本就裁减 Navigator 属性，非缺陷。

## 4. 紫鸟侧工程观察（供架构参考）

- 内核（Chromium 150 定制二进制）拒绝裸启：校验 launcher 令牌（`--store_data_path` 加密串），
  防提取/防二次分发——我们将来做商业化时可借鉴。
- 本地 API（9481 端口）挂付费开放平台鉴权——变现路径之一：API 自动化接口。
- 实例以 `userdata/chrome_<id>` 隔离，与我们 `profiles/<id>` 同构。
