# ShadowEdge 分阶段交付计划

## Phase 0 — 骨架落地（当前）
- [x] 项目结构、monorepo 配置、CI 骨架
- [x] 领域契约（`core/types.ts`）
- [x] 指纹画像生成器（`fingerprint/`）
- [x] 代理池管理器（`proxy/`）
- [x] 加密模块（`crypto/`）
- [x] 内核适配层（`kernel/`）
- [x] RPA 引擎骨架（`rpa/`）
- [x] 同步管理器（`sync/`）
- [x] OpenAPI 客户端（`sdk/`）
- [x] Electron 主进程 + IPC 桥接 + React 渲染层
- [x] Fastify 后端（`apps/server/`）
- [ ] 架构文档、路线图、反检测技术方案

## Phase 1 — 可运行桌面客户端
- [ ] Chromium 补丁编译脚本（`scripts/build-chromium.sh`）
- [ ] 本地 SQLite 持久层（替换 handlers 中的内存 Map）
- [ ] 环境 CRUD 全流程（创建→编辑→启动→关闭→删除）
- [ ] 代理导入（行格式 / CSV）与健康检查
- [ ] 单页应用 UI 打磨（环境列表、代理管理、设置页）
- [ ] 启动后自动打开目标站点（`startupUrls`）
- [ ] 关闭后自动推 Cookie 到本地加密存储

## Phase 2 — 指纹反检测验证
- [ ] 搭建探针站（`scripts/probe/`），检测被识破的维度
- [ ] Chromium C++ 补丁：消除 `navigator.webdriver` 等 8 项自动化痕迹
- [ ] 补丁：拦截 Canvas / WebGL / Audio 等 API 返回噪声数据
- [ ] 补丁：注入合法 `navigator.plugins` / `navigator.mimeTypes`
- [ ] 补丁：`WebRTC` 替换真实 IP 为代理出口 IP
- [ ] 一致性自动化测试（`tests/fingerprint-consistency/`）
- [ ] 发布验证矩阵得分

## Phase 3 — 团队协作
- [ ] 后端组织/成员/权限 API
- [ ] 环境共享与协作启动
- [ ] 操作日志与审计哈希链
- [ ] 邮箱密码由主进程自动填充（不经过操作员）
- [ ] 团队套餐计费

## Phase 4 — 自动化与 RPA
- [ ] RPA 工作流可视化编辑器
- [ ] 节点库：打开页面、点击、输入、提取数据、截图
- [ ] 条件节点、循环节点
- [ ] 定时执行与结果通知
- [ ] 电商平台适配（Shopee / Amazon / TikTok 店铺操作模板）

## Phase 5 — 云同步与跨设备
- [ ] 环境配置云端同步
- [ ] 加密 Cookie 增量同步
- [ ] 冲突检测与手动解决
- [ ] 手机端远程控制（WebSocket 隧道）

## 验证矩阵目标

| 检测项 | 全员通过率目标 |
| --- | --- |
| `navigator.webdriver` 不可见 | 100% |
| `navigator.plugins` 长度 > 0 | 100% |
| `chrome.runtime` 不可见 | 100% |
| `WebGL` vendor/renderer 与 seed 一致 | 100% |
| `Canvas` 指纹值与 seed 一致 | 100% |
| `AudioContext` 指纹值与 seed 一致 | 100% |
| `WebRTC` 不泄露真实 IP | 100% |
| `Client Hints` 与 UA 自洽 | 100% |
| 时区/语言/地理与代理出口一致 | 99% |
| screen/availableScreen 匹配 | 100% |
| 字体列表与 seed 一致 | 100% |
| `chrome.*` 等扩展 API 不可见 | 100% |
