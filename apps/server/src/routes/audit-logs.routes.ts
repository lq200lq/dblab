import { auditLogQuerySchema } from '@dblab/shared'
import type { FastifyInstance } from 'fastify'

import type { AuditService } from '../audit/audit.service'
import type { SessionService } from '../auth/session.service'
import { requireSession } from '../auth/session.guard'

export interface AuditLogRouteDeps {
  audit: AuditService
  sessions: SessionService
  cookieName: string
}

/**
 * 审计只读。没有写入、更新、删除入口——写入只发生在执行路径上，
 * 而库里的触发器让「改历史」连绕过服务直接写 SQL 都做不到。
 */
export function registerAuditLogRoutes(app: FastifyInstance, deps: AuditLogRouteDeps): void {
  app.get(
    '/api/v1/audit-logs',
    { preHandler: requireSession(deps.sessions, deps.cookieName) },
    async (request) => deps.audit.list(auditLogQuerySchema.parse(request.query)),
  )
}
