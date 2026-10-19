import { randomBytes } from 'node:crypto'
import { request as httpRequest } from 'node:http'

import { createPlatformDb, ensureAdmin, resetMasterKeyCache, type PlatformDb } from '@dblab/db'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { FastifyInstance } from 'fastify'
import { Client as PgClient } from 'pg'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { buildApp } from '../src/app'
import { parseEnv } from '../src/config/env'

/**
 * MCP 端点的端到端验证：真起一个 HTTP 服务，用 SDK 自带的客户端连上去。
 *
 * 这里刻意不走 app.inject——MCP 传输层要拿裸 req/res 自己写响应（SSE），
 * 注入式的假 request 覆盖不到那条路径。
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL
const TEST_PROBE_URL = process.env.TEST_PROBE_URL
const describeMcp = TEST_DATABASE_URL && TEST_PROBE_URL ? describe : describe.skip

const PASSWORD = 'admin123'
const READONLY_DS = 'itest-mcp-ro'
const savedMasterKey = process.env.CREDENTIAL_MASTER_KEY

describeMcp('MCP 端点', () => {
  let app: FastifyInstance
  let db: PlatformDb
  let pool: ReturnType<typeof createPlatformDb>['pool']
  let probe: PgClient
  let baseUrl = ''
  let mcpUrl: URL
  let cookie = ''
  let datasourceId = 0
  let readOnlyKey = ''
  let readWriteKey = ''

  beforeAll(async () => {
    process.env.CREDENTIAL_MASTER_KEY = randomBytes(32).toString('base64')
    resetMasterKeyCache()

    const created = createPlatformDb(TEST_DATABASE_URL as string)
    db = created.db
    pool = created.pool
    await ensureAdmin(db, 'admin', PASSWORD)

    // 上一轮可能没跑完清理（比如断言先挂了）：先把自己那几行扫掉，用例可重复执行。
    await pool.query(`delete from api_key where name like 'itest-mcp-%'`)
    await pool.query(`delete from datasource where name = $1`, [READONLY_DS])

    // 被纳管的那个库由本文件自己准备，不依赖其它测试文件跑没跑过。
    probe = new PgClient({ connectionString: TEST_PROBE_URL })
    await probe.connect()
    await probe.query('drop table if exists mcp_probe')
    await probe.query('create table mcp_probe (id serial primary key, name text not null)')
    await probe.query(`insert into mcp_probe (name) values ('a'), ('b'), ('c')`)

    const { env } = parseEnv({ DATABASE_URL: TEST_DATABASE_URL, ADMIN_PASSWORD: PASSWORD })
    app = await buildApp({ env, db, pool })
    await app.listen({ port: 0, host: '127.0.0.1' })
    const address = app.server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    baseUrl = `http://127.0.0.1:${port}`
    mcpUrl = new URL(`${baseUrl}/mcp`)

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'admin', password: PASSWORD },
    })
    cookie = String(login.headers['set-cookie']).split(';')[0] as string

    datasourceId = await createDatasource()
    readOnlyKey = await createKey('itest-mcp-readonly', [{ datasourceId, canRead: true, canWrite: false }])
    readWriteKey = await createKey('itest-mcp-readwrite', [
      { datasourceId, canRead: true, canWrite: true },
    ])
  })

  afterAll(async () => {
    await app.close()
    await probe.query('drop table if exists mcp_probe')
    await probe.end()
    // audit_log 有只增不改触发器，删不掉；用例本身对历史行是容忍的。
    await pool.query('delete from api_key')
    await pool.query('delete from datasource')
    await pool.query('delete from session')
    await pool.query('delete from admin_user where username = $1', ['admin'])
    await pool.end()

    if (savedMasterKey === undefined) delete process.env.CREDENTIAL_MASTER_KEY
    else process.env.CREDENTIAL_MASTER_KEY = savedMasterKey
    resetMasterKeyCache()
  })

  async function createDatasource(): Promise<number> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/datasources',
      headers: { cookie },
      payload: {
        name: READONLY_DS,
        engine: 'postgres',
        host: 'localhost',
        port: 5432,
        database: new URL(TEST_PROBE_URL as string).pathname.replace(/^\//, ''),
        username: 'postgres',
        password: 'postgres',
      },
    })
    expect(res.statusCode).toBe(201)
    return (res.json() as { id: number }).id
  }

  async function createKey(
    name: string,
    grants: Array<{ datasourceId: number; canRead: boolean; canWrite: boolean }>,
    extra: Record<string, unknown> = {},
  ): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/api-keys',
      headers: { cookie },
      payload: { name, grants, ...extra },
    })
    expect(res.statusCode).toBe(201)
    return (res.json() as { plaintextKey: string }).plaintextKey
  }

  /** 连一次、拿到工具名清单、断开。 */
  async function toolNames(key: string): Promise<string[]> {
    const client = new Client({ name: 'itest', version: '1' })
    const transport = new StreamableHTTPClientTransport(mcpUrl, {
      requestInit: { headers: { authorization: `Bearer ${key}` } },
    })
    await client.connect(transport)
    try {
      const { tools } = await client.listTools()
      return tools.map((tool) => tool.name).sort()
    } finally {
      await client.close()
    }
  }

  async function callTool(
    key: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ isError: boolean; payload: Record<string, unknown> }> {
    const client = new Client({ name: 'itest', version: '1' })
    const transport = new StreamableHTTPClientTransport(mcpUrl, {
      requestInit: { headers: { authorization: `Bearer ${key}` } },
    })
    await client.connect(transport)
    try {
      const result = (await client.callTool({ name, arguments: args })) as {
        isError?: boolean
        structuredContent?: Record<string, unknown>
      }
      return { isError: result.isError === true, payload: result.structuredContent ?? {} }
    } finally {
      await client.close()
    }
  }

  /** 裸 HTTP 调 /mcp：用来验证鉴权与协议层，不经过 SDK 客户端。 */
  function rawPost(body: unknown, headers: Record<string, string>): Promise<Response> {
    return fetch(mcpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }

  /** fetch 不让改 Host，只能自己发一个原始请求。 */
  function rawRequestWithHost(
    body: unknown,
    host: string,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(body)
      const request = httpRequest(
        {
          host: '127.0.0.1',
          port: Number(mcpUrl.port),
          path: '/mcp',
          method: 'POST',
          headers: {
            host,
            authorization: `Bearer ${readOnlyKey}`,
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload),
          },
        },
        (response) => {
          let text = ''
          response.on('data', (chunk) => (text += String(chunk)))
          response.on('end', () => {
            try {
              resolve({ status: response.statusCode ?? 0, body: JSON.parse(text) as Record<string, unknown> })
            } catch (error) {
              reject(error)
            }
          })
        },
      )
      request.on('error', reject)
      request.end(payload)
    })
  }

  const initializeBody = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'curl', version: '1' } },
  }

  test('裸 initialize 返回结果并下发 Mcp-Session-Id', async () => {
    const res = await rawPost(initializeBody, { authorization: `Bearer ${readOnlyKey}` })
    expect(res.status).toBe(200)
    const sessionId = res.headers.get('mcp-session-id')
    expect(sessionId).toBeTruthy()
    const text = await res.text()
    expect(text).toContain('protocolVersion')

    // 收尾：DELETE 结束会话。
    const closed = await fetch(mcpUrl, {
      method: 'DELETE',
      headers: { 'mcp-session-id': sessionId as string, authorization: `Bearer ${readOnlyKey}` },
    })
    expect([200, 204]).toContain(closed.status)
  })

  test('无 Bearer / 错 Bearer 在协议层之前就被 401', async () => {
    const missing = await rawPost(initializeBody, {})
    expect(missing.status).toBe(401)
    expect(missing.headers.get('www-authenticate')).toBe('Bearer')
    expect((await missing.json()) as { code: string }).toMatchObject({ code: 'API_KEY_INVALID' })

    const wrong = await rawPost(initializeBody, {
      authorization: `Bearer dblab_00000000_${'x'.repeat(43)}`,
    })
    expect(wrong.status).toBe(401)
    expect((await wrong.json()) as { code: string }).toMatchObject({ code: 'API_KEY_INVALID' })
  })

  test('Host 不在白名单内被 403（DNS rebinding 那道闸）', async () => {
    // fetch 不允许改 Host 头，这里用裸 http 请求。
    const response = await rawRequestWithHost(initializeBody, 'evil.example.com')
    expect(response.status).toBe(403)
    expect(response.body).toMatchObject({ code: 'FORBIDDEN' })
  })

  test('工具可见性由授权决定：只读 4 个、读写 5 个', async () => {
    expect(await toolNames(readOnlyKey)).toEqual([
      'describe_table',
      'list_datasources',
      'list_tables',
      'query',
    ])
    expect(await toolNames(readWriteKey)).toEqual([
      'describe_table',
      'execute',
      'list_datasources',
      'list_tables',
      'query',
    ])
  })

  test('list_datasources 只列出已授权的数据源', async () => {
    const client = new Client({ name: 'itest', version: '1' })
    const transport = new StreamableHTTPClientTransport(mcpUrl, {
      requestInit: { headers: { authorization: `Bearer ${readOnlyKey}` } },
    })
    await client.connect(transport)
    try {
      const result = (await client.callTool({ name: 'list_datasources', arguments: {} })) as {
        structuredContent?: { items: Array<{ name: string; canRead: boolean; canWrite: boolean }> }
      }
      expect(result.structuredContent?.items).toEqual([
        { name: READONLY_DS, engine: 'postgres', database: expect.any(String), canRead: true, canWrite: false },
      ])
    } finally {
      await client.close()
    }
  })

  test('list_tables / describe_table 走内省 SQL', async () => {
    const tables = await callTool(readOnlyKey, 'list_tables', { datasource: READONLY_DS })
    expect(tables.isError).toBe(false)
    const names = (tables.payload.tables as Array<{ name: string }>).map((table) => table.name)
    expect(names).toContain('mcp_probe')

    const described = await callTool(readOnlyKey, 'describe_table', {
      datasource: READONLY_DS,
      table: 'mcp_probe',
    })
    expect(described.isError).toBe(false)
    const table = described.payload.table as { primaryKey: string[]; columns: Array<{ name: string }> }
    expect(table.primaryKey).toEqual(['id'])
    expect(table.columns.map((column) => column.name)).toEqual(['id', 'name'])
  })

  test('query 跑 SELECT 成功，且把行带回', async () => {
    const result = await callTool(readOnlyKey, 'query', {
      datasource: READONLY_DS,
      sql: 'select id, name from mcp_probe order by id',
    })
    expect(result.isError).toBe(false)
    expect(result.payload.rowCount).toBe(3)
    expect(result.payload.rows).toEqual([
      { id: 1, name: 'a' },
      { id: 2, name: 'b' },
      { id: 3, name: 'c' },
    ])
    expect(result.payload.truncated).toBe(false)
  })

  test('query 收到写语句时给出方向性拒绝', async () => {
    const result = await callTool(readOnlyKey, 'query', {
      datasource: READONLY_DS,
      sql: `insert into mcp_probe (name) values ('nope')`,
    })
    expect(result.isError).toBe(true)
    expect(result.payload).toMatchObject({ code: 'WRITE_STATEMENT_IN_READ_TOOL' })
  })

  test('execute 在有写授权时提交，且改动能被另一个连接看到', async () => {
    const result = await callTool(readWriteKey, 'execute', {
      datasource: READONLY_DS,
      sql: `insert into mcp_probe (name) values ('written')`,
    })
    expect(result.isError).toBe(false)
    expect(result.payload.rowCount).toBe(1)

    const check = await probe.query(`select count(*)::int as count from mcp_probe where name = 'written'`)
    expect(check.rows[0].count).toBe(1)
  })

  test('execute 跑 DDL 被拒，且表还在', async () => {
    const result = await callTool(readWriteKey, 'execute', {
      datasource: READONLY_DS,
      sql: 'drop table mcp_probe',
    })
    expect(result.isError).toBe(true)
    expect(result.payload).toMatchObject({ code: 'DDL_FORBIDDEN' })

    const still = await probe.query(`select count(*)::int as count from mcp_probe`)
    expect(still.rows[0].count).toBeGreaterThan(0)
  })

  test('无权访问与不存在的数据源，响应逐字节相同', async () => {
    const forbidden = await callTool(readOnlyKey, 'query', {
      datasource: 'itest-mcp-unheard-of',
      sql: 'select 1',
    })
    const nonexistent = await callTool(readOnlyKey, 'query', {
      datasource: 'itest-mcp-does-not-exist',
      sql: 'select 1',
    })
    expect(forbidden.payload).toEqual(nonexistent.payload)
    expect(forbidden.payload).toMatchObject({ code: 'DATASOURCE_NOT_FOUND_OR_UNAUTHORIZED' })
  })

  test('过期 / 吊销 / IP 不符的密钥在 Bearer 层就被拒，码各自正确', async () => {
    const expired = await createKey('itest-mcp-expired', [], {
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    })
    const revoked = await createKey('itest-mcp-revoked', [])
    const ipBound = await createKey('itest-mcp-ip', [{ datasourceId, canRead: true, canWrite: false }], {
      ipAllowlist: ['10.0.0.0/8'],
    })

    const revokedId = (await apiKeyIdOf('itest-mcp-revoked')) as number
    await app.inject({ method: 'DELETE', url: `/api/v1/api-keys/${revokedId}`, headers: { cookie } })

    for (const [key, code] of [
      [expired, 'API_KEY_EXPIRED'],
      [revoked, 'API_KEY_REVOKED'],
      [ipBound, 'IP_NOT_ALLOWED'],
    ] as const) {
      const res = await rawPost(initializeBody, { authorization: `Bearer ${key}` })
      expect(res.status, code).toBe(code === 'IP_NOT_ALLOWED' ? 403 : 401)
      expect((await res.json()) as { code: string }).toMatchObject({ code })
    }
  })

  test('授权改动对已建立的会话即刻生效：无需重连', async () => {
    const key = await createKey('itest-mcp-live-grants', [{ datasourceId, canRead: true, canWrite: false }])
    const client = new Client({ name: 'itest', version: '1' })
    const transport = new StreamableHTTPClientTransport(mcpUrl, {
      requestInit: { headers: { authorization: `Bearer ${key}` } },
    })
    await client.connect(transport)
    try {
      const before = (await client.listTools()).tools.map((tool) => tool.name)
      expect(before).not.toContain('execute')

      // 管理面把授权改成读写。
      const id = (await apiKeyIdOf('itest-mcp-live-grants')) as number
      const updated = await app.inject({
        method: 'PUT',
        url: `/api/v1/api-keys/${id}/grants`,
        headers: { cookie },
        payload: { grants: [{ datasourceId, canRead: true, canWrite: true }] },
      })
      expect(updated.statusCode).toBe(200)

      // 同一个会话、不重连。
      const after = (await client.listTools()).tools.map((tool) => tool.name)
      expect(after).toContain('execute')
    } finally {
      await client.close()
    }
  })

  test('每一次调用（含拒绝）都留下了审计，字段齐全', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/audit-logs?pageSize=100',
      headers: { cookie },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { items: Array<Record<string, unknown>>; total: number }
    const actions = new Set(body.items.map((item) => item.action))
    expect(actions).toContain('mcp.query')
    expect(actions).toContain('mcp.execute')
    expect(actions).toContain('mcp.list_datasources')

    const insert = body.items.find((item) => item.sqlText === `insert into mcp_probe (name) values ('written')`)
    expect(insert).toMatchObject({
      decision: 'granted',
      classification: 'write',
      rowCount: 1,
      engine: 'postgres',
      datasourceName: READONLY_DS,
      toolName: 'execute',
    })
    expect(typeof insert?.durationMs).toBe('number')
    expect(insert?.apiKeyPrefix).toMatch(/^dblab_[a-z0-9]{8}$/)
    expect(typeof insert?.clientIp).toBe('string')

    const ddl = body.items.find((item) => item.sqlText === 'drop table mcp_probe')
    expect(ddl).toMatchObject({
      decision: 'denied',
      classification: 'denied',
      denialReason: 'ddl_forbidden',
    })

    const denied = body.items.find(
      (item) => item.denialReason === 'datasource_not_found_or_unauthorized',
    )
    expect(denied).toBeTruthy()
  })

  async function apiKeyIdOf(name: string): Promise<number | undefined> {
    const list = await app.inject({ method: 'GET', url: '/api/v1/api-keys', headers: { cookie } })
    const items = (list.json() as { items: Array<{ id: number; name: string }> }).items
    return items.find((item) => item.name === name)?.id
  }
})
