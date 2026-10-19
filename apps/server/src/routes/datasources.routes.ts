import { datasourceCreateSchema, datasourceProbeSchema, datasourceUpdateSchema } from '@dblab/shared'
import type { FastifyInstance } from 'fastify'

import type { AuditService } from '../audit/audit.service'
import type { SessionService } from '../auth/session.service'
import { requireSession } from '../auth/session.guard'
import { actorOf } from '../common/actor'
import { clientIpOf } from '../common/client-ip'
import { idParam } from '../common/params'
import type { DatasourceService } from '../datasource/service'

export interface DatasourceRouteDeps {
  service: DatasourceService
  audit: AuditService
  sessions: SessionService
  cookieName: string
}

export function registerDatasourceRoutes(app: FastifyInstance, deps: DatasourceRouteDeps): void {
  const preHandler = requireSession(deps.sessions, deps.cookieName)

  app.get('/api/v1/datasources', { preHandler }, async () => ({
    items: await deps.service.list(),
  }))

  app.post('/api/v1/datasources', { preHandler }, async (request, reply) => {
    const actor = actorOf(request)
    const input = datasourceCreateSchema.parse(request.body)
    const created = await deps.service.create(input)

    await deps.audit.tryRecord({
      actorKind: 'admin',
      actorId: actor.id,
      actorName: actor.username,
      action: 'datasource.create',
      decision: 'granted',
      datasourceId: created.id,
      datasourceName: created.name,
      engine: created.engine,
      clientIp: clientIpOf(request),
    })

    return reply.code(201).send(created)
  })

  app.get('/api/v1/datasources/:id', { preHandler }, async (request) =>
    deps.service.get(idParam(request)),
  )

  app.patch('/api/v1/datasources/:id', { preHandler }, async (request) => {
    const actor = actorOf(request)
    const id = idParam(request)
    const input = datasourceUpdateSchema.parse(request.body)
    const updated = await deps.service.update(id, input)

    await deps.audit.tryRecord({
      actorKind: 'admin',
      actorId: actor.id,
      actorName: actor.username,
      action: 'datasource.update',
      decision: 'granted',
      datasourceId: updated.id,
      datasourceName: updated.name,
      engine: updated.engine,
      clientIp: clientIpOf(request),
      // 记下改了哪些字段（值不进审计，口令尤其不能进）。
      detail: { changed: Object.keys(input).sort() },
    })

    return updated
  })

  app.delete('/api/v1/datasources/:id', { preHandler }, async (request, reply) => {
    const actor = actorOf(request)
    const id = idParam(request)
    const before = await deps.service.get(id)
    await deps.service.remove(id)

    await deps.audit.tryRecord({
      actorKind: 'admin',
      actorId: actor.id,
      actorName: actor.username,
      action: 'datasource.delete',
      decision: 'granted',
      datasourceName: before.name,
      engine: before.engine,
      clientIp: clientIpOf(request),
    })

    return reply.code(204).send()
  })

  /**
   * 探测表单里这份还没保存的配置：新建与编辑弹窗里的「测试连接」。
   * 只连一次、不落库；口令要么随请求进来后即弃，要么沿用已存的那份，两种都不写进审计。
   */
  app.post('/api/v1/datasources/test', { preHandler }, async (request) => {
    const actor = actorOf(request)
    const input = datasourceProbeSchema.parse(request.body)
    const result = await deps.service.probe(input)

    await deps.audit.tryRecord({
      actorKind: 'admin',
      actorId: actor.id,
      actorName: actor.username,
      action: 'datasource.test',
      decision: 'granted',
      // 编辑弹窗里试连时知道是哪一行；新建时只有表单给的名字。
      datasourceId: input.datasourceId ?? null,
      datasourceName: input.name,
      engine: input.engine,
      clientIp: clientIpOf(request),
      errorCode: result.errorCode,
      errorMessage: result.message,
      // 记下探测的目标地址：这份配置可能永远不会被保存下来。
      detail: {
        viaForm: true,
        host: input.host,
        port: input.port,
        database: input.database,
        latencyMs: result.latencyMs,
        serverVersion: result.serverVersion,
      },
    })

    return result
  })

  app.post('/api/v1/datasources/:id/test', { preHandler }, async (request) => {
    const actor = actorOf(request)
    const id = idParam(request)
    const datasource = await deps.service.get(id)
    const result = await deps.service.testConnection(id)

    await deps.audit.tryRecord({
      actorKind: 'admin',
      actorId: actor.id,
      actorName: actor.username,
      action: 'datasource.test',
      // decision 是「授权判定」：管理员当然有权测连接，失败只是执行结果，
      // 所以这里恒为 granted，失败信息走 errorCode/errorMessage。
      decision: 'granted',
      datasourceId: datasource.id,
      datasourceName: datasource.name,
      engine: datasource.engine,
      clientIp: clientIpOf(request),
      errorCode: result.errorCode,
      errorMessage: result.message,
      detail: { latencyMs: result.latencyMs, serverVersion: result.serverVersion },
    })

    return result
  })
}
