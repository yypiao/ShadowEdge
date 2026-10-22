# Chromium 补丁目录

按以下结构存放可 rebase 的补丁：

```text
patches/chromium/
  150.0.7339.80/
    0001-shadowedge-profile-switch.patch
    0002-worker-fingerprint.patch
    0003-canvas-noise.patch
```

- 一个补丁只做一件事。
- 文件名前缀必须体现应用顺序。
- 每个版本目录对应一个固定 Chromium tag / commit。
- 详细构建与验收入口见 `docs/KERNEL_PATCH_PLAN.md`。
