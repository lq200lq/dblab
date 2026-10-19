import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 用例之间共享同一个测试库，且清理动作是破坏性的（删 admin_user / session）。
    // 并行跑不同文件会互相踩，必须串行。
    fileParallelism: false,
  },
})
