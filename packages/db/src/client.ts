import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'

import * as schema from './schema'

/** 平台自身库的连接。连接池上限压得很低：这个进程主要不是给别人干活的，真正吃连接的是被纳管数据源。 */
export function createPlatformDb(databaseUrl: string) {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 })
  const db = drizzle(pool, { schema })
  return { db, pool }
}

export type PlatformDb = ReturnType<typeof createPlatformDb>['db']
export type PlatformPool = ReturnType<typeof createPlatformDb>['pool']

export function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL
  if (!url) {
    throw new Error('缺少 DATABASE_URL（可复制 .env.example 为 .env）')
  }
  return url
}
