import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  main: {
    build: {
      outDir: 'dist/main',
      rollupOptions: {
        input: resolve(__dirname, 'src/main/index.ts'),
        // node:sqlite 是 Electron 44 运行时内置模块，不得打包进 bundle；
        // kerberos/gssapi 等是 patchright 捆绑的 mongodb 客户端的可选原生依赖，运行时用不到。
        external: ['node:sqlite', 'kerberos', '@mongodb-js/zstd', 'gcp-metadata', 'snappy', 'socks', 'aws4', 'mongodb-client-encryption',
          // patchright 内部用动态 require 加载 chromium-bidi 等深路径，打包会断裂，保持 node_modules 原样加载
          'patchright', 'patchright-core', 'playwright-core', 'chromium-bidi', 'ws'],
      },
    },
  },
  preload: {
    build: {
      outDir: 'dist/preload',
      rollupOptions: { input: resolve(__dirname, 'src/preload/index.ts') },
    },
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react()],
    build: {
      outDir: 'dist/renderer',
      rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') },
    },
  },
});
