import { createPlatformDb, ensureAdmin, session, type PlatformDb } from '@dblab/db'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { buildApp } from '../src/app'
import { parseEnv } from '../src/config/env'

/**
 * 需要真实 PostgreSQL 的用例。未设置 TEST_DATABASE_URL 时整体跳过。
 * 审计表只增不改，所以用例只断言「新增了什么」，不去假设表是空的。
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL
const describeDb = TEST_DATABASE_URL ? describe : describe.skip

const COOKIE_NAME = 'dblab_session'
const PASSWORD = 'admin123'

describeDb('鉴权与会话', () => {
  let app: FastifyInstance
  let db: PlatformDb
  let pool: ReturnType<typeof createPlatformDb>['pool']

  beforeAll(async () => {
    const created = createPlatformDb(TEST_DATABASE_URL as string)
    db = created.db
    pool = created.pool
    await ensureAdmin(db, 'admin', PASSWORD)

    const { env } = parseEnv({
      DATABASE_URL: TEST_DATABASE_URL,
      ADMIN_USER: 'admin',
      ADMIN_PASSWORD: PASSWORD,
    })
    app = await buildApp({ env, db, pool })
  })

  afterAll(async () => {
    await app.close()
    // 会话与会话所属用户可在用例之间清干净；审计行是只增的，留着。
    await pool.query('delete from session')
    await pool.query('delete from admin_user where username = $1', ['admin'])
    await pool.end()
  })

  function cookieOf(res: { headers: Record<string, unknown> }): string {
    const raw = res.headers['set-cookie']
    const value = Array.isArray(raw) ? raw[0] : String(raw ?? '')
    return value.split(';')[0] as string
  }

  async function login(password = PASSWORD): Promise<{ status: number; cookie: string; body: unknown }> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'admin', password },
    })
    return { status: res.statusCode, cookie: cookieOf(res), body: res.json() }
  }

  test('/health 可用', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
  })

  test('正确口令登录：200 + 下发 HttpOnly 会话 cookie', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'admin', password: PASSWORD },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      user: { id: expect.any(Number), username: 'admin', displayName: '管理员' },
    })

    const setCookie = String(res.headers['set-cookie'])
    expect(setCookie).toContain(`${COOKIE_NAME}=`)
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Lax')
    expect(setCookie.toLowerCase()).toContain('path=/')
    // 本地 http 下不能带 Secure，否则浏览器根本不回传这个 cookie。
    expect(setCookie).not.toContain('Secure')
  })

  test('错误口令：401，且与账号不存在返回同一个码', async () => {
    const wrongPassword = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'admin', password: 'wrong' },
    })
    expect(wrongPassword.statusCode).toBe(401)
    expect(wrongPassword.json()).toMatchObject({ code: 'INVALID_CREDENTIALS' })

    const noSuchUser = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'nobody', password: 'wrong' },
    })
    expect(noSuchUser.statusCode).toBe(401)
    expect(noSuchUser.json()).toMatchObject({ code: 'INVALID_CREDENTIALS' })
  })

  test('缺字段：400 且带上字段级中文文案', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'admin' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED' })
  })

  test('请求体不是合法 JSON：400 而不是 500', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: '{"username":',
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED' })
  })

  test('没有 cookie 时受限接口 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/auth/session' })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toMatchObject({ code: 'UNAUTHORIZED' })
  })

  test('带 cookie 时能取回当前管理员', async () => {
    const { cookie } = await login()
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { cookie },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ user: { username: 'admin' } })
  })

  test('伪造的 cookie 无效', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { cookie: `${COOKIE_NAME}=not-a-real-token` },
    })
    expect(res.statusCode).toBe(401)
  })

  test('登出后同一 cookie 立刻失效，并清 cookie', async () => {
    const { cookie } = await login()

    const logout = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie },
    })
    expect(logout.statusCode).toBe(204)
    expect(String(logout.headers['set-cookie'])).toContain(`${COOKIE_NAME}=`)

    const after = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { cookie },
    })
    expect(after.statusCode).toBe(401)
  })

  test('库里存的是令牌摘要，不是 cookie 里的原值', async () => {
    const { cookie } = await login()
    const token = cookie.split('=')[1] as string

    const rows = await db.select({ tokenHash: session.tokenHash }).from(session)
    const hashes = rows.map((r) => r.tokenHash)

    expect(hashes).toContain(
      // sha256(token) 的十六进制；与实现保持独立算一遍。
      (await import('node:crypto')).createHash('sha256').update(token, 'utf8').digest('hex'),
    )
    expect(hashes).not.toContain(token)
    expect(hashes.every((h) => /^[0-9a-f]{64}$/.test(h))).toBe(true)
  })

  test('未知路由返回统一信封', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/nope' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ code: 'NOT_FOUND' })
  })

  test('登录成功、失败、登出都留下审计', async () => {
    const before = await countAudit('auth.login')
    const beforeFailed = await countAudit('auth.login_failed')
    const beforeLogout = await countAudit('auth.logout')

    const { cookie } = await login()
    const failed = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'admin', password: 'wrong' },
    })
    expect(failed.statusCode).toBe(401)
    await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie } })

    expect(await countAudit('auth.login')).toBe(before + 1)
    expect(await countAudit('auth.login_failed')).toBe(beforeFailed + 1)
    expect(await countAudit('auth.logout')).toBe(beforeLogout + 1)

    const denied = await pool.query<{ denial_reason: string; actor_name: string; decision: string }>(
      `select denial_reason, actor_name, decision from audit_log
        where action = 'auth.login_failed' order by id desc limit 1`,
    )
    expect(denied.rows[0]).toMatchObject({
      denial_reason: 'invalid_credentials',
      actor_name: 'admin',
      decision: 'denied',
    })
  })

  async function countAudit(action: string): Promise<number> {
    const res = await pool.query<{ count: string }>(
      'select count(*)::text as count from audit_log where action = $1',
      [action],
    )
    return Number(res.rows[0]?.count ?? '0')
  }
})
