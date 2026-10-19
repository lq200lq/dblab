import { closeMcpSession, mcpPost, MCP_PROTOCOL_VERSION, type McpFailure, type McpFailureKind } from './mcp-rpc'

export type ValidateFailure = McpFailureKind

export type ValidateResult =
  | { ok: true; serverName?: string; serverVersion?: string }
  | { ok: false; kind: McpFailureKind; status?: number; message: string; hint?: string }

export interface ValidateOptions {
  mcpUrl: string
  apiKey: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

/**
 * 真正连一次 `/mcp`：发 `initialize`，用返回的 `serverInfo` 确认对面确实是 DbLab。
 *
 * 只做「密钥形态」检查是不够的——形态对但已吊销、地址填错、Host 不在白名单，
 * 这些问题都要到写入之后才在 Agent 里暴露，排查成本全砸给用户。
 *
 * 只发 `initialize`、不调工具，所以这里不补 `notifications/initialized`：
 * 一条握手就够判「能不能连上、密钥好不好」，多发的请求只会让失败点更难归因。
 */
export async function validateApiKey(options: ValidateOptions): Promise<ValidateResult> {
  const reply = await mcpPost(
    options,
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'dblab-cli', version: '0.1.0' },
      },
    },
  )
  if (!reply.ok) return toFailure(reply.failure)

  const sessionId = reply.sessionId
  if (sessionId) await closeMcpSession(options, sessionId)

  const result = (reply.body ?? {}) as { serverInfo?: { name?: string; version?: string } }
  return {
    ok: true,
    ...(result.serverInfo?.name !== undefined ? { serverName: result.serverInfo.name } : {}),
    ...(result.serverInfo?.version !== undefined ? { serverVersion: result.serverInfo.version } : {}),
  }
}

function toFailure(failure: McpFailure): ValidateResult {
  return {
    ok: false,
    kind: failure.kind,
    message: failure.message,
    ...(failure.status !== undefined ? { status: failure.status } : {}),
    ...(failure.hint !== undefined ? { hint: failure.hint } : {}),
  }
}
