#!/usr/bin/env bash
# ShadowEdge Chromium 内核构建脚本（T11）
#
# 用法:
#   scripts/build-chromium.sh [--mode dev|release] [--skip-fetch] [--jobs N]
#
# 环境变量:
#   CHROMIUM_ROOT   内核工作区（默认 /Volumes/ChromiumBuild/chromium）
#   DEPOT_TOOLS     depot_tools 目录（默认 /Volumes/ChromiumBuild/depot_tools）
#   http_proxy/https_proxy  拉源码与工具链需要时自行导出
#
# 模式说明（16GB 内存策略，见 docs/KERNEL_BUILD.md）:
#   dev      组件构建，单链接内存 ~2GB，用于补丁日常迭代
#   release  静态链接，内存峰值 16GB+，仅 T17 打包分发前需要
set -euo pipefail

MODE=dev
SKIP_FETCH=0
JOBS=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode) MODE="$2"; shift 2 ;;
    --skip-fetch) SKIP_FETCH=1; shift ;;
    --jobs|-j) JOBS="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
[[ "$MODE" == dev || "$MODE" == release ]] || { echo "--mode 只能是 dev|release" >&2; exit 2; }

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHROMIUM_ROOT="${CHROMIUM_ROOT:-/Volumes/ChromiumBuild/chromium}"
DEPOT_TOOLS="${DEPOT_TOOLS:-/Volumes/ChromiumBuild/depot_tools}"
export PATH="$DEPOT_TOOLS:$PATH"

TAG="$(grep '^tag=' "$REPO_ROOT/chromium.version" | cut -d= -f2)"
MAJOR="${TAG%%.*}"
PATCH_DIR="$REPO_ROOT/patches/chromium/$MAJOR"

command -v gclient >/dev/null || { echo "depot_tools 不在 PATH：$DEPOT_TOOLS" >&2; exit 1; }
[[ -d "$PATCH_DIR" ]] || { echo "补丁目录不存在：$PATCH_DIR" >&2; exit 1; }

# 1. 首次拉取源码（--no-history 省空间；hooks 在 checkout 到锁定 tag 后再跑）
if [[ "$SKIP_FETCH" == 0 && ! -d "$CHROMIUM_ROOT/src" ]]; then
  mkdir -p "$CHROMIUM_ROOT"
  (cd "$CHROMIUM_ROOT" && fetch --no-history --no-hooks chromium)
fi
cd "$CHROMIUM_ROOT/src"

# 2. 锁定版本：checkout 到 chromium.version 指定的 tag，防 main 漂移
if [[ "$SKIP_FETCH" == 0 ]]; then
  git fetch --depth 1 origin "tag $TAG" || true
  git checkout "tags/$TAG"
  gclient sync --no-history --with_branch_heads --with_tags --nohooks -D
  gclient runhooks
fi

# 3. 校验 checkout 与锁定文件一致；回填 commit 供审计
HEAD_SHA="$(git rev-parse HEAD)"
LOCKED_SHA="$(grep '^commit=' "$REPO_ROOT/chromium.version" | cut -d= -f2)"
if [[ -n "$LOCKED_SHA" && "$HEAD_SHA" != "$LOCKED_SHA" ]]; then
  echo "FATAL: HEAD $HEAD_SHA 与 chromium.version 锁定的 $LOCKED_SHA 不一致" >&2
  exit 1
fi
echo "== Chromium $TAG @ ${HEAD_SHA:0:12}（commit ${LOCKED_SHA:+已锁定}${LOCKED_SHA:-未回填}）"

# 4. 应用补丁（先全部 --check，任一不过则一个都不打）
shopt -s nullglob
PATCHES=("$PATCH_DIR"/[0-9][0-9][0-9][0-9]-*.patch)
if (( ${#PATCHES[@]} > 0 )); then
  for p in "${PATCHES[@]}"; do
    if git apply --check "$p" 2>/dev/null; then
      git apply "$p" && echo "applied: $(basename "$p")"
    elif git apply -R --check "$p" 2>/dev/null; then
      echo "already applied, skip: $(basename "$p")"
    else
      echo "FATAL: 补丁无法干净应用：$p" >&2; exit 1
    fi
  done
else
  echo "== 无补丁，构建原生 Chromium"
fi

# 5. 生成构建目录
if [[ "$MODE" == dev ]]; then
  OUT=out/ShadowEdge-dev
  GN_ARGS='is_debug=false is_component_build=true symbol_level=0 dcheck_always_on=false enable_nacl=false target_cpu="arm64"'
  DEFAULT_JOBS=6
else
  OUT=out/ShadowEdge
  GN_ARGS='is_debug=false is_component_build=false symbol_level=0 blink_symbol_level=0 enable_nacl=false target_cpu="arm64"'
  DEFAULT_JOBS=4
fi
gn gen "$OUT" --args="$GN_ARGS"

# 6. 编译
autoninja -C "$OUT" -j "${JOBS:-$DEFAULT_JOBS}" chrome
echo "== 产物：$CHROMIUM_ROOT/src/$OUT"
