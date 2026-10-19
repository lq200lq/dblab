import { randomBytes } from 'node:crypto'

import {
  createPlatformDb,
  ensureAdmin,
  generateApiKey,
  resetMasterKeyCache,
  type PlatformDb,
} from '@dblab/db'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { ApiKeyService } from '../src/api-key/service'
import { extractBearerToken, resolveApiKeyContext } from '../src/api-key/verify'
import { buildApp } from '../src/app'
import { parseEnv } from '../src/config/env'

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL
const describeDb = TEST_DATABASE_URL ? describe : describe.skip

const PASSWORD = 'admin123'
const PLAINTEXT_PATTERN = /^dblab_[a-z0-9]{8}_[A-Za-z0-9_-]{43}$/
const savedMasterKey = process.env.CREDENTIAL_MASTER_KEY

describeDb('API 密钥与授权', () => {
  let app: FastifyInstance
  let db: PlatformDb
  let pool: ReturnType<typeof createPlatformDb>['pool']
  let service: ApiKeyService
  let cookie = ''
  let datasourceId = 0
  let secondDatasourceId = 0

  beforeAll(async () => {
    process.env.CREDENTIAL_MASTER_KEY = randomBytes(32).toString('base64')
    resetMasterKeyCache()

    const created = createPlatformDb(TEST_DATABASE_URL as string)
    db = created.db
    pool = created.pool
    service = new ApiKeyService(db)
    await ensureAdmin(db, 'admin', PASSWORD)

    const { env } = parseEnv({ DATABASE_URL: TEST_DATABASE_URL, ADMIN_PASSWORD: PASSWORD })
    app = await buildApp({ env, db, pool })

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'admin', password: PASSWORD },
    })
    cookie = String(login.headers['set-cookie']).split(';')[0] as string

    datasourceId = await createDatasource('itest-key-ds-1')
    secondDatasourceId = await createDatasource('itest-key-ds-2')
  })

  afterAll(async () => {
    await app.close()
    await pool.query('delete from api_key')
    await pool.query('delete from datasource')
    await pool.query('delete from session')
    await pool.query('delete from admin_user where username = $1', ['admin'])
    await pool.end()

    if (savedMasterKey === undefined) delete process.env.CREDENTIAL_MASTER_KEY
    else process.env.CREDENTIAL_MASTER_KEY = savedMasterKey
    resetMasterKeyCache()
  })

  async function createDatasource(name: string): Promise<number> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/datasources',
      headers: { cookie },
      payload: {
        name,
        engine: 'postgres',
        host: 'localhost',
        port: 5432,
        database: 'dblab_test',
        username: 'postgres',
        password: 'postgres',
      },
    })
    return (res.json() as { id: number }).id
  }

  function createKey(payload: Record<string, unknown>) {
    return app.inject({ method: 'POST', url: '/api/v1/api-keys', headers: { cookie }, payload })
  }

  test('创建密钥：明文只回一次，形态符合契约', async () => {
    const res = await createKey({ name: 'itest-key-1' })
    expect(res.statusCode).toBe(201)

    const body = res.json() as { plaintextKey: string; prefix: string; status: string; grants: unknown[] }
    expect(body.plaintextKey).toMatch(PLAINTEXT_PATTERN)
    expect(body.prefix).toBe(`dblab_${body.plaintextKey.split('_')[1]}`)
    expect(body.status).toBe('active')
    expect(body.grants).toEqual([])
  })

  test('库里只有摘要与定位段，明文不出现在任何一列', async () => {
    const created = await createKey({ name: 'itest-key-cipher' })
    const plaintext = (created.json() as { plaintextKey: string }).plaintextKey

    const res = await pool.query(`select * from api_key where name = $1`, ['itest-key-cipher'])
    const row = res.rows[0] as Record<string, unknown>

    expect(String(row.key_hash)).toMatch(/^[0-9a-f]{64}$/)
    expect(String(row.prefix)).toMatch(/^dblab_[a-z0-9]{8}$/)
    for (const [column, value] of Object.entries(row)) {
      expect(String(value), `列 ${column} 不应含明文密钥`).not.toContain(plaintext)
    }
  })

  test('列表只回前缀，详情不回明文', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/v1/api-keys', headers: { cookie } })
    const items = (list.json() as { items: Array<Record<string, unknown>> }).items
    expect(items.length).toBeGreaterThan(0)
    for (const item of items) {
      expect(item).not.toHaveProperty('plaintextKey')
      expect(item).not.toHaveProperty('keyHash')
      expect(String(item.prefix)).toMatch(/^dblab_[a-z0-9]{8}$/)
    }

    const id = items[0]?.id as number
    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/api-keys/${id}`,
      headers: { cookie },
    })
    expect(detail.statusCode).toBe(200)
    expect(detail.json()).not.toHaveProperty('plaintextKey')
  })

  test('创建时可直接带上授权，数据源名一起回', async () => {
    const res = await createKey({
      name: 'itest-key-grants',
      grants: [
        { datasourceId, canRead: true, canWrite: false },
        { datasourceId: secondDatasourceId, canRead: true, canWrite: true },
      ],
    })
    expect(res.statusCode).toBe(201)

    const body = res.json() as { datasourceCount: number; grants: Array<{ datasourceName: string; canWrite: boolean }> }
    expect(body.datasourceCount).toBe(2)
    expect(body.grants.map((g) => g.datasourceName).sort()).toEqual([
      'itest-key-ds-1',
      'itest-key-ds-2',
    ])
    expect(body.grants.filter((g) => g.canWrite)).toHaveLength(1)
  })

  test('授权整表替换：先删后插，能加也能撤', async () => {
    const created = await createKey({
      name: 'itest-key-replace',
      grants: [{ datasourceId, canRead: true, canWrite: false }],
    })
    const id = (created.json() as { id: number }).id

    const replaced = await app.inject({
      method: 'PUT',
      url: `/api/v1/api-keys/${id}/grants`,
      headers: { cookie },
      payload: { grants: [{ datasourceId: secondDatasourceId, canRead: false, canWrite: true }] },
    })
    expect(replaced.statusCode).toBe(200)
    const detail = replaced.json() as { grants: Array<{ datasourceId: number; canWrite: boolean }> }
    expect(detail.grants).toEqual([
      expect.objectContaining({ datasourceId: secondDatasourceId, canRead: false, canWrite: true }),
    ])

    const cleared = await app.inject({
      method: 'PUT',
      url: `/api/v1/api-keys/${id}/grants`,
      headers: { cookie },
      payload: { grants: [] },
    })
    expect((cleared.json() as { grants: unknown[] }).grants).toEqual([])

    const count = await pool.query<{ count: string }>(
      'select count(*)::text as count from api_key_grant where api_key_id = $1',
      [id],
    )
    expect(Number(count.rows[0]?.count)).toBe(0)
  })

  test('读与写都关掉的授权被契约层挡下', async () => {
    const res = await createKey({
      name: 'itest-key-bad-grant',
      grants: [{ datasourceId, canRead: false, canWrite: false }],
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED' })
  })

  test('同一个数据源重复授权被挡下', async () => {
    const res = await createKey({
      name: 'itest-key-dup-grant',
      grants: [
        { datasourceId, canRead: true, canWrite: false },
        { datasourceId, canRead: false, canWrite: true },
      ],
    })
    expect(res.statusCode).toBe(400)
    expect((res.json() as { message: string }).message).toContain('重复')
  })

  test('授权给不存在的数据源：404', async () => {
    const res = await createKey({
      name: 'itest-key-missing-ds',
      grants: [{ datasourceId: 999999, canRead: true, canWrite: false }],
    })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ code: 'DATASOURCE_NOT_FOUND' })
  })

  test('非法 IP 白名单与非法时间被挡下', async () => {
    const badIp = await createKey({ name: 'itest-key-bad-ip', ipAllowlist: ['999.1.1.1/8'] })
    expect(badIp.statusCode).toBe(400)
    expect((badIp.json() as { message: string }).message).toContain('格式不正确')

    const badTime = await createKey({ name: 'itest-key-bad-time', expiresAt: '不是时间' })
    expect(badTime.statusCode).toBe(400)
    expect((badTime.json() as { message: string }).message).toContain('时间格式不正确')
  })

  test('停用与吊销', async () => {
    const created = await createKey({ name: 'itest-key-lifecycle' })
    const id = (created.json() as { id: number }).id

    const disabled = await app.inject({
      method: 'PATCH',
      url: `/api/v1/api-keys/${id}`,
      headers: { cookie },
      payload: { status: 'disabled' },
    })
    expect((disabled.json() as { status: string }).status).toBe('disabled')

    const revoked = await app.inject({
      method: 'DELETE',
      url: `/api/v1/api-keys/${id}`,
      headers: { cookie },
    })
    expect(revoked.statusCode).toBe(204)

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/api-keys/${id}`,
      headers: { cookie },
    })
    expect((detail.json() as { status: string }).status).toBe('revoked')
  })

  test('审计里没有明文密钥与摘要', async () => {
    const created = await createKey({ name: 'itest-key-audit' })
    const plaintext = (created.json() as { plaintextKey: string }).plaintextKey
    const secret = plaintext.split('_')[2] as string

    const rows = await pool.query<{ detail: unknown }>(
      `select detail from audit_log where action like 'api_key.%'`,
    )
    const serialized = JSON.stringify(rows.rows)
    expect(serialized).not.toContain(plaintext)
    expect(serialized).not.toContain(secret)

    const actions = await pool.query<{ action: string }>(
      `select distinct action from audit_log where action like 'api_key.%'`,
    )
    expect(actions.rows.map((r) => r.action).sort()).toEqual([
      'api_key.create',
      'api_key.grants',
      'api_key.revoke',
      'api_key.update',
    ])
  })

  describe('Bearer 校验（MCP 入口用的这一段）', () => {
    test('Bearer 头解析', () => {
      expect(extractBearerToken('Bearer dblab_ab12cd34_' + 'x'.repeat(43))).toBe(
        'dblab_ab12cd34_' + 'x'.repeat(43),
      )
      expect(extractBearerToken('bearer abc')).toBe('abc')
      expect(extractBearerToken('  Bearer   abc  ')).toBe('abc')
      expect(extractBearerToken('Basic abc')).toBeNull()
      expect(extractBearerToken('Bearer')).toBeNull()
      expect(extractBearerToken(undefined)).toBeNull()
      expect(extractBearerToken('')).toBeNull()
    })

    test('有效密钥可用', async () => {
      const created = await createKey({ name: 'itest-verify-ok' })
      const plaintext = (created.json() as { plaintextKey: string }).plaintextKey

      const result = await resolveApiKeyContext(db, plaintext, '127.0.0.1')
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.key.name).toBe('itest-verify-ok')
    })

    test('秘密段改一位即无效', async () => {
      const created = await createKey({ name: 'itest-verify-tamper' })
      const plaintext = (created.json() as { plaintextKey: string }).plaintextKey
      const tampered = plaintext.slice(0, -1) + (plaintext.endsWith('a') ? 'b' : 'a')

      const result = await resolveApiKeyContext(db, tampered, '127.0.0.1')
      expect(result).toEqual({ ok: false, code: 'API_KEY_INVALID' })
    })

    test('不存在的定位段与畸形明文都返回 INVALID', async () => {
      const unknown = generateApiKey().plaintextKey
      expect(await resolveApiKeyContext(db, unknown, '127.0.0.1')).toEqual({
        ok: false,
        code: 'API_KEY_INVALID',
      })
      expect(await resolveApiKeyContext(db, 'dblab_zzzzzzzz_short', '127.0.0.1')).toEqual({
        ok: false,
        code: 'API_KEY_INVALID',
      })
      expect(await resolveApiKeyContext(db, null, '127.0.0.1')).toEqual({
        ok: false,
        code: 'API_KEY_INVALID',
      })
    })

    test('停用 / 吊销 / 过期分别给出各自的码', async () => {
      const disabled = await createKey({ name: 'itest-verify-disabled' })
      const disabledId = (disabled.json() as { id: number }).id
      await service.update(disabledId, { status: 'disabled' })
      expect(
        await resolveApiKeyContext(db, (disabled.json() as { plaintextKey: string }).plaintextKey, '127.0.0.1'),
      ).toEqual({ ok: false, code: 'API_KEY_DISABLED' })

      const revoked = await createKey({ name: 'itest-verify-revoked' })
      const revokedId = (revoked.json() as { id: number }).id
      await service.revoke(revokedId)
      expect(
        await resolveApiKeyContext(db, (revoked.json() as { plaintextKey: string }).plaintextKey, '127.0.0.1'),
      ).toEqual({ ok: false, code: 'API_KEY_REVOKED' })

      const expired = await createKey({
        name: 'itest-verify-expired',
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      })
      expect(
        await resolveApiKeyContext(db, (expired.json() as { plaintextKey: string }).plaintextKey, '127.0.0.1'),
      ).toEqual({ ok: false, code: 'API_KEY_EXPIRED' })
    })

    test('未过期的密钥正常放行', async () => {
      const created = await createKey({
        name: 'itest-verify-future',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      })
      const result = await resolveApiKeyContext(
        db,
        (created.json() as { plaintextKey: string }).plaintextKey,
        '127.0.0.1',
      )
      expect(result.ok).toBe(true)
    })

    test('IP 白名单：命中放行、不命中拒绝、空名单不限制', async () => {
      const limited = await createKey({
        name: 'itest-verify-ip',
        ipAllowlist: ['10.0.0.0/8'],
      })
      const plaintext = (limited.json() as { plaintextKey: string }).plaintextKey

      expect(await resolveApiKeyContext(db, plaintext, '10.1.2.3')).toMatchObject({ ok: true })
      expect(await resolveApiKeyContext(db, plaintext, '127.0.0.1')).toEqual({
        ok: false,
        code: 'IP_NOT_ALLOWED',
      })
      // 拿不到调用方 IP 时按不放行处理（fail-closed）。
      expect(await resolveApiKeyContext(db, plaintext, null)).toEqual({
        ok: false,
        code: 'IP_NOT_ALLOWED',
      })

      const open = await createKey({ name: 'itest-verify-ip-open' })
      expect(
        await resolveApiKeyContext(db, (open.json() as { plaintextKey: string }).plaintextKey, null),
      ).toMatchObject({ ok: true })
    })

    test('permissionMap 给出按数据源的读写判定', async () => {
      const created = await createKey({
        name: 'itest-verify-perm',
        grants: [
          { datasourceId, canRead: true, canWrite: false },
          { datasourceId: secondDatasourceId, canRead: false, canWrite: true },
        ],
      })
      const id = (created.json() as { id: number }).id

      const map = await service.permissionMap(id)
      expect(map.get(datasourceId)).toEqual({ canRead: true, canWrite: false })
      expect(map.get(secondDatasourceId)).toEqual({ canRead: false, canWrite: true })
      expect(map.get(999999)).toBeUndefined()
    })
  })
})
