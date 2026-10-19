import { apiKeyCreateSchema, apiKeyGrantsUpdateSchema, apiKeyUpdateSchema } from '@dblab/shared'
import type { FastifyInstance } from 'fastify'

import type { ApiKeyService } from '../api-key/service'
import type { AuditService } from '../audit/audit.service'
import type { SessionService } from '../auth/session.service'
import { requireSession } from '../auth/session.guard'
import { actorOf } from '../common/actor'
import { clientIpOf } from '../common/client-ip'
import { idParam } from '../common/params'

export interface ApiKeyRouteDeps {
  service: ApiKeyService
  audit: AuditService
  sessions: SessionService
  cookieName: string
}

export function registerApiKeyRoutes(app: FastifyInstance, deps: ApiKeyRouteDeps): void {
  const preHandler = requireSession(deps.sessions, deps.cookieName)

  app.get('/api/v1/api-keys', { preHandler }, async () => ({
    items: await deps.service.list(),
  }))

  app.post('/api/v1/api-keys', { preHandler }, async (request, reply) => {
    const actor = actorOf(request)
    const input = apiKeyCreateSchema.parse(request.body)
    const { detail, plaintextKey } = await deps.service.create(input, actor.id)

    await deps.audit.tryRecord({
      actorKind: 'admin',
      actorId: actor.id,
      actorName: actor.username,
      action: 'api_key.create',
      decision: 'granted',
      apiKeyId: detail.id,
      apiKeyPrefix: detail.prefix,
      clientIp: clientIpOf(request),
      // 只记「有几个授权、白名单几条、什么时候过期」，明文与摘要都不进审计。
      detail: {
        grantCount: detail.grants.length,
        ipAllowlistCount: detail.ipAllowlist.length,
        expiresAt: detail.expiresAt,
      },
    })

    return reply.code(201).send({ ...detail, plaintextKey })
  })

  app.get('/api/v1/api-keys/:id', { preHandler }, async (request) =>
    deps.service.detail(idParam(request)),
  )

  app.patch('/api/v1/api-keys/:id', { preHandler }, async (request) => {
    const actor = actorOf(request)
    const id = idParam(request)
    const input = apiKeyUpdateSchema.parse(request.body)
    const detail = await deps.service.update(id, input)

    await deps.audit.tryRecord({
      actorKind: 'admin',
      actorId: actor.id,
      actorName: actor.username,
      action: 'api_key.update',
      decision: 'granted',
      apiKeyId: detail.id,
      apiKeyPrefix: detail.prefix,
      clientIp: clientIpOf(request),
      detail: { changed: Object.keys(input).sort() },
    })

    return detail
  })

  app.put('/api/v1/api-keys/:id/grants', { preHandler }, async (request) => {
    const actor = actorOf(request)
    const id = idParam(request)
    const input = apiKeyGrantsUpdateSchema.parse(request.body)
    const detail = await deps.service.replaceGrants(id, input.grants)

    await deps.audit.tryRecord({
      actorKind: 'admin',
      actorId: actor.id,
      actorName: actor.username,
      action: 'api_key.grants',
      decision: 'granted',
      apiKeyId: detail.id,
      apiKeyPrefix: detail.prefix,
      clientIp: clientIpOf(request),
      detail: {
        grantCount: detail.grants.length,
        writableCount: detail.grants.filter((grant) => grant.canWrite).length,
      },
    })

    return detail
  })

  app.delete('/api/v1/api-keys/:id', { preHandler }, async (request, reply) => {
    const actor = actorOf(request)
    const id = idParam(request)
    const before = await deps.service.detail(id)
    await deps.service.revoke(id)

    await deps.audit.tryRecord({
      actorKind: 'admin',
      actorId: actor.id,
      actorName: actor.username,
      action: 'api_key.revoke',
      decision: 'granted',
      apiKeyId: before.id,
      apiKeyPrefix: before.prefix,
      clientIp: clientIpOf(request),
    })

    return reply.code(204).send()
  })
}
