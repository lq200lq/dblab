import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

import { main } from '../src/cli'
import type { Prompts } from '../src/core/prompts'

const KEY = `dblab_ab12cd34_${'A'.repeat(43)}`
const SERVER = 'http://localhost:18400'

const FULL_FLAGS = [
  'datasource',
  '--url',
  SERVER,
  '--key',
  KEY,
  '--name',
  'orders',
  '--engine',
  'postgres',
  '--host',
  'db.internal',
  '--database',
  'orders_db',
  '--username',
  'reader',
]

function collector(): { stream: NodeJS.WritableStream; text: () => string } {
  const chunks: string[] = []
  return {
    stream: { write: (chunk: string) => (chunks.push(chunk), true) } as unknown as NodeJS.WritableStream,
    text: () => chunks.join(''),
  }
}

interface Call {
  method: string
  path: string
  url: string
  body?: unknown
}

/** 一台假的管理面：登录、探测、建库、查密钥、改授权。 */
function fakePlatform(options: {
  probe?: { ok: boolean; latencyMs?: number; serverVersion?: string | null; message?: string | null }
  keys?: Array<{ id: number; name: string; prefix: string; status: string }>
  grants?: Array<{ datasourceId: number; datasourceName: string; canRead: boolean; canWrite: boolean }>
  createStatus?: number
}) {
  const calls: Call[] = []
  const created = { id: 42, name: 'orders', engine: 'postgres', host: 'db.internal', port: 5432, database: 'orders_db', username: 'reader', enabled: true }

  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname
    const method = init?.method ?? 'GET'
    const body = init?.body !== undefined ? (JSON.parse(init.body as string) as unknown) : undefined
    calls.push({ method, path, url, ...(body !== undefined ? { body } : {}) })

    if (path === '/api/v1/auth/login') {
      return new Response(JSON.stringify({ user: { id: 1, username: 'admin', displayName: null } }), {
        status: 200,
        headers: { 'set-cookie': 'dblab_session=tok; Path=/' },
      })
    }
    if (path === '/api/v1/datasources/test') {
      const probe = options.probe ?? { ok: true, latencyMs: 9, serverVersion: 'PostgreSQL 17.2' }
      return new Response(
        JSON.stringify({ latencyMs: 0, serverVersion: null, message: null, ...probe }),
        { status: 200 },
      )
    }
    if (path === '/api/v1/datasources' && method === 'POST') {
      return new Response(JSON.stringify(created), { status: options.createStatus ?? 200 })
    }
    if (path === '/api/v1/api-keys') {
      return new Response(JSON.stringify({ items: options.keys ?? [{ id: 5, name: 'qoder', prefix: 'dblab_ab12cd34', status: 'active' }] }), { status: 200 })
    }
    if (path === '/api/v1/api-keys/5') {
      return new Response(JSON.stringify({ grants: options.grants ?? [] }), { status: 200 })
    }
    if (path === '/api/v1/api-keys/5/grants' && method === 'PUT') {
      return new Response(JSON.stringify({ grants: [] }), { status: 200 })
    }
    return new Response(JSON.stringify({ code: 'NOT_FOUND', message: '资源不存在' }), { status: 404 })
  }) as unknown as typeof fetch

  return { impl, calls }
}

/** 假输入层：只在「期望走交互」的用例里注入，省略时命令应当完全不问。 */
const FAKE_PROMPTS: Prompts = {
  input: async () => 'never-used',
  password: async () => 'never-used',
  checkbox: async () => [],
  confirm: async () => true,
}

async function run(argv: string[], fetchImpl?: typeof fetch, prompts?: Prompts) {
  const stdout = collector()
  const stderr = collector()
  const code = await main(argv, {
    stdout: stdout.stream,
    stderr: stderr.stream,
    homeDir: '/tmp/unused',
    color: false,
    ...(fetchImpl ? { fetchImpl } : {}),
    ...(prompts ? { prompts } : {}),
  })
  return { code, out: `${stdout.text()}${stderr.text()}` }
}

beforeEach(() => {
  vi.stubEnv('DBLAB_ADMIN_PASSWORD', 'admin-pw')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('datasource 用法', () => {
  it('缺 --key 时报错并说明原因', async () => {
    const { code, out } = await run(['datasource', '--url', SERVER])
    expect(code).toBe(2)
    expect(out).toContain('缺少 --key')
  })

  it('缺管理员口令时报错', async () => {
    vi.stubEnv('DBLAB_ADMIN_PASSWORD', '')
    const { code, out } = await run([...FULL_FLAGS, '--password', 'db-pw'], undefined)
    expect(code).toBe(2)
    expect(out).toContain('管理员口令')
  })

  it('目标库口令一个来源都没有时报错', async () => {
    vi.stubEnv('DBLAB_DB_PASSWORD', '')
    const { code, out } = await run([...FULL_FLAGS])
    expect(code).toBe(2)
    expect(out).toContain('数据库口令')
    expect(out).toContain('DBLAB_DB_PASSWORD')
  })
})

describe('datasource 正常流程', () => {
  it('探测通过后建库并只读授权', async () => {
    const platform = fakePlatform({})
    const { code, out } = await run([...FULL_FLAGS, '--password', 'db-pw'], platform.impl)

    expect(code).toBe(0)
    expect(out).toContain('连通性正常')
    expect(out).toContain('已创建并授权')
    expect(out).toContain('只读')

    const paths = platform.calls.map((c) => `${c.method} ${c.path}`)
    expect(paths).toEqual([
      'POST /api/v1/auth/login',
      'GET /api/v1/api-keys',
      'POST /api/v1/datasources/test',
      'POST /api/v1/datasources',
      'GET /api/v1/api-keys/5',
      'PUT /api/v1/api-keys/5/grants',
    ])

    // 建库请求带上了引擎默认端口
    const create = platform.calls.find((c) => c.path === '/api/v1/datasources')
    expect((create?.body as Record<string, unknown>).port).toBe(5432)

    const put = platform.calls.find((c) => c.method === 'PUT')
    expect(put?.body).toEqual({ grants: [{ datasourceId: 42, canRead: true, canWrite: false }] })
  })

  it('--write 给读+写', async () => {
    const platform = fakePlatform({})
    const { code, out } = await run([...FULL_FLAGS, '--password', 'db-pw', '--write'], platform.impl)

    expect(code).toBe(0)
    expect(out).toContain('读+写')
    const put = platform.calls.find((c) => c.method === 'PUT')
    expect(put?.body).toEqual({ grants: [{ datasourceId: 42, canRead: true, canWrite: true }] })
  })

  it('原有授权不被覆盖掉', async () => {
    const platform = fakePlatform({
      grants: [{ datasourceId: 7, datasourceName: 'legacy', canRead: true, canWrite: true }],
    })
    const { code } = await run([...FULL_FLAGS, '--password', 'db-pw'], platform.impl)

    expect(code).toBe(0)
    const put = platform.calls.find((c) => c.method === 'PUT')
    expect((put?.body as { grants: unknown[] }).grants).toEqual([
      { datasourceId: 7, canRead: true, canWrite: true },
      { datasourceId: 42, canRead: true, canWrite: false },
    ])
  })

  it('DBLAB_DB_PASSWORD 可以替代 --password，避免口令进命令历史', async () => {
    vi.stubEnv('DBLAB_DB_PASSWORD', 'from-env')
    const platform = fakePlatform({})
    const { code, out } = await run(FULL_FLAGS, platform.impl)

    expect(code).toBe(0)
    expect(out).not.toContain('from-env')
    const create = platform.calls.find((c) => c.path === '/api/v1/datasources')
    expect((create?.body as Record<string, unknown>).password).toBe('from-env')
  })
})

describe('datasource 的保护路径', () => {
  it('探测失败就不建库、不改授权', async () => {
    const platform = fakePlatform({
      probe: { ok: false, message: '无法连接该数据源' },
    })
    const { code, out } = await run([...FULL_FLAGS, '--password', 'db-pw'], platform.impl)

    expect(code).toBe(3)
    expect(out).toContain('无法连接该数据源')
    expect(out).toContain('没有创建数据源')
    expect(platform.calls.map((c) => c.path)).not.toContain('/api/v1/datasources')
  })

  it('密钥不在这台服务上时中止，且不建库', async () => {
    const platform = fakePlatform({ keys: [{ id: 9, name: 'other', prefix: 'dblab_zzzzzzzz', status: 'active' }] })
    const { code, out } = await run([...FULL_FLAGS, '--password', 'db-pw'], platform.impl)

    expect(code).toBe(1)
    expect(out).toContain('没有找到前缀为 dblab_ab12cd34 的密钥')
    expect(platform.calls.map((c) => c.path)).not.toContain('/api/v1/datasources')
  })

  it('同名数据源已存在时透出冲突并给退出码 3', async () => {
    const base = fakePlatform({})
    const impl = vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname
      if (path === '/api/v1/datasources' && init?.method === 'POST') {
        return new Response(
          JSON.stringify({ code: 'DATASOURCE_NAME_TAKEN', message: '数据源名称已被占用' }),
          { status: 409 },
        )
      }
      return base.impl(url, init)
    }) as unknown as typeof fetch

    const { code, out } = await run([...FULL_FLAGS, '--password', 'db-pw'], impl)
    expect(code).toBe(3)
    expect(out).toContain('名称已被占用')
  })

  it('不支持的引擎直接拒', async () => {
    const { code, out } = await run(
      ['datasource', '--url', SERVER, '--key', KEY, '--name', 'x', '--engine', 'oracle', '--database', 'd', '--username', 'u', '--password', 'p'],
      fakePlatform({}).impl,
    )
    expect(code).toBe(2)
    expect(out).toContain('不支持的引擎')
  })
})

describe('交互补齐', () => {
  it('缺必要参数时按提问补全，端口用引擎默认值', async () => {
    const answers: Record<string, string> = {
      数据库类型: 'mysql',
      数据源名称: 'crm',
      数据库主机: 'crm.internal',
      库名: 'crm_db',
      数据库账号: 'svc_crm',
      '端口（MySQL）': '3307',
    }
    const asked: string[] = []
    const prompts: Prompts = {
      input: async (o) => {
        asked.push(o.message)
        const value = answers[o.message]
        if (value === undefined) throw new Error(`没有为「${o.message}」准备答案`)
        return value
      },
      password: async (o) => {
        asked.push(o.message)
        return 'pw-from-prompt'
      },
      checkbox: async () => [],
      confirm: async () => true,
    }

    const platform = fakePlatform({})
    // 只给 --key，其余全靠问
    const { code } = await run(['datasource', '--url', SERVER, '--key', KEY], platform.impl, prompts)

    expect(code).toBe(0)
    expect(asked).toContain('数据库类型')
    expect(asked).toContain('端口（MySQL）')
    const create = platform.calls.find((c) => c.path === '/api/v1/datasources')
    expect(create?.body).toEqual({
      name: 'crm',
      engine: 'mysql',
      host: 'crm.internal',
      port: 3307,
      database: 'crm_db',
      username: 'svc_crm',
      password: 'pw-from-prompt',
    })
  })

  it('交互问出来的口令不会被打进输出', async () => {
    const prompts: Prompts = {
      input: async (o) => {
        if (o.message === '数据库类型') return 'postgres'
        if (o.message === '数据源名称') return 'crm'
        if (o.message === '数据库主机') return 'localhost'
        if (o.message === '库名') return 'crm_db'
        if (o.message.startsWith('端口')) return '5432'
        if (o.message === '数据库账号') return 'svc'
        throw new Error(`unexpected ${o.message}`)
      },
      password: async () => 'super-secret-pw',
      checkbox: async () => [],
      confirm: async () => true,
    }
    const platform = fakePlatform({})
    const { code, out } = await run(['datasource', '--url', SERVER, '--key', KEY], platform.impl, prompts)

    expect(code).toBe(0)
    expect(out).not.toContain('super-secret-pw')
  })
})

describe('默认地址', () => {
  it('不传 --url 时打到 compose 的 18400', async () => {
    const withoutUrl = FULL_FLAGS.filter((flag) => flag !== SERVER && flag !== '--url')
    const platform = fakePlatform({})
    const { code } = await run([...withoutUrl, '--password', 'db-pw'], platform.impl)

    expect(code).toBe(0)
    expect(platform.calls[0]?.url).toBe('http://localhost:18400/api/v1/auth/login')
  })

  it('--url 覆盖默认值（源码直跑的 4000）', async () => {
    const withoutUrl = FULL_FLAGS.filter((flag) => flag !== SERVER && flag !== '--url')
    const platform = fakePlatform({})
    const { code } = await run(
      [...withoutUrl, '--url', 'http://localhost:4000', '--password', 'db-pw'],
      platform.impl,
    )

    expect(code).toBe(0)
    expect(platform.calls[0]?.url).toBe('http://localhost:4000/api/v1/auth/login')
  })
})
