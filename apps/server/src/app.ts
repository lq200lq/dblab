import { ERROR_MESSAGE_BY_CODE } from '@dblab/shared'
import type { PlatformDb, PlatformPool } from '@dblab/db'
import cookie from '@fastify/cookie'
import fastifyStatic from '@fastify/static'
import Fastify, { type FastifyInstance } from 'fastify'
import { existsSync } from 'node:fs'

import { ApiKeyService } from './api-key/service'
import { AuditService } from './audit/audit.service'
import { SessionService } from './auth/session.service'
import { toErrorBody } from './common/errors'
import type { AppEnv } from './config/env'
import { DatasourceService } from './datasource/service'
import { PoolRegistry } from './datasource/pool-registry'
import { registerMcpRoutes } from './mcp/routes'
import { McpSessionRegistry } from './mcp/session'
import { registerApiKeyRoutes } from './routes/api-keys.routes'
import { registerAuditLogRoutes } from './routes/audit-logs.routes'
import { registerAuthRoutes } from './routes/auth.routes'
import { registerDatasourceRoutes } from './routes/datasources.routes'

export interface ServerDeps {
  env: AppEnv
  db: PlatformDb
  pool: PlatformPool
}

export async function buildApp(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({
    // trustProxy 受显式开关控制：打开才会采信 x-forwarded-for，
    // 否则「不在代理后面却信了转发头」会让 IP 白名单形同虚设。
    trustProxy: deps.env.trustProxy,
    logger: false,
  })

  await app.register(cookie)

  const audit = new AuditService(deps.db)
  const sessions = new SessionService(deps.db, deps.env.sessionTtlMinutes)
  const pools = new PoolRegistry({
    poolMax: deps.env.poolMax,
    idleEvictMinutes: deps.env.poolIdleEvictMinutes,
  })
  pools.startSweeper()
  const datasources = new DatasourceService(deps.db, pools)
  const apiKeys = new ApiKeyService(deps.db)

  // MCP 会话是进程内状态：本平台单进程运行，没有跨节点共享会话的需求。
  const mcpSessions = new McpSessionRegistry({ ttlMinutes: deps.env.mcpSessionTtlMinutes })
  mcpSessions.startSweeper()

  app.addHook('onClose', async () => {
    pools.stopSweeper()
    await mcpSessions.closeAll()
    await pools.closeAll()
  })

  app.setErrorHandler((err, _request, reply) => {
    const { status, body } = toErrorBody(err)
    if (status >= 500) console.error('[server] 未预期错误：', err)
    void reply.code(status).send(body)
  })

  // 生产镜像里前端构建产物由同一个进程托管：cookie 会话因此天然同源。
  // 开发时没有 dist，跳过注册，前端仍由 Vite 提供。
  const webDist = deps.env.webDistDir
  const serveWeb = webDist !== '' && existsSync(webDist)
  if (serveWeb) {
    await app.register(fastifyStatic, { root: webDist, wildcard: true })
  }

  app.setNotFoundHandler((request, reply) => {
    const isRead = request.method === 'GET' || request.method === 'HEAD'
    const pathname = request.url.split('?')[0] ?? ''
    // 只对「无扩展名」的路径回退到 index.html（SPA 客户端路由）；
    // 缺资源仍回 JSON 404，免得把 404 伪装成 200 的 HTML。
    const looksLikeAsset = /\.[a-z0-9]+$/i.test(pathname)
    const isAppRoute =
      isRead &&
      !looksLikeAsset &&
      !pathname.startsWith('/api/') &&
      !pathname.startsWith('/mcp')
    if (serveWeb && isAppRoute) {
      void reply.type('text/html').sendFile('index.html')
      return
    }
    void reply
      .code(404)
      .send({ code: 'NOT_FOUND', message: ERROR_MESSAGE_BY_CODE.NOT_FOUND })
  })

  app.get('/health', async () => ({ ok: true }))

  registerAuthRoutes(app, { db: deps.db, sessions, audit, env: deps.env })
  registerDatasourceRoutes(app, {
    service: datasources,
    audit,
    sessions,
    cookieName: deps.env.sessionCookieName,
  })
  registerApiKeyRoutes(app, {
    service: apiKeys,
    audit,
    sessions,
    cookieName: deps.env.sessionCookieName,
  })
  registerAuditLogRoutes(app, { audit, sessions, cookieName: deps.env.sessionCookieName })

  // Agent 面：一个端点、一把 Bearer 密钥，鉴权与授权都在平台侧。
  registerMcpRoutes(app, {
    deps: { db: deps.db, apiKeys, datasources, pools, audit, env: deps.env },
    registry: mcpSessions,
  })

  return app
}
