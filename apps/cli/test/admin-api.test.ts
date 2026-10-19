import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AdminApi, type DatasourceInput } from '../src/core/admin-api'
import { CliError } from '../src/core/errors'

const INPUT: DatasourceInput = {
  name: 'orders',
  engine: 'postgres',
  host: 'localhost',
  port: 5432,
  database: 'orders_db',
  username: 'reader',
  password: 'pw',
}

interface Recorded {
  method: string
  path: string
  body?: unknown
  cookie?: string | null
}

function makeFetch(
  routes: Record<string, unknown | ((body: unknown) => unknown)>,
  options: { setCookie?: string; unauthorized?: boolean } = {},
) {
  const calls: Recorded[] = []
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname
    const method = init?.method ?? 'GET'
    const headers = init?.headers as Record<string, string> | undefined
    calls.push({
      method,
      path,
      ...(init?.body !== undefined ? { body: JSON.parse(init.body as string) as unknown } : {}),
      cookie: headers?.Cookie ?? null,
    })

    if (options.unauthorized && !headers?.Cookie) {
      return new Response(JSON.stringify({ code: 'UNAUTHORIZED', message: '请先登录' }), { status: 401 })
    }

    const handler = routes[path]
    if (handler === undefined) {
      return new Response(JSON.stringify({ code: 'NOT_FOUND', message: '资源不存在' }), { status: 404 })
    }
    const payload = typeof handler === 'function' ? handler(calls.at(-1)?.body) : handler

    const isLogin = path === '/api/v1/auth/login'
    return new Response(JSON.stringify(payload), {
      status: path === '/api/v1/datasources' && method === 'POST' ? 201 : 200,
      headers: {
        'content-type': 'application/json',
        ...(isLogin && options.setCookie !== undefined ? { 'set-cookie': options.setCookie } : {}),
      },
    })
  }) as unknown as typeof fetch
  return { impl, calls }
}

const COOKIE = 'dblab_session=abc123; Path=/; HttpOnly; SameSite=Lax'

function apiWith(impl: typeof fetch, baseUrl = 'http://localhost:18400') {
  return new AdminApi({ baseUrl, fetchImpl: impl })
}

describe('AdminApi 登录', () => {
  it('从 set-cookie 取会话并在后续请求带上', async () => {
    const { impl, calls } = makeFetch(
      { '/api/v1/auth/login': { user: { id: 1, username: 'admin', displayName: null } }, '/api/v1/datasources': { items: [] } },
      { setCookie: COOKIE },
    )
    const api = apiWith(impl)
    await api.login('admin', 'pw')
    expect(calls[0]?.path).toBe('/api/v1/auth/login')
    expect(calls[0]?.body).toEqual({ username: 'admin', password: 'pw' })
    expect(calls[0]?.cookie).toBeNull()

    await api.listDatasources()
    expect(calls.at(-1)?.cookie).toBe('dblab_session=abc123')
  })

  it('服务端不回 cookie 时报校验错误', async () => {
    const { impl } = makeFetch({ '/api/v1/auth/login': { user: {} } })
    await expect(apiWith(impl).login('admin', 'pw')).rejects.toThrow(/cookie/)
  })

  it('口令错时透出服务端文案', async () => {
    const failing = vi.fn(async () => {
      return new Response(JSON.stringify({ code: 'INVALID_CREDENTIALS', message: '账号或密码不正确' }), {
        status: 401,
      })
    }) as unknown as typeof fetch
    await expect(apiWith(failing).login('admin', 'bad')).rejects.toThrow('账号或密码不正确')
  })
})

describe('probeDatasource 与 createDatasource', () => {
  it('探测走 /datasources/test 且带上完整连接参数', async () => {
    const { impl, calls } = makeFetch(
      {
        '/api/v1/auth/login': { user: {} },
        '/api/v1/datasources/test': { ok: true, latencyMs: 12, serverVersion: 'PostgreSQL 17.2', message: null },
      },
      { setCookie: COOKIE },
    )
    const api = apiWith(impl)
    await api.login('admin', 'pw')
    const result = await api.probeDatasource(INPUT)
    expect(result.ok).toBe(true)
    expect(calls.at(-1)?.path).toBe('/api/v1/datasources/test')
    expect(calls.at(-1)?.body).toEqual(INPUT)
  })

  it('创建走 POST /datasources 并返回带 id 的摘要', async () => {
    const { impl, calls } = makeFetch(
      {
        '/api/v1/auth/login': { user: {} },
        '/api/v1/datasources': { id: 7, name: 'orders', engine: 'postgres', host: 'localhost', port: 5432, database: 'orders_db', username: 'reader', enabled: true },
      },
      { setCookie: COOKIE },
    )
    const api = apiWith(impl)
    await api.login('admin', 'pw')
    const created = await api.createDatasource(INPUT)
    expect(created.id).toBe(7)
    expect(calls.at(-1)?.method).toBe('POST')
  })
})

describe('grantDatasource：整表替换语义下必须合并', () => {
  async function setup(grants: unknown[], keys: unknown[]) {
    const captured: Recorded[] = []
    const impl = vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname
      const method = init?.method ?? 'GET'
      const body = init?.body !== undefined ? (JSON.parse(init.body as string) as unknown) : undefined
      captured.push({ method, path, ...(body !== undefined ? { body } : {}) })
      if (path === '/api/v1/auth/login') {
        return new Response(JSON.stringify({ user: {} }), { status: 200, headers: { 'set-cookie': COOKIE } })
      }
      if (path === '/api/v1/api-keys') return new Response(JSON.stringify({ items: keys }), { status: 200 })
      if (path === '/api/v1/api-keys/5') return new Response(JSON.stringify({ grants }), { status: 200 })
      if (path === '/api/v1/api-keys/5/grants' && method === 'PUT') {
        return new Response(JSON.stringify({ grants: body }), { status: 200 })
      }
      return new Response('{}', { status: 404 })
    }) as unknown as typeof fetch

    const api = apiWith(impl)
    await api.login('admin', 'pw')
    return { api, captured }
  }

  it('新库追加，原有授权一条都不丢', async () => {
    const { api, captured } = await setup(
      [
        { datasourceId: 2, datasourceName: 'users', canRead: true, canWrite: false },
        { datasourceId: 3, datasourceName: 'audit', canRead: true, canWrite: true },
      ],
      [{ id: 5, name: 'qoder', prefix: 'dblab_ab12cd34', status: 'active' }],
    )
    const result = await api.grantDatasource(5, { id: 9, name: 'orders' }, { canRead: true, canWrite: true })

    const put = captured.find((call) => call.method === 'PUT')
    expect(put?.body).toEqual({
      grants: [
        { datasourceId: 2, canRead: true, canWrite: false },
        { datasourceId: 3, canRead: true, canWrite: true },
        { datasourceId: 9, canRead: true, canWrite: true },
      ],
    })
    expect(result.total).toBe(3)
  })

  it('已有该库授权时做并集而不是降级或重复', async () => {
    const { api, captured } = await setup(
      [{ datasourceId: 9, datasourceName: 'orders', canRead: true, canWrite: false }],
      [{ id: 5, name: 'qoder', prefix: 'dblab_ab12cd34', status: 'active' }],
    )
    await api.grantDatasource(5, { id: 9, name: 'orders' }, { canRead: true, canWrite: true })

    const put = captured.find((call) => call.method === 'PUT')
    expect((put?.body as { grants: unknown[] }).grants).toEqual([
      { datasourceId: 9, canRead: true, canWrite: true },
    ])
  })

  it('PUT 前一定先 GET 过当前授权', async () => {
    const { api, captured } = await setup([], [{ id: 5, name: 'k', prefix: 'dblab_ab12cd34', status: 'active' }])
    await api.grantDatasource(5, { id: 1, name: 'x' }, { canRead: true, canWrite: false })
    const order = captured.filter((c) => c.path.startsWith('/api/v1/api-keys/5')).map((c) => c.method)
    expect(order).toEqual(['GET', 'PUT'])
  })
})

describe('findApiKeyByPrefix', () => {
  it('按 dblab_<定位段> 命中活动密钥', async () => {
    const { impl } = makeFetch(
      {
        '/api/v1/auth/login': { user: {} },
        '/api/v1/api-keys': {
          items: [
            { id: 1, name: 'old', prefix: 'dblab_zzzzzzzz', status: 'revoked' },
            { id: 2, name: 'qoder', prefix: 'dblab_ab12cd34', status: 'active' },
          ],
        },
      },
      { setCookie: COOKIE },
    )
    const api = apiWith(impl)
    await api.login('admin', 'pw')
    expect(await api.findApiKeyByPrefix('dblab_ab12cd34')).toMatchObject({ id: 2, name: 'qoder' })
  })

  it('找不到时说明这把密钥不属于这套服务', async () => {
    const { impl } = makeFetch(
      { '/api/v1/auth/login': { user: {} }, '/api/v1/api-keys': { items: [] } },
      { setCookie: COOKIE },
    )
    const api = apiWith(impl)
    await api.login('admin', 'pw')
    await expect(api.findApiKeyByPrefix('dblab_nosuch0')).rejects.toBeInstanceOf(CliError)
  })

  it('命中但非活动状态时也拦下', async () => {
    const { impl } = makeFetch(
      {
        '/api/v1/auth/login': { user: {} },
        '/api/v1/api-keys': { items: [{ id: 1, name: 'k', prefix: 'dblab_ab12cd34', status: 'revoked' }] },
      },
      { setCookie: COOKIE },
    )
    const api = apiWith(impl)
    await api.login('admin', 'pw')
    await expect(api.findApiKeyByPrefix('dblab_ab12cd34')).rejects.toThrow(/revoked/)
  })
})

describe('连接失败', () => {
  it('网络错误提示端口口径（compose 18400 / 源码 4000）', async () => {
    const failing = vi.fn(async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    const api = apiWith(failing)
    const error = await api.login('admin', 'pw').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CliError)
    expect((error as CliError).message).toContain('无法连接')
    expect((error as CliError).hint).toContain('18400')
  })
})

beforeEach(() => {
  vi.restoreAllMocks()
})
