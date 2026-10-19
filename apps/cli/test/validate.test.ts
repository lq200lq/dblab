import { describe, expect, it, vi } from 'vitest'

import { validateApiKey } from '../src/core/validate'

const MCP_URL = 'http://localhost:4000/mcp'
const KEY = `dblab_ab12cd34_${'A'.repeat(43)}`

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  })
}

describe('validateApiKey', () => {
  it('成功时返回 serverInfo 并释放会话', async () => {
    const calls: Array<{ method: string; headers: Record<string, string> }> = []
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      calls.push({ method: init?.method ?? 'GET', headers })
      if (init?.method === 'DELETE') return new Response(null, { status: 204 })
      return jsonResponse(
        { jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'dblab', version: '0.1.0' } } },
        { headers: { 'mcp-session-id': 'sess-1' } },
      )
    }) as unknown as typeof fetch

    const result = await validateApiKey({ mcpUrl: MCP_URL, apiKey: KEY, fetchImpl })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.serverName).toBe('dblab')
      expect(result.serverVersion).toBe('0.1.0')
    }
    expect(calls.map((c) => c.method)).toEqual(['POST', 'DELETE'])
    expect(calls[1]?.headers['mcp-session-id']).toBe('sess-1')
    // Accept 必须两个都在，否则 SDK 直接 406
    expect(calls[0]?.headers.Accept).toBe('application/json, text/event-stream')
    expect(calls[0]?.headers.Authorization).toBe(`Bearer ${KEY}`)
  })

  it('解析 SSE 响应', async () => {
    const fetchImpl = vi.fn(async () => {
      const body = `event: message\ndata: ${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: { serverInfo: { name: 'dblab' } },
      })}\n\n`
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }) as unknown as typeof fetch

    const result = await validateApiKey({ mcpUrl: MCP_URL, apiKey: KEY, fetchImpl })
    expect(result.ok).toBe(true)
  })

  it.each([
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [404, 'not-found'],
    [500, 'server-error'],
  ])('状态码 %i 映射为 %s', async (status, kind) => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status })) as unknown as typeof fetch
    const result = await validateApiKey({ mcpUrl: MCP_URL, apiKey: KEY, fetchImpl })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe(kind)
  })

  it('403 的提示里带上主机名与 MCP_ALLOWED_HOSTS', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 403 })) as unknown as typeof fetch
    const result = await validateApiKey({ mcpUrl: MCP_URL, apiKey: KEY, fetchImpl })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.hint).toContain('MCP_ALLOWED_HOSTS')
      expect(result.hint).toContain('localhost')
    }
  })

  it('非 MCP 报文判为 not-mcp', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('<html>hello</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    ) as unknown as typeof fetch
    const result = await validateApiKey({ mcpUrl: MCP_URL, apiKey: KEY, fetchImpl })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe('not-mcp')
  })

  it('网络错误判为 network', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    const result = await validateApiKey({ mcpUrl: MCP_URL, apiKey: KEY, fetchImpl })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe('network')
  })

  it('超时判为 timeout', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('aborted')
          error.name = 'AbortError'
          reject(error)
        })
      })
      throw new Error('unreachable')
    }) as unknown as typeof fetch

    const result = await validateApiKey({ mcpUrl: MCP_URL, apiKey: KEY, fetchImpl, timeoutMs: 20 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe('timeout')
  })

  it('JSON-RPC error 判为 server-error', async () => {
    const fetchImpl = vi.fn(
      async () => jsonResponse({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'boom' } }),
    ) as unknown as typeof fetch
    const result = await validateApiKey({ mcpUrl: MCP_URL, apiKey: KEY, fetchImpl })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.kind).toBe('server-error')
      expect(result.message).toContain('boom')
    }
  })
})
