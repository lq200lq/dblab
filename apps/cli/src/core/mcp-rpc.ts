import { hostOfMcpUrl } from './url'

/**
 * MCP 报文层：CLI 里所有「连一次 /mcp」都走这一份实现。
 *
 * 三个坑位与 validate.ts 的原始版本一致：Accept 少一个就 406；响应可能是 SSE；
 * 会话 id 只在 initialize 的响应头里给，后续请求必须带上，而且每个请求仍要带 Bearer。
 */

export const MCP_PROTOCOL_VERSION = '2025-06-18'
const SESSION_HEADER = 'mcp-session-id'
const ACCEPT = 'application/json, text/event-stream'
const DEFAULT_TIMEOUT_MS = 8000
const CLIENT_INFO = { name: 'dblab-cli', version: '0.1.0' }

export type McpFailureKind =
  | 'network'
  | 'timeout'
  | 'unauthorized'
  | 'forbidden'
  | 'not-found'
  | 'not-mcp'
  | 'server-error'

export interface McpFailure {
  kind: McpFailureKind
  status?: number
  message: string
  hint?: string
}

export interface McpEndpoint {
  mcpUrl: string
  apiKey: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export type McpReply =
  | { ok: true; body: Record<string, unknown> | null; sessionId: string | null }
  | { ok: false; failure: McpFailure }

function requestHeaders(endpoint: McpEndpoint, sessionId?: string | null): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${endpoint.apiKey}`,
    Accept: ACCEPT,
    ...(sessionId ? { [SESSION_HEADER]: sessionId } : {}),
  }
}

/** 发一个 JSON-RPC 请求；HTTP 层的问题都归到 McpFailure，不当成「对面坏了」。 */
export async function mcpPost(
  endpoint: McpEndpoint,
  payload: Record<string, unknown>,
  sessionId?: string | null,
): Promise<McpReply> {
  const doFetch = endpoint.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), endpoint.timeoutMs ?? DEFAULT_TIMEOUT_MS)

  try {
    const response = await doFetch(endpoint.mcpUrl, {
      method: 'POST',
      headers: requestHeaders(endpoint, sessionId),
      body: JSON.stringify(payload),
      signal: controller.signal,
    })

    if (!response.ok) return { ok: false, failure: failureForStatus(response.status, endpoint.mcpUrl) }

    const text = await response.text()
    const body = parseRpcPayload(text, response.headers.get('content-type') ?? '')
    if (body === null) {
      // 通知按规范不该有响应体（服务端回 202 空体），空体在这里是正常的。
      if (!('id' in payload) && text.trim().length === 0) {
        return { ok: true, body: null, sessionId: response.headers.get(SESSION_HEADER) }
      }
      return {
        ok: false,
        failure: {
          kind: 'not-mcp',
          message: '该地址的响应不是 MCP 报文',
          hint: '确认地址指向 DbLab 的 /mcp（默认 http://localhost:4000/mcp）。',
        },
      }
    }
    if ('error' in body) {
      const message = (body.error as { message?: string }).message ?? 'MCP 报错'
      return { ok: false, failure: { kind: 'server-error', message: `MCP 服务返回错误：${message}` } }
    }

    return { ok: true, body: (body.result as Record<string, unknown> | undefined) ?? null, sessionId: response.headers.get(SESSION_HEADER) }
  } catch (error) {
    return { ok: false, failure: networkFailure(endpoint, error) }
  } finally {
    clearTimeout(timer)
  }
}

export interface McpSessionHandle {
  sessionId: string
  serverName?: string
  serverVersion?: string
}

/**
 * 走完握手：`initialize` 拿会话 id，再补一条 `notifications/initialized`。
 * 规范里工具调用必须发生在初始化完成之后，省掉第二条在有的服务端会被判成未初始化。
 */
export async function openMcpSession(endpoint: McpEndpoint): Promise<McpSessionHandle | McpFailure> {
  const initialized = await mcpPost(endpoint, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
  })
  if (!initialized.ok) return initialized.failure
  if (initialized.sessionId === null) {
    return {
      kind: 'not-mcp',
      message: '服务端没有回传会话 id',
      hint: '确认地址指向 DbLab 的 /mcp；这个 CLI 需要一个有会话的 Streamable HTTP 端点。',
    }
  }

  const notification = await mcpPost(
    endpoint,
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    initialized.sessionId,
  )
  if (!notification.ok) return notification.failure

  const info = (initialized.body ?? {}) as { serverInfo?: { name?: string; version?: string } }
  return {
    sessionId: initialized.sessionId,
    ...(info.serverInfo?.name !== undefined ? { serverName: info.serverInfo.name } : {}),
    ...(info.serverInfo?.version !== undefined ? { serverVersion: info.serverInfo.version } : {}),
  }
}

export type ToolOutcome = { ok: true; payload: Record<string, unknown> } | { ok: false; failure: McpFailure }

/**
 * 调一个工具。返回值优先取 `structuredContent`（机器可读），
 * 老网关把它丢掉时退回 `content[0].text` 里的同一份 JSON。
 */
export async function callMcpTool(
  endpoint: McpEndpoint,
  sessionId: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolOutcome> {
  const reply = await mcpPost(
    endpoint,
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } },
    sessionId,
  )
  if (!reply.ok) return { ok: false, failure: reply.failure }

  const result = (reply.body ?? {}) as {
    isError?: boolean
    content?: Array<{ type?: string; text?: string }>
    structuredContent?: Record<string, unknown>
  }
  const payload = result.structuredContent ?? parseToolText(result.content)

  if (payload === null) {
    return {
      ok: false,
      failure: { kind: 'not-mcp', message: `工具 ${name} 没有返回可解析的结果`, hint: '确认服务端版本支持 structuredContent。' },
    }
  }
  if (result.isError) {
    const message = typeof payload.message === 'string' ? payload.message : `工具 ${name} 调用失败`
    const code = typeof payload.code === 'string' ? `（${payload.code}）` : ''
    return { ok: false, failure: { kind: 'server-error', message: `${message}${code}` } }
  }
  return { ok: true, payload }
}

/** 会话收尾：尽力而为，失败不影响结论（否则会因释放失败把一次成功判成失败）。 */
export async function closeMcpSession(endpoint: McpEndpoint, sessionId: string): Promise<void> {
  const doFetch = endpoint.fetchImpl ?? fetch
  try {
    await doFetch(endpoint.mcpUrl, {
      method: 'DELETE',
      headers: requestHeaders(endpoint, sessionId),
    })
  } catch {
    // 会话有空闲回收兜底，这里静默即可。
  }
}

export function failureForStatus(status: number, mcpUrl: string): McpFailure {
  if (status === 401) {
    return {
      kind: 'unauthorized',
      status,
      message: '密钥无效、已吊销或已过期',
      hint: '到管控台「密钥」重新签一把，明文只在创建时显示一次。',
    }
  }
  if (status === 403) {
    return {
      kind: 'forbidden',
      status,
      message: '服务拒绝了该 Host',
      hint: `把 ${hostOfMcpUrl(mcpUrl)} 加进服务端的 MCP_ALLOWED_HOSTS（逗号分隔，不含端口）。`,
    }
  }
  if (status === 404) {
    return { kind: 'not-found', status, message: '该地址没有 MCP 端点', hint: '确认路径是 /mcp。' }
  }
  return { kind: 'server-error', status, message: `MCP 服务返回 ${status}` }
}

function networkFailure(endpoint: McpEndpoint, error: unknown): McpFailure {
  if (error instanceof Error && error.name === 'AbortError') {
    return { kind: 'timeout', message: `连接 ${endpoint.mcpUrl} 超时`, hint: '确认服务已启动、地址与网络可达。' }
  }
  return {
    kind: 'network',
    message: `无法连接 ${endpoint.mcpUrl}`,
    hint: `服务可能没启动。原始错误：${error instanceof Error ? error.message : String(error)}`,
  }
}

function parseToolText(content: Array<{ type?: string; text?: string }> | undefined): Record<string, unknown> | null {
  const text = content?.find((item) => typeof item.text === 'string')?.text
  return text === undefined ? null : tryParseObject(text)
}

/**
 * MCP 的响应可能是 JSON，也可能是 SSE（`data: {...}` 一行）。
 * 解析不出来就返回 null，交给上层判成「不是 MCP 端点」。
 */
export function parseRpcPayload(text: string, contentType: string): Record<string, unknown> | null {
  const trimmed = text.trim()
  if (contentType.includes('text/event-stream') || trimmed.startsWith('data:')) {
    for (const line of trimmed.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue
      const parsed = tryParseObject(line.slice('data:'.length).trim())
      if (parsed) return parsed
    }
    return null
  }
  return tryParseObject(trimmed)
}

function tryParseObject(text: string): Record<string, unknown> | null {
  if (text.length === 0) return null
  try {
    const parsed = JSON.parse(text) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}
