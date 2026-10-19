import type { ErrorCode } from '@dblab/shared'
import { HTTP_STATUS_BY_CODE } from '@dblab/shared'
import type { FastifyRequest } from 'fastify'

import { extractBearerToken, resolveApiKeyContext } from '../api-key/verify'
import { clientIpOf } from '../common/client-ip'

import type { McpDeps, McpSessionContext } from './context'

export type McpAuthResult =
  | { ok: true; context: McpSessionContext }
  | { ok: false; code: ErrorCode; status: number }

/**
 * MCP 入口的 Bearer 校验。
 *
 * 密钥本身的判定（形态、摘要、状态、期限、白名单的顺序）在 api-key/verify.ts 里，
 * 那里有单测；这里只负责 HTTP 侧的两件事：从请求里取 token 与来源 IP，
 * 再把授权表读出来交给会话上下文。
 */
export async function authenticateMcpRequest(
  deps: McpDeps,
  request: FastifyRequest,
): Promise<McpAuthResult> {
  const clientIp = clientIpOf(request)
  const resolved = await resolveApiKeyContext(
    deps.db,
    extractBearerToken(request.headers.authorization),
    clientIp,
  )
  if (!resolved.ok) {
    return { ok: false, code: resolved.code, status: HTTP_STATUS_BY_CODE[resolved.code] }
  }

  void deps.apiKeys.touchLastUsed(resolved.key.id)

  return {
    ok: true,
    context: {
      key: resolved.key,
      permissions: await deps.apiKeys.permissionMap(resolved.key.id),
      clientIp,
    },
  }
}
