import { describe, expect, test } from 'vitest'

import { parseEnv } from '../src/config/env'

const URL_OK = 'postgresql://postgres:postgres@localhost:5432/dblab'

describe('parseEnv', () => {
  test('缺少 DATABASE_URL 直接抛错', () => {
    expect(() => parseEnv({})).toThrow(/DATABASE_URL/)
  })

  test('空串按「没配」处理，取默认值而不是 0', () => {
    const { env } = parseEnv({ DATABASE_URL: URL_OK, PORT: '' })
    expect(env.port).toBe(4000)
  })

  test('开发环境未设 ADMIN_PASSWORD 时回退到 admin123 并给出告警', () => {
    const { env, warnings } = parseEnv({ DATABASE_URL: URL_OK, ADMIN_PASSWORD: '' })
    expect(env.adminPassword).toBe('admin123')
    expect(warnings.join(' ')).toContain('admin123')
    expect(env.isProduction).toBe(false)
    expect(env.cookieSecure).toBe(false)
  })

  test('生产环境缺 ADMIN_PASSWORD 或主密钥直接拒绝启动', () => {
    expect(() =>
      parseEnv({ NODE_ENV: 'production', DATABASE_URL: URL_OK, CREDENTIAL_MASTER_KEY: 'k' }),
    ).toThrow(/ADMIN_PASSWORD/)
    expect(() =>
      parseEnv({ NODE_ENV: 'production', DATABASE_URL: URL_OK, ADMIN_PASSWORD: 'strong-one' }),
    ).toThrow(/CREDENTIAL_MASTER_KEY/)
  })

  test('生产环境给齐后 cookie 走 Secure', () => {
    const { env, warnings } = parseEnv({
      NODE_ENV: 'production',
      DATABASE_URL: URL_OK,
      ADMIN_PASSWORD: 'strong-one',
      CREDENTIAL_MASTER_KEY: 'a'.repeat(44),
    })
    expect(env.cookieSecure).toBe(true)
    expect(env.isProduction).toBe(true)
    expect(warnings).toEqual([])
  })

  test('生产环境仍用默认口令时给告警但不拒绝启动', () => {
    const { warnings } = parseEnv({
      NODE_ENV: 'production',
      DATABASE_URL: URL_OK,
      ADMIN_PASSWORD: 'admin123',
      CREDENTIAL_MASTER_KEY: 'a'.repeat(44),
    })
    expect(warnings.join(' ')).toContain('admin123')
  })

  test('数值越界即抛错，问题一次性列全', () => {
    expect(() => parseEnv({ DATABASE_URL: URL_OK, PORT: '70000' })).toThrow(/PORT/)
    try {
      parseEnv({ DATABASE_URL: URL_OK, PORT: '70000', MCP_MAX_ROWS: '0' })
      throw new Error('不该走到这里')
    } catch (err) {
      const message = (err as Error).message
      expect(message).toContain('PORT')
      expect(message).toContain('MCP_MAX_ROWS')
    }
  })

  test('TRUST_PROXY 默认关闭，显式设 1 才打开', () => {
    expect(parseEnv({ DATABASE_URL: URL_OK }).env.trustProxy).toBe(false)
    expect(parseEnv({ DATABASE_URL: URL_OK, TRUST_PROXY: '1' }).env.trustProxy).toBe(true)
    expect(() => parseEnv({ DATABASE_URL: URL_OK, TRUST_PROXY: '2' })).toThrow(/TRUST_PROXY/)
  })

  test('默认值与 .env.example 对齐', () => {
    const { env } = parseEnv({ DATABASE_URL: URL_OK })
    expect(env.sessionCookieName).toBe('dblab_session')
    expect(env.sessionTtlMinutes).toBe(720)
    expect(env.mcpMaxSqlBytes).toBe(100_000)
    expect(env.mcpMaxRows).toBe(500)
    expect(env.mcpStatementTimeoutMs).toBe(15_000)
    expect(env.mcpSessionTtlMinutes).toBe(30)
    expect(env.poolMax).toBe(4)
    expect(env.poolIdleEvictMinutes).toBe(15)
    expect(env.adminUser).toBe('admin')
  })
})
