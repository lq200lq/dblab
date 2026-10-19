import { createHash, randomBytes } from 'node:crypto'

import type { AdminUser } from '@dblab/shared'
import { adminUser, session, type PlatformDb } from '@dblab/db'
import { and, eq, gt, lt } from 'drizzle-orm'

const TOKEN_BYTES = 32

/** lastSeenAt 不必每请求都写：同一会话一分钟内只刷新一次。 */
const LAST_SEEN_THROTTLE_MS = 60_000

export interface SessionContext {
  sessionId: number
  user: AdminUser
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/**
 * 会话。没有 Redis，落库；库里只存 cookie 令牌的 sha256，
 * 因此库被读走也换不出可用的 cookie 值。
 */
export class SessionService {
  constructor(
    private readonly db: PlatformDb,
    private readonly ttlMinutes: number,
  ) {}

  async create(
    userId: number,
    clientIp: string | null,
  ): Promise<{ token: string; expiresAt: Date }> {
    const token = randomBytes(TOKEN_BYTES).toString('base64url')
    const expiresAt = new Date(Date.now() + this.ttlMinutes * 60_000)
    await this.db
      .insert(session)
      .values({ tokenHash: hashToken(token), userId, expiresAt, clientIp })
    return { token, expiresAt }
  }

  async resolve(token: string | undefined | null): Promise<SessionContext | null> {
    if (!token) return null

    const rows = await this.db
      .select({
        sessionId: session.id,
        lastSeenAt: session.lastSeenAt,
        id: adminUser.id,
        username: adminUser.username,
        displayName: adminUser.displayName,
      })
      .from(session)
      .innerJoin(adminUser, eq(adminUser.id, session.userId))
      .where(and(eq(session.tokenHash, hashToken(token)), gt(session.expiresAt, new Date())))
      .limit(1)

    const row = rows[0]
    if (!row) return null

    if (Date.now() - row.lastSeenAt.getTime() > LAST_SEEN_THROTTLE_MS) {
      await this.db.update(session).set({ lastSeenAt: new Date() }).where(eq(session.id, row.sessionId))
    }

    return {
      sessionId: row.sessionId,
      user: { id: row.id, username: row.username, displayName: row.displayName },
    }
  }

  async destroy(token: string | undefined | null): Promise<void> {
    if (!token) return
    await this.db.delete(session).where(eq(session.tokenHash, hashToken(token)))
  }

  /** 顺带清理过期会话；由启动与定时任务调用，避免表无限增长。 */
  async purgeExpired(): Promise<number> {
    const removed = await this.db
      .delete(session)
      .where(lt(session.expiresAt, new Date()))
      .returning({ id: session.id })
    return removed.length
  }
}
