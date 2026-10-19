import { createPlatformDb, requireDatabaseUrl } from '../client'
import { loadRepoEnv } from '../env-file'
import { ensureAdmin } from '../seed-admin'

async function main(): Promise<void> {
  loadRepoEnv()

  const username = process.env.ADMIN_USER || 'admin'
  const password = process.env.ADMIN_PASSWORD || 'admin123'

  if (process.env.NODE_ENV === 'production' && !process.env.ADMIN_PASSWORD) {
    throw new Error('生产环境必须显式提供 ADMIN_PASSWORD')
  }

  const { db, pool } = createPlatformDb(requireDatabaseUrl())
  try {
    const result = await ensureAdmin(db, username, password)
    if (result.status === 'created') {
      console.log(`[seed] 已创建管理员：${result.username}`)
    } else {
      console.log(`[seed] 管理员已存在，未改动其口令：${result.username}`)
    }
  } finally {
    await pool.end()
  }
}

main().catch((err: unknown) => {
  console.error('[seed] 失败：', err instanceof Error ? err.message : err)
  process.exitCode = 1
})
