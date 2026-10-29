#!/usr/bin/env bash
# 内核冒烟校验（T11）：版本串比对 + headless 启动 + CDP 存活检查
# 用法: scripts/verify-kernel.sh [--mode dev|release]
set -euo pipefail

MODE=dev
[[ "${1:-}" == "--mode" ]] && MODE="${2:-dev}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHROMIUM_ROOT="${CHROMIUM_ROOT:-/Volumes/ChromiumBuild/chromium}"
TAG="$(grep '^tag=' "$REPO_ROOT/chromium.version" | cut -d= -f2)"

if [[ "$MODE" == dev ]]; then OUT="$CHROMIUM_ROOT/src/out/ShadowEdge-dev"; else OUT="$CHROMIUM_ROOT/src/out/ShadowEdge"; fi
BIN="$OUT/Chromium.app/Contents/MacOS/Chromium"
[[ -x "$BIN" ]] || { echo "FATAL: 找不到产物 $BIN" >&2; exit 1; }

# 1. 版本串与锁定 tag 一致
VER="$("$BIN" --version)"
echo "binary version: $VER"
[[ "$VER" == *"$TAG"* ]] || { echo "FATAL: 版本串不含锁定 tag $TAG" >&2; exit 1; }

# 2. headless 启动 + CDP 端点存活（不依赖图形会话）
PORT=19315
"$BIN" --headless=new --disable-gpu --remote-debugging-port=$PORT \
  --user-data-dir="$(mktemp -d /tmp/se-kernel-verify.XXXXXX)" about:blank &
KPID=$!
trap 'kill $KPID 2>/dev/null || true' EXIT
for i in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
    echo "CDP alive on :$PORT"
    echo "VERIFY_OK"
    exit 0
  fi
  sleep 1
done
echo "FATAL: CDP 端点 30s 内未就绪" >&2
exit 1
