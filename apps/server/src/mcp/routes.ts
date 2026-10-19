import { ERROR_MESSAGE_BY_CODE, type ApiErrorBody, type ErrorCode } from '@dblab/shared'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import { authenticateMcpRequest, type McpAuthResult } from './auth'
import type { McpDeps, McpSessionContext } from './context'
import {
  createMcpSession,
  refreshToolAvailability,
  type McpSession,
  type McpSessionRegistry,
} from './session'

export interface McpRouteOptions {
  deps: McpDeps
  registry: McpSessionRegistry
}

/** MCP 规范的会话头。会话 id 本身不是凭证：每个请求仍要带同一把密钥的 Bearer。 */
const SESSION_HEADER = 'mcp-session-id'
const ROUTE_URL = '/mcp'

/**
 * 把 /mcp 挂到 Fastify 上。
 *
 * 三个必须显式处理的点：
 * 1. `reply.hijack()`——SDK 直接往 raw socket 写，不打这个招呼 Fastify 会在 handler
 *    返回后再写一次响应，报 headers already sent。
 * 2. 容忍空体的 JSON 解析器——有客户端会发 content-type: application/json 的空 POST，
 *    Fastify 默认解析器在这种请求上硬失败。
 * 3. 这一整个作用域内**不注册任何响应钩子**（CORS / 压缩 / onSend）——hijack 之后
 *    钩子要么不生效，要么和 SDK 抢着写响应。
 */
export function registerMcpRoutes(app: FastifyInstance, options: McpRouteOptions): void {
  const guard = createRequestGuard(options.deps.env.mcpAllowedHosts)

  app.register((scope, _opts, done) => {
    scope.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, next) => {
      const raw = typeof body === 'string' ? body.trim() : ''
      if (raw.length === 0) {
        next(null, undefined)
        return
      }
      try {
        next(null, JSON.parse(raw))
      } catch (error) {
        next(error as Error, undefined)
      }
    })

    scope.route({
      method: ['POST', 'GET', 'DELETE'],
      url: ROUTE_URL,
      onRequest: guard,
      handler: (request, reply) => handleMcp(options, request, reply),
    })

    done()
  })
}

async function handleMcp(
  options: McpRouteOptions,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const auth = await authenticateMcpRequest(options.deps, request)
  if (!auth.ok) {
    sendError(reply, auth)
    return
  }

  const sessionId = sessionIdOf(request)
  if (sessionId) {
    const session = options.registry.get(sessionId)
    if (!session) {
      // 会话被回收或本来就不存在：让客户端重新 initialize，别给它一个半死的会话。
      sendError(reply, { code: 'NOT_FOUND', status: 404 })
      return
    }
    if (session.apiKeyId !== auth.context.key.id) {
      // 拿到别人的 session id 也没用：Bearer 必须是建会话的那把密钥。
      sendError(reply, { code: 'API_KEY_INVALID', status: 401 })
      return
    }
    applyContext(session, auth.context)
    session.lastUsedAt = Date.now()
    await forward(session, request, reply)
    return
  }

  // 没带会话头：只可能是 initialize，其余形态由 SDK 自己按规范拒掉。
  const session = await createMcpSession(options.deps, auth.context, {
    onInitialized: (id) => {
      session.sessionId = id
      options.registry.add(session)
    },
    onClosed: (id) => {
      void options.registry.remove(id)
    },
  })
  applyContext(session, auth.context)

  await forward(session, request, reply)

  // 没走到 initialize（比如直接 POST 了个 tools/list）：别留下一台没人引用的服务器。
  if (session.sessionId === '') await session.server.close().catch(() => {})
}

/** 就地更新会话上下文：工具回调持有的就是这个对象，换对象等于没改。 */
function applyContext(session: McpSession, context: McpSessionContext): void {
  session.context.key = context.key
  session.context.permissions = context.permissions
  session.context.clientIp = context.clientIp
  refreshToolAvailability(session, context.permissions)
}

async function forward(
  session: McpSession,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  reply.hijack()
  try {
    // 传 request.body：请求体已由上面那个解析器读过，再让 SDK 读一次只会读到空流。
    await session.transport.handleRequest(request.raw, reply.raw, request.body)
  } catch (error) {
    console.error('[mcp] 会话请求处理失败：', error)
    if (!reply.raw.headersSent) {
      reply.raw.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
      reply.raw.end(JSON.stringify({ code: 'INTERNAL', message: ERROR_MESSAGE_BY_CODE.INTERNAL }))
    } else {
      reply.raw.end()
    }
  }
}

function sendError(reply: FastifyReply, error: { code: ErrorCode; status: number }): void {
  const body: ApiErrorBody = { code: error.code, message: ERROR_MESSAGE_BY_CODE[error.code] }
  if (error.status === 401) reply.header('www-authenticate', 'Bearer')
  void reply.code(error.status).send(body)
}

function sessionIdOf(request: FastifyRequest): string | undefined {
  const value = request.headers[SESSION_HEADER]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Host / Origin 校验。
 *
 * SDK 的 allowedHosts/allowedOrigins 已标 deprecated，而且默认关闭，所以自己写。
 *
 * Host 白名单挡的是 DNS rebinding：攻击者让 evil.com 解析到内网 IP，
 * 浏览器就会带着 `Host: evil.com` 去访问本服务。此时 Origin 与 Host 是**一致的**，
 * 只做同源比对看不出来，必须有 Host 白名单。
 *
 * Origin 那一条是给浏览器加的：跨站页面发起的请求 Origin 与 Host 必然不同，直接拒。
 */
function createRequestGuard(allowedHosts: readonly string[]) {
  const allowAnyHost = allowedHosts.includes('*')
  const allowed = new Set(allowedHosts.map(normalizeHost))

  return async function guard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const host = normalizeHost(request.headers.host ?? '')
    if (!allowAnyHost && !allowed.has(host)) {
      console.warn(`[mcp] 拒绝 Host=${request.headers.host ?? '(空)'}：不在 MCP_ALLOWED_HOSTS 内`)
      sendError(reply, { code: 'FORBIDDEN', status: 403 })
      return
    }

    const origin = request.headers.origin
    if (origin && origin !== 'null' && !isSameOrigin(origin, request.headers.host ?? '')) {
      console.warn(`[mcp] 拒绝 Origin=${origin}：与 Host=${request.headers.host ?? '(空)'} 不同源`)
      sendError(reply, { code: 'FORBIDDEN', status: 403 })
    }
  }
}

/** 去掉端口、统一小写；IPv6 字面量形如 `[::1]:4000`。 */
function normalizeHost(value: string): string {
  const trimmed = value.trim().toLowerCase()
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']')
    return end === -1 ? trimmed : trimmed.slice(0, end + 1)
  }
  const colon = trimmed.lastIndexOf(':')
  return colon === -1 ? trimmed : trimmed.slice(0, colon)
}

function isSameOrigin(origin: string, host: string): boolean {
  try {
    return new URL(origin).host.toLowerCase() === host.trim().toLowerCase()
  } catch {
    return false
  }
}
