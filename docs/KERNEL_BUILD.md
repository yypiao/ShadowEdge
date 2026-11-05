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

本机实测补充：2026-11-04 在 16GB 内存、外置 APFS sparsebundle、`-j4` 下，release 全量构建
实际用时 **3 小时 28 分**并成功。该数据证明当前机器可完成本次构建，不代表所有补丁版本或机器
都具有相同峰值和耗时；后续仍应保留 swap 空间并串行执行重型测试。

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

# 离线签名内核包（T17B）

发布机构妥善保管 Ed25519 私钥；私钥不得放入仓库或随安装包分发。开发机可这样生成测试密钥：

```bash
mkdir -p "$HOME/.shadowedge/release-keys"
chmod 700 "$HOME/.shadowedge/release-keys"
KEY_DIR="$HOME/.shadowedge/release-keys" node -e '
  const fs = require("node:fs");
  const { generateKeyPairSync } = require("node:crypto");
  const pair = generateKeyPairSync("ed25519");
  fs.writeFileSync(`${process.env.KEY_DIR}/kernel-private.pem`,
    pair.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  fs.writeFileSync(`${process.env.KEY_DIR}/kernel-public.pem`,
    pair.publicKey.export({ type: "spki", format: "pem" }), { mode: 0o600 });
'
```

macOS 先用暂存脚本生成独立运行目录。分发只接受 `is_component_build=false` 的 release
产物并复制自包含的 `Chromium.app`。dev component build 的数百个应用外 dylib 即使全部打包，
实测内置盘冷加载仍需约 124 秒，会超过启动授权有效期，因此暂存脚本会在出包前明确拒绝：

```bash
scripts/build-chromium.sh --mode release --skip-fetch --jobs 4
node scripts/stage-kernel.mjs \
  --build-dir /Volumes/ChromiumBuild/chromium/src/out/ShadowEdge \
  --output /path/to/package-root
```

再执行签名打包。打包器会用 `otool` 检查所有 Mach-O 的 `@rpath` 依赖，缺文件时拒绝出包：

```bash
node scripts/package-kernel.mjs \
  --root /path/to/package-root \
  --kernel-version 156.0.8078.73 \
  --private-key "$HOME/.shadowedge/release-keys/kernel-private.pem" \
  --output /path/to/shadowedge-kernel_156.0.8078.73_macos_arm64.zip
```

桌面的“设置 → 浏览器内核 → 离线签名内核包”负责选择 ZIP、安装和回滚。开发启动时必须配置
受信公钥，否则安装和缓存启动会明确拒绝：

```bash
SHADOWEDGE_KERNEL_PUBLIC_KEY_PATH="$HOME/.shadowedge/release-keys/kernel-public.pem" \
  pnpm dev:desktop
```

也可直接用 `SHADOWEDGE_KERNEL_PUBLIC_KEY` 传 PEM 内容。安装和每次激活/启动都会验签并逐文件
计算 SHA-256；当前仅实现本地离线包，不包含在线更新服务。

签名安装目录中的每个环境固定自己的 `kernelVersion`，直接加载 `versions/<version>/payload`，不经过
全局 `current` 软链。全局激活只决定新建环境的默认版本；已有环境必须从环境卡片进入“内核升级”，
先创建验证克隆并完成探针对照，再人工确认迁移。显式配置 `SHADOWEDGE_KERNEL_EXECUTABLE` 或开发
可执行路径时继续使用开发模式，不自动固定安装版本。
