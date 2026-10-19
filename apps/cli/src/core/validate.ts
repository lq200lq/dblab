import { hostOfMcpUrl } from './url'

export type ValidateFailure =
  | 'network'
  | 'timeout'
  | 'unauthorized'
  | 'forbidden'
  | 'not-found'
  | 'not-mcp'
  | 'server-error'

export type ValidateResult =
  | { ok: true; serverName?: string; serverVersion?: string }
  | { ok: false; kind: ValidateFailure; status?: number; message: string; hint?: string }

export interface ValidateOptions {
  mcpUrl: string
  apiKey: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 8000
const PROTOCOL_VERSION = '2025-06-18'

/**
 * 真正连一次 `/mcp`：发 `initialize`，用返回的 `serverInfo` 确认对面确实是 DbLab。
 *
 * 只做「密钥形态」检查是不够的——形态对但已吊销、地址填错、Host 不在白名单，
 * 这些问题都要到写入之后才在 Agent 里暴露，排查成本全砸给用户。
 */
export async function validateApiKey(options: ValidateOptions): Promise<ValidateResult> {
  const doFetch = options.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS)

  try {
    const response = await doFetch(options.mcpUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        'Content-Type': 'application/json',
        // 少任何一个 Accept，SDK 都会直接 406。
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'dblab-cli', version: '0.1.0' },
        },
      }),
      signal: controller.signal,
    })

    if (!response.ok) return failureForStatus(response.status, options.mcpUrl)

    const sessionId = response.headers.get('mcp-session-id')
    const text = await response.text()
    const payload = parseRpcPayload(text, response.headers.get('content-type') ?? '')

    if (payload === null) {
      return {
        ok: false,
        kind: 'not-mcp',
        message: '该地址的响应不是 MCP 报文',
        hint: '确认地址指向 DbLab 的 /mcp（默认 http://localhost:4000/mcp）。',
      }
    }
    if ('error' in payload) {
      const message = (payload.error as { message?: string }).message ?? 'MCP 报错'
      return { ok: false, kind: 'server-error', message: `MCP 服务返回错误：${message}` }
    }

    const result = payload.result as { serverInfo?: { name?: string; version?: string } } | undefined
    if (sessionId) await closeMcpSession({ mcpUrl: options.mcpUrl, apiKey: options.apiKey, sessionId, fetchImpl: doFetch })
    return {
      ok: true,
      ...(result?.serverInfo?.name !== undefined ? { serverName: result.serverInfo.name } : {}),
      ...(result?.serverInfo?.version !== undefined
        ? { serverVersion: result.serverInfo.version }
        : {}),
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return {
        ok: false,
        kind: 'timeout',
        message: `连接 ${options.mcpUrl} 超时`,
        hint: '确认服务已启动、地址与网络可达。',
      }
    }
    return {
      ok: false,
      kind: 'network',
      message: `无法连接 ${options.mcpUrl}`,
      hint: `服务可能没启动。原始错误：${error instanceof Error ? error.message : String(error)}`,
    }
  } finally {
    clearTimeout(timer)
  }
}

/** 会话收尾：尽力而为，失败不影响结论（否则会因释放失败把一次成功校验判成失败）。 */
export async function closeMcpSession(options: {
  mcpUrl: string
  apiKey: string
  sessionId: string
  fetchImpl?: typeof fetch
}): Promise<void> {
  const doFetch = options.fetchImpl ?? fetch
  try {
    await doFetch(options.mcpUrl, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        'mcp-session-id': options.sessionId,
        Accept: 'application/json, text/event-stream',
      },
    })
  } catch {
    // 会话有 30 分钟空闲回收兜底，这里静默即可。
  }
}

function failureForStatus(status: number, mcpUrl: string): ValidateResult {
  if (status === 401) {
    return {
      ok: false,
      kind: 'unauthorized',
      status,
      message: '密钥无效、已吊销或已过期',
      hint: '到管控台「密钥」重新签一把，明文只在创建时显示一次。',
    }
  }
  if (status === 403) {
    const host = hostOfMcpUrl(mcpUrl)
    return {
      ok: false,
      kind: 'forbidden',
      status,
      message: '服务拒绝了该 Host',
      hint: `把 ${host} 加进服务端的 MCP_ALLOWED_HOSTS（逗号分隔，不含端口）。`,
    }
  }
  if (status === 404) {
    return {
      ok: false,
      kind: 'not-found',
      status,
      message: '该地址没有 MCP 端点',
      hint: '确认路径是 /mcp。',
    }
  }
  return {
    ok: false,
    kind: 'server-error',
    status,
    message: `MCP 服务返回 ${status}`,
  }
}

/**
 * MCP 的响应可能是 JSON，也可能是 SSE（`data: {...}` 一行）。
 * 解析不出来就返回 null，交给上层判成「不是 MCP 端点」。
 */
function parseRpcPayload(text: string, contentType: string): Record<string, unknown> | null {
  const trimmed = text.trim()
  if (contentType.includes('text/event-stream') || trimmed.startsWith('data:')) {
    for (const line of trimmed.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue
      const json = line.slice('data:'.length).trim()
      const parsed = tryParseObject(json)
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
