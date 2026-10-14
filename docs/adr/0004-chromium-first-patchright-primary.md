# ADR 0004：Chromium 优先——Patchright 升为主驱动，指纹补齐方案待探针实验裁决

- 状态：已接受（指纹补齐子方案待实验数据裁决）
- 日期：2026-10-14
- 修订：ADR 0003 中「Camoufox 主驱动」的排序；双驱动接口与「不自研 C++ 补丁」原则不变

## 背景

ADR 0003 定的是 Camoufox（Firefox）主 + Patchright（Chromium）备。产品侧进一步明确要求：

1. **不想用 Firefox 内核，只要 Chromium**——与竞品（紫鸟）同内核，Chrome 扩展生态完整，网站兼容性零顾虑，调试工具链统一。
2. **所有组件零付费绑定**（已满足：Patchright/BrowserForge/Xray 均为 MIT/Apache/MPL 免费开源，无 license server、无并发计费）。
3. **开发环境零 C++ 工具链**——内核一律消费预编译二进制，全库 TypeScript。

需要正视的技术事实：Patchright 的补丁面**窄于** Camoufox——它消「自动化痕迹」
（CDP 检测、navigator.webdriver、Runtime.enable 泄漏），实测优于 puppeteer-stealth 一代；
但**逐环境指纹伪装**（Canvas/WebGL/Audio 每环境不同且确定性的值）不是其覆盖重点，
Camoufox 的 C++ 层指纹补丁在 Patchright 里没有等价物。

## 决策

1. **Patchright（Chromium）升为主驱动**，Camoufox 降级为可选备驱动（默认不打包，接口保留）。
2. 指纹伪装补齐存在两个候选子方案，**在探针实验数据出来前不锁定**：
   - **方案 A：CDP/JS 注入**。`Page.addScriptToEvaluateOnNewDocument` + BrowserForge 画像，
     seed 确定性注入。优点：零 C++、开发快；缺点：JS hook 路线，高级探针可检测注入痕迹
     （toString 检测、Worker/iframe 逃逸面需逐一封堵）。
   - **方案 B：Patchright 补丁集上追加自有 C++ 指纹补丁**（Canvas/WebGL/Audio 四个点）。
     优点：效果彻底，等于开源复刻紫鸟核心能力；缺点：重新背起 Chromium fork rebase 成本，
     需 C++ 构建流水线（仅构建机，不影响开发者环境）。
3. 裁决方式：阶段一探针基线实验（见下），**以 CreepJS 信任分对照为准**。

## 探针裁决实验（阶段一第一任务）

| 组 | 配置 | 通过线 |
| --- | --- | --- |
| 实验 A | Patchright + JS 注入 BrowserForge 画像 | 待测 |
| 实验 B | Camoufox 默认配置 | 待测 |
| 对照组 | 紫鸟（本机已装 v6.26.6） | 基线 |

判定规则：

- **A 信任分 ≥ 紫鸟基线** → 采用方案 A，Chromium-only 成立，砍 Firefox，路线最轻。
- **A 明显低于基线** → 三选一再议：接受分差（低风控场景够用）/ 上方案 B 自研补丁 / 高风控场景保留 Camoufox 专用驱动。

## 不变的部分

- `KernelDriver` 供应商中立接口不变——本次能无痛换主驱动，正是该抽象的价值验证。
- 所有组件许可证允许商用再分发、零按量计费（MPL-2.0 文件级弱 copyleft 仅约束对上游源文件本身的修改）。
- seed 确定性架构（ADR 0002）不变：seed → BrowserForge 画像 → 注入参数，跨版本可复现是硬需求。
- 探针验证脚本将收编为 CI 常驻回归网：上游（Patchright/Chromium/BrowserForge）任何版本升级必须先过探针回归，防止环境「悄悄变脸」。

## 代价

- 主驱动指纹强度上限目前低于 Camoufox，依赖实验 A 的结果。
- 若走方案 B，引入受控的 C++ 补丁维护面（范围限定四个指纹点，非全量 fork）。
- 双内核参数并集仍需 `KernelDriver` 接口前期多打磨。
