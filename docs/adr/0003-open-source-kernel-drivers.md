# ADR 0003：浏览器内核改为开源双驱动（Camoufox 主 + Patchright 备），放弃自研补丁与闭源内核

- 状态：已接受
- 日期：2026-09-18
- 取代：ADR 0001（Electron + 自研补丁 Chromium）中「自研补丁 Chromium」部分；Electron 做管理台的决策不变

## 背景

ADR 0001 原定为「Electron UI + 自研补丁 Chromium」。经两件事重新评估：

1. **竞品逆向**（见 `docs/RESEARCH_ZINIAO_RE.md`）：紫鸟 v6.26.6 确认为自研补丁 Chromium 150（Framework 内含 `AddCanvasFingerprint`/`AddWebGLFingerprint` 等 C++ 符号）+ 本地 Xray 网关 + 魔改 WebDriver。该路线可行但需要持续维护 Chromium fork 的 rebase 流水线，投入重。
2. **CloakBrowser 评估**：其核心补丁二进制闭源、按并发会话收费、需 license server、不可自由再分发，且官方自带 Manager UI 与我方产品潜在竞争。以闭源商业件作为产品地基存在成本、供应链与竞争三重风险，故排除。

同期存在成熟的开源替代：

- **Camoufox**（MPL-2.0）：Firefox C++/Rust 源码层补丁，覆盖 Canvas/WebGL/Audio/字体/WebRTC/时区/GEO，指纹经启动配置注入、确定性可复现，Playwright 直连，可从源码自建。
- **Patchright / rebrowser-patches**（MIT/Apache）：CI 中对 Chromium 打补丁后自建，强项在消除 CDP/webdriver 自动化痕迹。
- **Xray-core**（MPL-2.0）：可直接替代紫鸟的本地 V2Ray 网关。
- **BrowserForge**（Apache-2.0）：生成内部一致的指纹画像参数，喂给内核。

## 决策

1. `packages/kernel` 定义供应商中立的 `KernelDriver` 接口（launch / 数据目录 / 代理 / 指纹参数 / CDP 端点 / 关闭）。
2. 主驱动实现为 **Camoufox**（Firefox 系），开发期直接用官方发布二进制，发版前搭自建流水线。
3. 备驱动实现为 **Patchright 自建 Chromium**，防止 Firefox 引擎在特定站点成为少数派特征，并避免单一上游依赖。
4. 网络层集成 **Xray-core** 做本地网关，按环境分流；代理凭据经 `@shadowedge/crypto` 加密存储。
5. `packages/fingerprint` 不再自建指纹素材库逐维度伪造，职责收敛为：seed 管理、BrowserForge 适配、启动参数映射、一致性审计。
6. **永久取消自研 Chromium C++ 补丁**；`docs/ANTI_DETECTION.md` 中的补丁清单转为「驱动能力矩阵 + 探针验收标准」。

## 理由

- 指纹内核是最难且需持续跟进的部分，复用经过公开检验的开源实现，把有限人力投到产品层（持久化、账密托管、团队/审计、RPA 编排、关联风险图谱）。
- 双驱动 + 驱动接口消除供应商锁定，任一上游失效可切换。
- 全部组件许可证允许再分发，产品 COGS 不随并发会话线性增长。
- seed 确定性架构保留（ADR 0002 不变）：seed 派生 BrowserForge 随机输入与 Camoufox 注入参数，仍满足「升级不变脸」。

## 代价

- 主驱动是 Firefox 内核，少量 Chrome 专属站点/扩展兼容性需用 Patchright 备驱动兜底。
- 自建 Camoufox 需 Firefox 工具链（C++/Rust，一次性 CI 投入）。
- 上游能力差异被驱动接口吸收，接口设计需要覆盖两套内核的参数并集，前期要多花时间打磨。
- 补丁并非绝对隐身：Canvas 噪声等仍需通过「真实人群分布合理性」检验，验收以 CreepJS 信任分 + 分布实测为准，不能只看值是否随机。
