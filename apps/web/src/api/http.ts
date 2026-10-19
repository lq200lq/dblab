/**
 * 统一 HTTP 封装 + 错误收敛。
 *
 * 页面里不该出现 fetch、接口路径或错误码：这个文件是**唯一**把 code 翻成中文的地方
 * （服务端给了 message 就用服务端的），401 统一触发跳登录页。
 */
import { ERROR_MESSAGE_BY_CODE, type ErrorCode } from '@dblab/shared'

const baseURL = (import.meta.env.VITE_API_BASE as string | undefined) || '/api/v1'

export interface FetchOptions extends Omit<RequestInit, 'body'> {
  body?: unknown
  query?: Record<string, unknown>
}

/** 前端可能遇到的、服务端没发的错误码。 */
const CLIENT_CODES = {
  NETWORK: '无法连接服务器，请确认服务端已启动',
  TIMEOUT: '服务器响应超时，请稍后重试',
  UNKNOWN: '操作失败，请稍后重试',
} as const

export class ApiError extends Error {
  readonly code: string
  readonly detail: unknown

  constructor(code: string, message: string, detail?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.detail = detail
  }
}

/** 把任意异常收敛成一句能给人看的中文。 */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message
  if (error instanceof Error && error.message) return error.message
  return CLIENT_CODES.UNKNOWN
}

export function errorCodeOf(error: unknown): string {
  return error instanceof ApiError ? error.code : 'UNKNOWN'
}

function messageFor(code: string, fromServer?: unknown): string {
  if (typeof fromServer === 'string' && fromServer.trim()) return fromServer.trim()
  if (code in ERROR_MESSAGE_BY_CODE) return ERROR_MESSAGE_BY_CODE[code as ErrorCode]
  if (code in CLIENT_CODES) return CLIENT_CODES[code as keyof typeof CLIENT_CODES]
  return CLIENT_CODES.UNKNOWN
}

function buildUrl(path: string, query?: Record<string, unknown>): string {
  const suffix = path.startsWith('/') ? path : `/${path}`
  const base = baseURL.replace(/\/$/, '')
  // 相对基址（默认）直接拼，交给 vite 代理；绝对基址时保留主机。
  const target = /^https?:\/\//.test(base)
    ? new URL(base + suffix)
    : new URL(base + suffix, window.location.origin)

  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue
      target.searchParams.set(key, String(value))
    }
  }
  return /^https?:\/\//.test(base) ? target.href : target.pathname + target.search
}

/** 401 时的全局动作（切登录页）。由应用启动时注入，避免 api 层反向依赖路由。 */
let unauthorizedHandler: (() => void) | null = null

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler
}

async function request<T>(path: string, options: FetchOptions = {}): Promise<T> {
  const url = buildUrl(path, options.query)

  let response: Response
  try {
    response = await fetch(url, {
      credentials: 'same-origin',
      ...options,
      method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
      headers: {
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(options.headers ?? {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    })
  } catch {
    throw new ApiError('NETWORK', CLIENT_CODES.NETWORK)
  }

  let data: unknown = null
  if (response.status !== 204) {
    const contentType = response.headers.get('content-type') ?? ''
    if (contentType.includes('application/json')) {
      data = await response.json().catch(() => null)
    } else {
      data = await response.text().catch(() => '')
    }
  }

  if (!response.ok) {
    const body = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : null
    const code = typeof body?.code === 'string' ? body.code : 'UNKNOWN'
    const error = new ApiError(code, messageFor(code, body?.message), body ?? data)
    if (response.status === 401) unauthorizedHandler?.()
    throw error
  }

  return data as T
}

export const http = {
  get<T>(path: string, query?: Record<string, unknown>): Promise<T> {
    return request<T>(path, { method: 'GET', query })
  },
  post<T>(path: string, body?: unknown): Promise<T> {
    return request<T>(path, { method: 'POST', body })
  },
  patch<T>(path: string, body?: unknown): Promise<T> {
    return request<T>(path, { method: 'PATCH', body })
  },
  put<T>(path: string, body?: unknown): Promise<T> {
    return request<T>(path, { method: 'PUT', body })
  },
  delete<T>(path: string): Promise<T> {
    return request<T>(path, { method: 'DELETE' })
  },
}
