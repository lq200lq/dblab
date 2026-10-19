import { randomBytes } from 'node:crypto'

import { encryptSecret, resetMasterKeyCache } from '@dblab/db'
import { Client } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { PostgresAdapter } from '../src/datasource/adapters/postgres'
import { DriverError } from '../src/datasource/adapters/types'
import type { DatasourceRow } from '../src/datasource/driver-config'
import { PoolRegistry } from '../src/datasource/pool-registry'
import { runGuardedSql } from '../src/sql/guard'

/**
 * 针对真实 PostgreSQL 的执行面验证。用专门的 scratch 库 dblab_probe，
 * 里面的 probe_items 由本文件自己建、自己重置，不依赖任何平台表。
 */
const TEST_PROBE_URL = process.env.TEST_PROBE_URL
const describeProbe = TEST_PROBE_URL ? describe : describe.skip

const savedMasterKey = process.env.CREDENTIAL_MASTER_KEY

function configFromUrl(url: string) {
  const parsed = new URL(url)
  return {
    engine: 'postgres' as const,
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 5432,
    database: parsed.pathname.replace(/^\//, ''),
    user: decodeURIComponent(parsed.username || 'postgres'),
    password: decodeURIComponent(parsed.password || ''),
    ssl: false,
    sslVerify: true,
  }
}

describeProbe('PostgreSQL 执行面', () => {
  let admin: Client
  let adapter: PostgresAdapter
  // 连接参数在 beforeAll 里才算：这段代码在「未设 URL、整组跳过」时也会被求值，
  // 放在收集期解析一个空串会直接让整个文件报 Invalid URL。
  let config: ReturnType<typeof configFromUrl>

  beforeAll(async () => {
    process.env.CREDENTIAL_MASTER_KEY = randomBytes(32).toString('base64')
    resetMasterKeyCache()

    config = configFromUrl(TEST_PROBE_URL as string)
    admin = new Client({ connectionString: TEST_PROBE_URL })
    await admin.connect()
    await admin.query(`
      create table if not exists probe_items (
        id serial primary key,
        name text not null,
        qty integer
      )
    `)
    adapter = new PostgresAdapter(config, 2)
  })

  afterAll(async () => {
    await adapter.close()
    await admin.end()
    resetMasterKeyCache()
    if (savedMasterKey === undefined) delete process.env.CREDENTIAL_MASTER_KEY
    else process.env.CREDENTIAL_MASTER_KEY = savedMasterKey
  })

  beforeEach(async () => {
    await admin.query('truncate probe_items restart identity')
    await admin.query(`insert into probe_items (name, qty) values ('a',1),('b',2),('c',3),('d',4),('e',5)`)
  })

  const readOptions = { maxRows: 500, statementTimeoutMs: 5_000 }
  const guardBase = {
    maxSqlBytes: 100_000,
    maxRows: 500,
    statementTimeoutMs: 5_000,
  }

  test('列出数据表能看到 probe_items', async () => {
    const tables = await adapter.listTables('public')
    const found = tables.find((table) => table.name === 'probe_items')
    expect(found).toMatchObject({ schema: 'public', kind: 'BASE TABLE' })
  })

  test('describeTable 给出列、可空性与主键', async () => {
    const described = await adapter.describeTable('probe_items', 'public')
    expect(described).not.toBeNull()
    expect(described?.columns.map((column) => column.name)).toEqual(['id', 'name', 'qty'])
    expect(described?.primaryKey).toEqual(['id'])
    expect(described?.columns.find((column) => column.name === 'name')).toMatchObject({
      nullable: false,
    })
    expect(described?.columns.find((column) => column.name === 'qty')).toMatchObject({
      nullable: true,
    })
  })

  test('describeTable 对不存在的表返回 null', async () => {
    expect(await adapter.describeTable('nope_not_here', 'public')).toBeNull()
  })

  test('只读执行返回行与列名', async () => {
    const result = await adapter.executeRead('select id, name, qty from probe_items order by id', readOptions)
    expect(result.columns).toEqual(['id', 'name', 'qty'])
    expect(result.rowCount).toBe(5)
    expect(result.truncated).toBe(false)
    expect(result.rows[0]).toMatchObject({ name: 'a', qty: 1 })
  })

  test('写入执行提交并返回影响行数', async () => {
    const result = await adapter.executeWrite(
      `insert into probe_items (name, qty) values ('written', 9)`,
      readOptions,
    )
    expect(result.rowCount).toBe(1)

    const check = await admin.query(`select count(*)::int as count from probe_items where name = 'written'`)
    expect(check.rows[0]?.count).toBe(1)
  })

  test('写入失败时报 QUERY_FAILED 且不留下半截事务', async () => {
    await expect(
      adapter.executeWrite('insert into probe_items (nope) values (1)', readOptions),
    ).rejects.toBeInstanceOf(DriverError)

    const after = await admin.query('select count(*)::int as count from probe_items')
    expect(after.rows[0]?.count).toBe(5)

    // 事务回滚后连接要能立刻继续用（说明没有把坏状态留在池里）。
    const next = await adapter.executeRead('select 1 as ok', readOptions)
    expect(next.rows[0]).toEqual({ ok: 1 })
  })

  test('行数上限生效且标记截断', async () => {
    const small = await adapter.executeRead('select * from probe_items order by id', {
      maxRows: 2,
      statementTimeoutMs: 5_000,
    })
    expect(small.rows).toHaveLength(2)
    expect(small.rowCount).toBe(2)
    expect(small.truncated).toBe(true)

    // 十万行也不整表搬回来：上限之外的行根本不会被读取。
    const huge = await adapter.executeRead('select g as n from generate_series(1, 100000) g', {
      maxRows: 10,
      statementTimeoutMs: 10_000,
    })
    expect(huge.rows).toHaveLength(10)
    expect(huge.truncated).toBe(true)
  })

  test('语句超时返回 QUERY_TIMEOUT', async () => {
    await expect(
      adapter.executeRead('select count(*) from generate_series(1, 2000000000)', {
        maxRows: 10,
        statementTimeoutMs: 300,
      }),
    ).rejects.toMatchObject({ code: 'QUERY_TIMEOUT' })
  })

  describe('第二层：只读事务是真正的安全边界', () => {
    test('绕过闸门直接走只读通道，写语句被数据库自己拒掉', async () => {
      // 这里**故意不经过 runGuardedSql**：直接调只读通道。
      // 如果这条能成功，说明只读事务这层其实不存在，分类器就成了唯一的防线。
      await expect(
        adapter.executeRead(`insert into probe_items (name, qty) values ('bypass', 1)`, readOptions),
      ).rejects.toMatchObject({ code: 'QUERY_FAILED' })

      const after = await admin.query(`select count(*)::int as count from probe_items where name = 'bypass'`)
      expect(after.rows[0]?.count).toBe(0)
    })

    test('绕过闸门也建不了表', async () => {
      await expect(
        adapter.executeRead('create table bypass_table (id int)', readOptions),
      ).rejects.toBeInstanceOf(DriverError)

      const exists = await admin.query(
        `select 1 from information_schema.tables where table_name = 'bypass_table'`,
      )
      expect(exists.rowCount).toBe(0)
    })
  })

  describe('闸门判定', () => {
    test('只有读授权时，写语句被闸门拒', async () => {
      const outcome = await runGuardedSql(
        { ...guardBase, adapter, grant: { canRead: true, canWrite: false }, mode: 'execute' },
        `insert into probe_items (name) values ('nope')`,
      )
      expect(outcome).toMatchObject({
        status: 'denied',
        classification: 'write',
        code: 'NO_WRITE_GRANT',
        keyword: 'INSERT',
      })
    })

    test('没有授权时，读语句被闸门拒', async () => {
      const outcome = await runGuardedSql(
        { ...guardBase, adapter, grant: undefined, mode: 'query' },
        'select 1',
      )
      expect(outcome).toMatchObject({ status: 'denied', code: 'NO_READ_GRANT', keyword: 'SELECT' })
    })

    test('query 工具收到写语句时给出明确方向', async () => {
      const outcome = await runGuardedSql(
        { ...guardBase, adapter, grant: { canRead: true, canWrite: true }, mode: 'query' },
        'delete from probe_items',
      )
      expect(outcome).toMatchObject({ code: 'WRITE_STATEMENT_IN_READ_TOOL' })
    })

    test('DDL 在闸门第一道就被拒，且不碰数据库', async () => {
      const outcome = await runGuardedSql(
        { ...guardBase, adapter, grant: { canRead: true, canWrite: true }, mode: 'execute' },
        'drop table probe_items',
      )
      expect(outcome).toMatchObject({ status: 'denied', classification: 'denied', code: 'DDL_FORBIDDEN' })

      const still = await admin.query('select count(*)::int as count from probe_items')
      expect(still.rows[0]?.count).toBe(5)
    })

    test('有写授权时写语句走通', async () => {
      const outcome = await runGuardedSql(
        { ...guardBase, adapter, grant: { canRead: false, canWrite: true }, mode: 'execute' },
        `update probe_items set qty = 99 where name = 'a'`,
      )
      expect(outcome).toMatchObject({ status: 'ok', classification: 'write' })

      const check = await admin.query(`select qty from probe_items where name = 'a'`)
      expect(check.rows[0]?.qty).toBe(99)
    })

    test('写授权不能拿来读：按分类判权，而不是按工具判权', async () => {
      const outcome = await runGuardedSql(
        { ...guardBase, adapter, grant: { canRead: false, canWrite: true }, mode: 'execute' },
        'select * from probe_items',
      )
      expect(outcome).toMatchObject({ status: 'denied', code: 'NO_READ_GRANT', classification: 'read' })
    })

    test('读语句带写授权时正常返回', async () => {
      const outcome = await runGuardedSql(
        { ...guardBase, adapter, grant: { canRead: true, canWrite: true }, mode: 'execute' },
        'select count(*)::int as count from probe_items',
      )
      expect(outcome.status).toBe('ok')
      if (outcome.status === 'ok') expect(outcome.result.rows[0]).toEqual({ count: 5 })
    })
  })

  describe('连接池注册表', () => {
    function rowFor(overrides: Partial<DatasourceRow> = {}): DatasourceRow {
      return {
        id: 1,
        name: 'probe',
        engine: 'postgres',
        host: config.host,
        port: config.port,
        databaseName: config.database,
        username: config.user,
        passwordCiphertext: encryptSecret(config.password),
        connectOptions: {},
        enabled: true,
        lastTestAt: null,
        lastTestOk: null,
        lastTestError: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides,
      }
    }

    test('同一配置复用同一个池，配置变了就换', async () => {
      const registry = new PoolRegistry({ poolMax: 2, idleEvictMinutes: 15 })
      try {
        const row = rowFor()
        const first = await registry.adapterFor(row)
        expect(registry.size).toBe(1)
        expect(await registry.adapterFor(row)).toBe(first)

        // 密文变了（等价于改了口令）→ 旧池关掉、换新池。
        const changed = await registry.adapterFor(rowFor({ passwordCiphertext: encryptSecret('other') }))
        expect(changed).not.toBe(first)
        expect(registry.size).toBe(1)
      } finally {
        await registry.closeAll()
      }
      expect(registry.size).toBe(0)
    })

    test('停用的数据源拿不到连接', async () => {
      const registry = new PoolRegistry({ poolMax: 2, idleEvictMinutes: 15 })
      try {
        await expect(registry.adapterFor(rowFor({ enabled: false }))).rejects.toMatchObject({
          code: 'DATASOURCE_DISABLED',
        })
      } finally {
        await registry.closeAll()
      }
    })

    test('空闲超时的池会被回收', async () => {
      let now = 1_000_000
      const registry = new PoolRegistry({ poolMax: 2, idleEvictMinutes: 1, now: () => now })
      try {
        await registry.adapterFor(rowFor())
        expect(registry.size).toBe(1)

        now += 30_000
        await registry.adapterFor(rowFor())
        expect(registry.size).toBe(1)

        now += 61_000
        // 触发一次惰性检查：再取一次时旧的已过空闲期。
        await registry.evict(1)
        expect(registry.size).toBe(0)
      } finally {
        await registry.closeAll()
      }
    })

    test('通过注册表取到的适配器可以真正执行', async () => {
      const registry = new PoolRegistry({ poolMax: 2, idleEvictMinutes: 15 })
      try {
        const pooled = await registry.adapterFor(rowFor())
        const result = await pooled.executeRead('select count(*)::int as count from probe_items', readOptions)
        expect(result.rows[0]).toEqual({ count: 5 })
      } finally {
        await registry.closeAll()
      }
    })
  })
})
