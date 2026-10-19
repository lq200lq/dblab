import { loginRequestSchema, type AdminUser } from '@dblab/shared'
import { adminUser, wastePasswordComparison, verifyPassword, type PlatformDb } from '@dblab/db'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'

import type { AuditService } from '../audit/audit.service'
import type { SessionService } from '../auth/session.service'
import { requireSession } from '../auth/session.guard'
import { clientIpOf } from '../common/client-ip'
import { AppError } from '../common/errors'
import type { AppEnv } from '../config/env'

export interface AuthDeps {
  db: PlatformDb
  sessions: SessionService
  audit: AuditService
  env: AppEnv
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthDeps): void {
  const cookieName = deps.env.sessionCookieName

  app.post('/api/v1/auth/login', async (request, reply) => {
    const body = loginRequestSchema.parse(request.body)
    const attemptedIp = clientIpOf(request)

    const rows = await deps.db
      .select({
        id: adminUser.id,
        username: adminUser.username,
        passwordHash: adminUser.passwordHash,
        displayName: adminUser.displayName,
      })
      .from(adminUser)
      .where(eq(adminUser.username, body.username))
      .limit(1)

    const row = rows[0]

    if (!row) {
      // 账号不存在也走一次同价的口令比对，避免用响应时间枚举账号。
      wastePasswordComparison(body.password)
      await recordLoginFailure(deps, body.username, attemptedIp)
      throw new AppError('INVALID_CREDENTIALS')
    }

    if (!verifyPassword(body.password, row.passwordHash)) {
      await recordLoginFailure(deps, body.username, attemptedIp)
      throw new AppError('INVALID_CREDENTIALS')
    }

    const { token, expiresAt } = await deps.sessions.create(row.id, attemptedIp)
    reply.setCookie(cookieName, token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure: deps.env.cookieSecure,
      expires: expiresAt,
    })

    await deps.audit.tryRecord({
      actorKind: 'admin',
      actorId: row.id,
      actorName: row.username,
      action: 'auth.login',
      decision: 'granted',
      clientIp: attemptedIp,
    })

    const user: AdminUser = { id: row.id, username: row.username, displayName: row.displayName }
    return { user }
  })

  app.get(
    '/api/v1/auth/session',
    { preHandler: requireSession(deps.sessions, cookieName) },
    async (request) => {
      const session = request.adminSession
      if (!session) throw new AppError('UNAUTHORIZED')
      return { user: session.user }
    },
  )

  app.post('/api/v1/auth/logout', async (request, reply) => {
    const token = request.cookies[cookieName]
    const context = await deps.sessions.resolve(token)
    await deps.sessions.destroy(token)
    reply.clearCookie(cookieName, { path: '/' })

    if (context) {
      await deps.audit.tryRecord({
        actorKind: 'admin',
        actorId: context.user.id,
        actorName: context.user.username,
        action: 'auth.logout',
        decision: 'granted',
        clientIp: clientIpOf(request),
      })
    }

    return reply.code(204).send()
  })
}

/** 登录失败也要留痕，否则「谁在试口令」这件事完全看不见。 */
async function recordLoginFailure(
  deps: AuthDeps,
  username: string,
  clientIp: string | null,
): Promise<void> {
  await deps.audit.tryRecord({
    actorKind: 'admin',
    actorName: username,
    action: 'auth.login_failed',
    decision: 'denied',
    denialReason: 'invalid_credentials',
    clientIp,
  })
}
