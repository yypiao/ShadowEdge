# T0 探针裁决实验报告（ADR 0004 指纹补齐方案裁决）

- 日期：2026-10-15
- 环境：macOS arm64（Apple Silicon）、Patchright 1.64（Chromium 156）、Camoufox v156.0.1-beta.36（Firefox 156）
- 脚本与原始数据：`experiments/t0-probe/`（scripts/、results/）

## 1. 实验设计

| 组 | 配置 | 目标 |
| --- | --- | --- |
| A | Patchright + seed 确定性 JS 注入（方案 A 原型） | 验证 JS 注入路线的有效性与可复现性 |
| B | Camoufox 默认配置，两次启动 | 开源 C++ 补丁路线的开箱基线 |
| C（对照） | 紫鸟 EngTk2 内核 | 待手动补测（见 §6） |

判定项：指纹可复现性、注入有效性、自动化痕迹、WebRTC/IP 泄漏、headless 可识别性。

## 2. 关键结论

### 2.1 Patchright 的注入机制比预期更好（方案 A 可行的决定性证据）

- Patchright 的 `addInitScript` **确实在主世界执行**（经裸 CDP `Runtime.evaluate` 验证：
  注入的 `window.__v2`、`navigator.hardwareConcurrency` 改写均生效）。
- 其 `page.evaluate` 默认在**隔离 utility world 执行**——自动化脚本的 JS 对站点不可见，
  且全程不使用 `Runtime.enable`（这是大多数 CDP 检测的入口）。这对 RPA 是额外的隐蔽红利。
- 工程注意：采集/审计脚本读主世界指纹时，必须走裸 CDP session 的 `Runtime.evaluate`，
  用 `page.evaluate` 会读到隔离世界的值（本次实验踩过的坑，已写入 kernel 驱动开发注意事项）。

### 2.2 确定性：两条路线都能满足，但责任划分不同

- 实验 A（Patchright + 自研 seed 注入）：两次启动指纹**逐字节一致**
  （canvas=8d0697d6、WebGL renderer、CreepJS FP ID 均相同）。seed→画像→注入 链路验证通过，
  与 ADR 0002 架构吻合。
- 实验 B（Camoufox 默认）：两次启动指纹**不一致**（run1=Linux/Intel HD，run2=Windows/D3D11）。
  Camoufox 默认每次随机生成画像——**确定性不是默认行为**，需要我们的 fingerprint 包
  生成一次画像、随环境持久化、之后每次以固定 config 启动。这正好是我们要做的 seed 管理层，
  结论：可接受，但架构上「画像持久化」是硬需求而非可选项。

### 2.3 必须修复的检测点（无论选哪个方案）

- **WebRTC 泄漏真实公网 IP**：Patchright 默认配置下 CreepJS 抓到 host/srflx candidate
  与真实出口 IP（实验机器 122.x.x.x）。多账号场景这是致命项。对策：强制代理时设置
  Chromium `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`（或等效 flag），
  并纳入启动一致性闸门（审计不过则拒绝启动）。Camoufox 内置 WebRTC  spoofing，无此问题。
- **headless 模式高可识别**：headless 下 CreepJS 报 `94% like headless / 67% headless / 0% stealth`
  （HeadlessChrome UA + SwiftShader GPU）。结论：**业务环境只允许 headed 运行**，
  服务器场景用 Xvfb/虚拟显示，禁止 headless shell。headed 下为 `0% headless`。
- headed Patchright 仍报 `44% like headless`：疑似与本机窗口无聚焦/自动化控制痕迹有关，
  需要后续用人类化输入与窗口管理对冲（列入 T8 探针迭代的跟踪项）。

### 2.4 CreepJS 信任分抓取未完成

信任分值不在 `innerText`（疑似 shadow DOM/画布渲染），本次只抓到各维度明细与 FP ID。
对照组（紫鸟）与统一信任分对比在下一轮补测，方法：逐组打开 CreepJS 截图人工读分，
或解析其 shadow root。这不影响本次裁决——裁决依据是可复现性、注入有效性与泄漏面。

## 3. 裁决：采用方案 A（Patchright + 自研 seed 注入），Camoufox 保留为备驱动

依据：

1. 注入有效性、确定性两项硬指标，方案 A 全部通过（§2.1、§2.2）。
2. 方案 A 的已知短板（JS 注入理论可检测、WebRTC/headless）都有明确工程对策，
   且 WebRTC/headless 问题与内核无关、哪个方案都要处理。
3. 方案 B（自研 C++ 补丁）的增量收益（更彻底的 Canvas/WebGL 改写）目前没有数据证明必要；
   若后续实测（紫鸟对照、平台实战）发现 JS 注入被识破，再启动方案 B，成本可控（四个补丁点）。
4. Camoufox 保留在 `KernelDriver` 接口后作为备驱动：高风控站点/Chrome-only 站点出问题时的
   切换选项，也是 Patchright 上游失效时的备份。

## 4. 对产品架构的回写（已进入开发约束）

- `packages/kernel`：启动参数必须包含 WebRTC 禁用非代理 UDP 的策略；headless 一律拒绝。
- `packages/fingerprint`：画像一次生成、随环境持久化（SQLite 密文）、启动时原样注入——
  这是 T1 持久层的字段级需求。
- 审计闸门（T2）增加两项硬规则：WebRTC policy 检查、headed 检查。
- 探针回归网（T8）：CreepJS FP ID 稳定性 + WebRTC candidate 检查 + headless 判定，纳入 CI。

## 5. 下一轮补测清单

- [ ] 紫鸟 EngTk2 对照：同一探针集跑分（需用户手动开一个紫鸟环境配合，或探查其 CDP 端口）
- [ ] CreepJS 信任分自动抓取（shadow root 解析或截图 OCR）
- [ ] browserleaks WebRTC/Canvas/WebGL 三件套自动断言
- [ ] 挂住宅代理后的端到端复测（验证 WebRTC 修复 + IP 地理一致性闸门）
- [ ] 10/20/50 环境并发压力曲线（阶段一第二项验证）

## 6. 复现方式

```bash
cd experiments/t0-probe
npm install && npx patchright install chromium   # 实验 A
node scripts/experiment-a.mjs                    # 两次启动 + CreepJS
python3.14 -m venv .venv && ./.venv/bin/pip install "camoufox[geoip]"
./.venv/bin/python scripts/experiment-b.py       # 实验 B（Camoufox 二进制安装见 README）
```
