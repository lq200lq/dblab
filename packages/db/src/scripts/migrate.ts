import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { migrate } from 'drizzle-orm/node-postgres/migrator'

import { createPlatformDb, requireDatabaseUrl } from '../client'
import { loadRepoEnv } from '../env-file'

const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')

async function main(): Promise<void> {
  loadRepoEnv()
  const { db, pool } = createPlatformDb(requireDatabaseUrl())
  try {
    console.log(`[migrate] 目标库：${describeTarget(requireDatabaseUrl())}`)
    console.log(`[migrate] 迁移目录：${migrationsFolder}`)
    await migrate(db, { migrationsFolder })
    console.log('[migrate] 完成')
  } finally {
    await pool.end()
  }
}

/** 只打主机/库名，绝不把口令打出来。 */
function describeTarget(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.hostname}:${parsed.port || '5432'}${parsed.pathname}`
  } catch {
    return '(DATABASE_URL 无法解析)'
  }
}

main().catch((err: unknown) => {
  console.error('[migrate] 失败：', err instanceof Error ? err.message : err)
  process.exitCode = 1
})
