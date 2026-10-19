import { eq } from 'drizzle-orm'

import type { PlatformDb } from './client'

import { hashPassword } from './password'
import { adminUser } from './schema'

export interface EnsureAdminResult {
  status: 'created' | 'exists'
  username: string
}

/**
 * 幂等创建管理员：**只增不覆盖**。
 * 库里已有同名用户就一个字都不动——否则改一次 ADMIN_PASSWORD 环境变量
 * 就会把线上口令悄悄换掉，那是运维事故而不是「更新」。
 */
export async function ensureAdmin(
  db: PlatformDb,
  username: string,
  password: string,
): Promise<EnsureAdminResult> {
  const existing = await db
    .select({ id: adminUser.id })
    .from(adminUser)
    .where(eq(adminUser.username, username))
    .limit(1)

  if (existing.length > 0) {
    return { status: 'exists', username }
  }

  // onConflictDoNothing 兜住并发跑两次 seed 的情况。
  await db
    .insert(adminUser)
    .values({
      username,
      passwordHash: hashPassword(password),
      displayName: '管理员',
    })
    .onConflictDoNothing({ target: adminUser.username })

  return { status: 'created', username }
}
