import { randomBytes } from 'node:crypto'

import { createPlatformDb, ensureAdmin, resetMasterKeyCache, type PlatformDb } from '@dblab/db'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { buildApp } from '../src/app'
import { parseEnv } from '../src/config/env'

/**
 * 需要真实 PostgreSQL 的用例。探测目标就用测试库自己，
 * 所以这里同时验证了「连得上」与「存进去的密文能解回来」两件事。
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL
const describeDb = TEST_DATABASE_URL ? describe : describe.skip

const PG = { host: 'localhost', port: 5432, database: 'dblab_test', username: 'postgres', password: 'postgres' }
const PASSWORD = 'admin123'
/** 明文口令里刻意塞进 @ : / # ? % —— 拼连接串的写法会在这些字符上翻车。 */
const NASTY_PASSWORD = 'p@ss:w/rd#1?2%3'
/** 审计表只追加，重跑会留下同名历史行，所以要按次计数的用例名每跑一次换一个。 */
const RUN = randomBytes(3).toString('hex')

const savedMasterKey = process.env.CREDENTIAL_MASTER_KEY

describeDb('数据源管理', () => {
  let app: FastifyInstance
  let db: PlatformDb
  let pool: ReturnType<typeof createPlatformDb>['pool']
  let cookie = ''

  beforeAll(async () => {
    // 固定一把临时主密钥，用例自成闭环，也不往仓库里落密钥文件。
    process.env.CREDENTIAL_MASTER_KEY = randomBytes(32).toString('base64')
    resetMasterKeyCache()

    const created = createPlatformDb(TEST_DATABASE_URL as string)
    db = created.db
    pool = created.pool
    await ensureAdmin(db, 'admin', PASSWORD)

    const { env } = parseEnv({ DATABASE_URL: TEST_DATABASE_URL, ADMIN_PASSWORD: PASSWORD })
    app = await buildApp({ env, db, pool })

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'admin', password: PASSWORD },
    })
    cookie = String(login.headers['set-cookie']).split(';')[0] as string
  })

  afterAll(async () => {
    await app.close()
    await pool.query('delete from datasource')
    await pool.query('delete from session')
    await pool.query('delete from admin_user where username = $1', ['admin'])
    await pool.end()

    if (savedMasterKey === undefined) delete process.env.CREDENTIAL_MASTER_KEY
    else process.env.CREDENTIAL_MASTER_KEY = savedMasterKey
    resetMasterKeyCache()
  })

  function create(payload: Record<string, unknown>) {
    return app.inject({ method: 'POST', url: '/api/v1/datasources', headers: { cookie }, payload })
  }

  test('没有会话时数据源接口一律 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/datasources' })
    expect(res.statusCode).toBe(401)
  })

  test('创建数据源：201，响应里不含口令字段', async () => {
    const res = await create({ name: 'itest-pg', engine: 'postgres', ...PG, connectOptions: {} })
    expect(res.statusCode).toBe(201)

    const body = res.json() as Record<string, unknown>
    // 用键集合断言，不靠肉眼：任何时刻都不能多出一个回显口令的字段。
    expect(Object.keys(body).sort()).toEqual(
      [
        'connectOptions',
        'createdAt',
        'database',
        'enabled',
        'engine',
        'grantedKeyCount',
        'host',
        'id',
        'lastTestAt',
        'lastTestError',
        'lastTestOk',
        'name',
        'passwordConfigured',
        'port',
        'updatedAt',
        'username',
      ].sort(),
    )
    expect(body).toMatchObject({
      name: 'itest-pg',
      engine: 'postgres',
      passwordConfigured: true,
      enabled: true,
      grantedKeyCount: 0,
      lastTestOk: null,
    })
  })

  test('库里只有密文，全行任何一列都不含明文口令', async () => {
    await create({ name: 'itest-cipher', engine: 'postgres', ...PG, password: NASTY_PASSWORD })

    const res = await pool.query(`select * from datasource where name = $1`, ['itest-cipher'])
    expect(res.rowCount).toBe(1)
    const row = res.rows[0] as Record<string, unknown>

    expect(String(row.password_ciphertext).startsWith('v1:')).toBe(true)
    for (const [column, value] of Object.entries(row)) {
      expect(String(value), `列 ${column} 不应包含明文口令`).not.toContain(NASTY_PASSWORD)
    }
  })

  test('带 @ : / # ? % 的口令能测通（说明没有拼连接串）', async () => {
    const created = await create({
      name: 'itest-nasty',
      engine: 'postgres',
      host: PG.host,
      port: PG.port,
      database: PG.database,
      username: PG.username,
      password: NASTY_PASSWORD,
    })
    // 口令本身是错的（库里没这个账号的口令），但必须走到「认证失败」这一步，
    // 而不是因为连接串被拼坏而报解析错误。
    const id = (created.json() as { id: number }).id
    const test = await app.inject({
      method: 'POST',
      url: `/api/v1/datasources/${id}/test`,
      headers: { cookie },
    })
    const result = test.json() as { ok: boolean; errorCode: string | null; message: string | null }
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('DATASOURCE_AUTH_FAILED')
    expect(result.message ?? '').not.toContain(NASTY_PASSWORD)
    // 认证阶段的 FATAL 由 PG 用服务器端编码（GBK）发出，到 Node 侧已经解坏；
    // 这种情况必须回落到自己的中文文案，不能把乱码写进界面与审计。
    expect(result.message ?? '').not.toContain('\ufffd')
    expect(result.message).toBe('数据源账号或口令不正确')
  })

  test('测试连接：成功时记录版本并落 lastTest*', async () => {
    const id = await idOf('itest-pg')
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/datasources/${id}/test`,
      headers: { cookie },
    })
    expect(res.statusCode).toBe(200)
    const result = res.json() as { ok: boolean; serverVersion: string | null; latencyMs: number }
    expect(result.ok).toBe(true)
    expect(result.serverVersion).toContain('PostgreSQL')

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/datasources/${id}`,
      headers: { cookie },
    })
    expect(detail.json()).toMatchObject({ lastTestOk: true, lastTestError: null })
  })

  test('测试连接：连不上时给出码与文案，且文案里没有口令', async () => {
    const created = await create({
      name: 'itest-dead',
      engine: 'postgres',
      host: '127.0.0.1',
      port: 65001,
      database: 'nope',
      username: 'postgres',
      password: 'secret-should-not-leak',
    })
    const id = (created.json() as { id: number }).id

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/datasources/${id}/test`,
      headers: { cookie },
    })
    const result = res.json() as { ok: boolean; errorCode: string | null; message: string | null }
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('DATASOURCE_UNREACHABLE')
    expect(result.message ?? '').not.toContain('secret-should-not-leak')

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/datasources/${id}`,
      headers: { cookie },
    })
    expect(detail.json()).toMatchObject({ lastTestOk: false })
    expect(String((detail.json() as { lastTestError: string }).lastTestError)).not.toContain(
      'secret-should-not-leak',
    )
  })

  /** 「先测再存」：探测一份还没落库的配置，对应新建表单里的「测试连接」。 */
  function probe(payload: Record<string, unknown>, auth = true) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/datasources/test',
      headers: auth ? { cookie } : {},
      payload,
    })
  }

  test('探测未保存的配置：能测通，但不会因此多出一行数据源', async () => {
    const res = await probe({ name: `itest-probe-ok-${RUN}`, engine: 'postgres', ...PG })
    expect(res.statusCode).toBe(200)
    const result = res.json() as { ok: boolean; serverVersion: string | null }
    expect(result.ok).toBe(true)
    expect(result.serverVersion).toContain('PostgreSQL')

    const rows = await pool.query('select 1 from datasource where name = $1', [`itest-probe-ok-${RUN}`])
    expect(rows.rowCount).toBe(0)
  })

  test('探测失败：口令不回显，审计里也只有目标地址', async () => {
    const name = `itest-probe-bad-${RUN}`
    const res = await probe({
      name,
      engine: 'postgres',
      host: PG.host,
      port: PG.port,
      database: PG.database,
      username: PG.username,
      password: NASTY_PASSWORD,
    })
    const result = res.json() as { ok: boolean; errorCode: string | null; message: string | null }
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('DATASOURCE_AUTH_FAILED')
    expect(result.message ?? '').not.toContain(NASTY_PASSWORD)

    // 这条审计对应的数据源可能永远不会被创建，所以要留下目标地址；但口令不能留。
    const logged = await pool.query(
      `select decision, error_code as code, detail::text as detail
         from audit_log
        where action = 'datasource.test' and datasource_name = $1`,
      [name],
    )
    expect(logged.rowCount).toBe(1)
    const row = logged.rows[0] as { decision: string; code: string; detail: string }
    expect(row.decision).toBe('granted')
    expect(row.code).toBe('DATASOURCE_AUTH_FAILED')
    expect(row.detail).toContain('viaForm')
    expect(`${row.code}${row.detail}`).not.toContain(NASTY_PASSWORD)
  })

  test('编辑弹窗里的探测：口令留空则沿用该行已存的那份，且不写 last_test_*', async () => {
    const name = `itest-probe-stored-${RUN}`
    const created = await create({ name, engine: 'postgres', ...PG })
    const id = (created.json() as { id: number }).id

    const res = await probe({
      name,
      engine: 'postgres',
      host: PG.host,
      port: PG.port,
      database: PG.database,
      username: PG.username,
      datasourceId: id,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ok: true })

    // 试连不代表这份配置已经生效：last_test_* 只由「已存数据源的测试连接」写。
    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/datasources/${id}`,
      headers: { cookie },
    })
    expect(detail.json()).toMatchObject({ lastTestAt: null, lastTestOk: null })

    // 指向不存在的行时不能退化成「拿空口令去连」。
    const orphan = await probe({
      name,
      engine: 'postgres',
      host: PG.host,
      port: PG.port,
      database: PG.database,
      username: PG.username,
      datasourceId: 999_999,
    })
    expect(orphan.json()).toMatchObject({ code: 'DATASOURCE_NOT_FOUND' })
  })

  test('探测必须带会话，且口令是必填项', async () => {
    expect((await probe({ name: 'x', engine: 'postgres', ...PG }, false)).statusCode).toBe(401)

    const res = await probe({
      name: `itest-probe-nopw-${RUN}`,
      engine: 'postgres',
      host: PG.host,
      port: PG.port,
      database: PG.database,
      username: PG.username,
    })
    expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED' })
  })

  test('改名冲突：409', async () => {
    const res = await create({ name: 'itest-pg', engine: 'postgres', ...PG })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'DATASOURCE_NAME_TAKEN' })
  })

  test('更新不带口令：密文逐字节不变', async () => {
    const id = await idOf('itest-cipher')
    const before = await cipherOf(id)

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/datasources/${id}`,
      headers: { cookie },
      payload: { host: '127.0.0.1', port: 5432 },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ host: '127.0.0.1' })
    expect(String((res.json() as { lastTestError: unknown }).lastTestError ?? '')).toBe('')

    expect(await cipherOf(id)).toBe(before)
  })

  test('更新带口令：密文变化，且新口令能解回来', async () => {
    const id = await idOf('itest-cipher')
    const before = await cipherOf(id)

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/datasources/${id}`,
      headers: { cookie },
      payload: { password: 'rotated-password' },
    })
    expect(res.statusCode).toBe(200)

    const after = await cipherOf(id)
    expect(after).not.toBe(before)

    const { decryptSecret } = await import('@dblab/db')
    expect(decryptSecret(after)).toBe('rotated-password')
  })

  test('停用状态可改，列表能读到', async () => {
    const id = await idOf('itest-pg')
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/datasources/${id}`,
      headers: { cookie },
      payload: { enabled: false },
    })

    const list = await app.inject({ method: 'GET', url: '/api/v1/datasources', headers: { cookie } })
    const items = (list.json() as { items: Array<{ id: number; enabled: boolean }> }).items
    expect(
      items.find((item) => item.id === id),
      `列表里没有 id=${id}：${JSON.stringify(items)}`,
    ).toMatchObject({ enabled: false })
  })

  test('不存在的 id：404；非法 id：400', async () => {
    const missing = await app.inject({
      method: 'GET',
      url: '/api/v1/datasources/999999',
      headers: { cookie },
    })
    expect(missing.statusCode).toBe(404)
    expect(missing.json()).toMatchObject({ code: 'DATASOURCE_NOT_FOUND' })

    const bad = await app.inject({
      method: 'GET',
      url: '/api/v1/datasources/abc',
      headers: { cookie },
    })
    expect(bad.statusCode).toBe(400)
    expect(bad.json()).toMatchObject({ code: 'VALIDATION_FAILED' })
  })

  test('删除后列表里不再有它', async () => {
    const id = await idOf('itest-dead')
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/datasources/${id}`,
      headers: { cookie },
    })
    expect(res.statusCode).toBe(204)

    const list = await app.inject({ method: 'GET', url: '/api/v1/datasources', headers: { cookie } })
    const items = (list.json() as { items: Array<{ id: number }> }).items
    expect(items.some((item) => item.id === id)).toBe(false)
  })

  test('四种管理动作都留了审计，且带数据源名与引擎', async () => {
    const rows = await pool.query<{ action: string; datasource_name: string; engine: string }>(
      `select action, datasource_name, engine from audit_log
        where action like 'datasource.%' order by id`,
    )
    const actions = rows.rows.map((r) => r.action)
    for (const action of ['datasource.create', 'datasource.update', 'datasource.test', 'datasource.delete']) {
      expect(actions).toContain(action)
    }
    expect(rows.rows.every((r) => r.datasource_name !== null && r.engine !== null)).toBe(true)
  })

  async function idOf(name: string): Promise<number> {
    const res = await pool.query<{ id: string }>('select id from datasource where name = $1', [name])
    const raw = res.rows[0]?.id
    if (raw === undefined) throw new Error(`测试前置条件失败：数据源 ${name} 不存在`)
    // bigint 列在驱动层回的是字符串，必须转成数字，否则与 JSON 里的数字比较永远不等。
    return Number(raw)
  }

  async function cipherOf(id: number): Promise<string> {
    const res = await pool.query<{ password_ciphertext: string }>(
      'select password_ciphertext from datasource where id = $1',
      [id],
    )
    return res.rows[0]?.password_ciphertext as string
  }
})
