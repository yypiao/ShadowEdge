# Chromium 内核构建手册（T11）

## 1. 构建机要求

| 资源 | 要求 | 说明 |
| --- | --- | --- |
| 磁盘 | ≥200GB 空闲 | 源码（--no-history）~40GB + dev 构建目录 ~80GB + 工具链 |
| 内存 | 16GB 可（仅 dev） | release 静态链接峰值 16GB+，见 §4 |
| 系统 | macOS arm64 + **完整 Xcode** | CLT 不够：`chrome` target 需要 actool/ibtool |
| 网络 | 可访问 *.googlesource.com / *.googleapis.com | 本机走 `http://127.0.0.1:7897` 代理 |

## 2. 工作区：外置盘 sparsebundle（本机实际方案）

外置盘是 ExFAT 且存有 449GB 数据，不能重分区；sparsebundle 在 ExFAT 上
虚拟出 APFS，对本机数据零风险，且按需增长不占满额度。

```bash
# 已创建：/Volumes/UNIS PN C1 /ChromiumBuild.sparsebundle（上限 430GB，band 1GB）
# 每次重启后重新挂载：
hdiutil attach "/Volumes/UNIS PN C1 /ChromiumBuild.sparsebundle" \
  -mountpoint /Volumes/ChromiumBuild -nobrowse
```

注意卷名尾部有一个空格（`UNIS PN C1 `），路径必须带引号。

## 3. 首次构建

```bash
# 代理必须对 git/cipd/gsutil 同时生效
export http_proxy=http://127.0.0.1:7897 https_proxy=http://127.0.0.1:7897
git config --global http.proxy http://127.0.0.1:7897

scripts/build-chromium.sh --mode dev          # 全链路：fetch → 锁 tag → 补丁 → 编译
scripts/verify-kernel.sh --mode dev           # 冒烟
```

增量构建（源码已在）：`scripts/build-chromium.sh --mode dev --skip-fetch`。

## 4. 16GB 内存策略

- **dev（日常补丁迭代）**：`is_component_build=true`，巨型静态链接拆成上百个
  ~2GB 的小 dylib 链接；`autoninja -j6`；编译期关掉浏览器等吃内存应用。
- **release（仅 T17 出分发包）**：`is_component_build=false`，`Chromium Framework`
  单链接峰值可能 16GB+；`-j4` + 预留 30GB 磁盘给 swap，过夜跑。
  仍 OOM 再上云端 32GB Mac（GitHub larger runner 14GB 档不够）。

## 5. 耗时预期（M4 / 16GB / USB 外置盘）

| 阶段 | 预期 |
| --- | --- |
| fetch（--no-history，走代理） | 3–6 小时（~35GB 下载） |
| dev 全量编译 | 4–8 小时 |
| dev 增量编译（单补丁迭代） | 5–30 分钟 |
| release 全量编译 | 8–15 小时（过夜） |

## 6. 故障排查

| 症状 | 处理 |
| --- | --- |
| `chromium.googlesource.com` 连不上 | 确认已 export 代理；`git config --global http.proxy` 已设 |
| gclient 卡在 cipd/gsutil | cipd 走 `https_proxy`；确认代理允许 `*.googleapis.com` |
| `xcodebuild` / actool 报错 | 装完整 Xcode；无 sudo 时用 `export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` |
| `missing Metal Toolchain`（ANGLE metal shader 编译失败） | Xcode 26+ 的 Metal 工具链是按需组件：`xcodebuild -downloadComponent MetalToolchain`（直连 Apple CDN，勿走代理） |
| gclient sync 报 HTTP 429 | googlesource 限流：`gclient sync -j 4` 降并发并重试，断点续传不丢进度 |
| 链接阶段 OOM / 换页爆炸 | 降 `-j`；dev 模式确认 `is_component_build=true` 生效 |
| sparsebundle 挂载失败 | 确认外置盘已挂载；`hdiutil attach` 报错时先 `hdiutil detach` 残留 |
| 补丁 apply 失败 | 不允许强行打入；按 `patches/chromium/<ver>/README.md` 的 rebase 流程修 |
