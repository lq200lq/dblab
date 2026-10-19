import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  clean: true,
  dts: false,
  sourcemap: false,
  // bin 入口必须是可执行脚本：shebang 只能靠 banner 注入，源码里的 shebang 会被 esbuild 丢弃。
  banner: { js: '#!/usr/bin/env node' },
})
