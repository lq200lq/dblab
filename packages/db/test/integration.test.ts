import { eq } from 'drizzle-orm'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { createPlatformDb } from '../src/client'
import { verifyPassword } from '../src/password'
import { ensureAdmin } from '../src/seed-admin'
import { adminUser } from '../src/schema'

/**
 * 需要真实 PostgreSQL 的用例。未设置 TEST_DATABASE_URL 时整体跳过
 * （确认结果时注意别把「跳过」当「通过」）。
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL
const describeDb = TEST_DATABASE_URL ? describe : describe.skip

/** 语句必须被拒时用这个：通过反而失败。 */
async function rejectionMessage(client: Client, sql: string): Promise<string> {
  try {
    await client.query(sql)
  } catch (err) {
    return (err as Error).message
  }
  throw new Error(`期望被拒但通过了：${sql}`)
}

describeDb('平台库结构约束', () => {
  let client: Client

  beforeAll(async () => {
    client = new Client({ connectionString: TEST_DATABASE_URL })
    await client.connect()
  })

  afterAll(async () => {
    await client.end()
  })

  test('六张表都在', async () => {
    const result = await client.query<{ table_name: string }>(
      `select table_name from information_schema.tables
        where table_schema = 'public' and table_name = any($1::text[])
        order by table_name`,
      [['admin_user', 'session', 'datasource', 'api_key', 'api_key_grant', 'audit_log']],
    )
    expect(result.rows.map((r) => r.table_name)).toEqual([
      'admin_user',
      'api_key',
      'api_key_grant',
      'audit_log',
      'datasource',
      'session',
    ])
  })

  test('审计表 UPDATE 被触发器拒绝', async () => {
    await client.query('BEGIN')
    await client.query(
      `insert into audit_log (actor_kind, actor_name, action, decision)
       values ('admin', 'itest', 'auth.login', 'granted')`,
    )
    const message = await rejectionMessage(client, `update audit_log set actor_name = 'x'`)
    expect(message).toContain('只增不改')
    await client.query('ROLLBACK')
  })

  test('审计表 DELETE 被触发器拒绝', async () => {
    await client.query('BEGIN')
    await client.query(
      `insert into audit_log (actor_kind, actor_name, action, decision)
       values ('admin', 'itest', 'auth.login', 'granted')`,
    )
    const message = await rejectionMessage(client, 'delete from audit_log')
    expect(message).toContain('只增不改')
    await client.query('ROLLBACK')
  })

  test('审计表 TRUNCATE 被语句级触发器拒绝', async () => {
    await client.query('BEGIN')
    await client.query(
      `insert into audit_log (actor_kind, actor_name, action, decision)
       values ('admin', 'itest', 'auth.login', 'granted')`,
    )
    const message = await rejectionMessage(client, 'truncate audit_log')
    expect(message).toContain('只增不改')
    await client.query('ROLLBACK')
  })

  test('回滚后不留残留：行数严格不变', async () => {
    // 不假设表是空的（审计只增不改，跑过别的用例后表里必然有行）。
    // 要证明的是「回滚没留下这条记录」，所以比较前后的行数差。
    const before = await client.query<{ count: string }>(
      'select count(*)::text as count from audit_log',
    )
    await client.query('BEGIN')
    await client.query(
      `insert into audit_log (actor_kind, actor_name, action, decision)
       values ('admin', 'itest-rollback', 'auth.login', 'granted')`,
    )
    await client.query('ROLLBACK')

    const after = await client.query<{ count: string }>(
      'select count(*)::text as count from audit_log',
    )
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count)
    const leaked = await client.query(
      `select 1 from audit_log where actor_name = 'itest-rollback' limit 1`,
    )
    expect(leaked.rowCount).toBe(0)
  })

  test('拒绝必须带理由、通过不得带理由', async () => {
    await client.query('BEGIN')
    const missingReason = await rejectionMessage(
      client,
      `insert into audit_log (actor_kind, actor_name, action, decision, denial_reason)
       values ('agent', 'k', 'mcp.query', 'denied', null)`,
    )
    expect(missingReason).toContain('audit_log_denial_reason_check')
    await client.query('ROLLBACK')

    await client.query('BEGIN')
    const grantedWithReason = await rejectionMessage(
      client,
      `insert into audit_log (actor_kind, actor_name, action, decision, denial_reason)
       values ('admin', 'a', 'auth.login', 'granted', 'x')`,
    )
    expect(grantedWithReason).toContain('audit_log_denial_reason_check')
    await client.query('ROLLBACK')
  })

  test('动作与分类的取值受约束', async () => {
    await client.query('BEGIN')
    const badAction = await rejectionMessage(
      client,
      `insert into audit_log (actor_kind, actor_name, action, decision)
       values ('admin', 'a', 'not.an.action', 'granted')`,
    )
    expect(badAction).toContain('audit_log_action_check')
    await client.query('ROLLBACK')

    await client.query('BEGIN')
    const badClass = await rejectionMessage(
      client,
      `insert into audit_log (actor_kind, actor_name, action, decision, classification)
       values ('admin', 'a', 'auth.login', 'granted', 'maybe')`,
    )
    expect(badClass).toContain('audit_log_classification_check')
    await client.query('ROLLBACK')
  })

  test('数据源引擎与端口的取值受约束', async () => {
    await client.query('BEGIN')
    const badEngine = await rejectionMessage(
      client,
      `insert into datasource (name, engine, host, port, database_name, username, password_ciphertext)
       values ('itest-bad', 'oracle', 'h', 1521, 'd', 'u', 'v1:x:y:z')`,
    )
    expect(badEngine).toContain('datasource_engine_check')
    await client.query('ROLLBACK')
  })

  test('读与写都关掉的授权无法入库', async () => {
    await client.query('BEGIN')
    const result = await client.query<{ id: number }>(
      `insert into datasource (name, engine, host, port, database_name, username, password_ciphertext)
       values ('itest-grant', 'postgres', 'h', 5432, 'd', 'u', 'v1:x:y:z') returning id`,
    )
    const datasourceId = result.rows[0]?.id
    const keyRow = await client.query<{ id: number }>(
      `insert into api_key (name, prefix, key_hash) values ('itest', 'dblab_itscope0', 'h') returning id`,
    )
    const apiKeyId = keyRow.rows[0]?.id

    const bad = await rejectionMessage(
      client,
      `insert into api_key_grant (api_key_id, datasource_id, can_read, can_write)
       values (${apiKeyId}, ${datasourceId}, false, false)`,
    )
    expect(bad).toContain('api_key_grant_has_permission_check')
    await client.query('ROLLBACK')
  })

  test('同一密钥与数据源只能有一条授权', async () => {
    await client.query('BEGIN')
    const ds = await client.query<{ id: number }>(
      `insert into datasource (name, engine, host, port, database_name, username, password_ciphertext)
       values ('itest-uq', 'postgres', 'h', 5432, 'd', 'u', 'v1:x:y:z') returning id`,
    )
    const datasourceId = ds.rows[0]?.id
    const keyRow = await client.query<{ id: number }>(
      `insert into api_key (name, prefix, key_hash) values ('itest-uq', 'dblab_ituq0000', 'h') returning id`,
    )
    const apiKeyId = keyRow.rows[0]?.id

    await client.query(
      `insert into api_key_grant (api_key_id, datasource_id, can_read, can_write)
       values (${apiKeyId}, ${datasourceId}, true, false)`,
    )
    const dup = await rejectionMessage(
      client,
      `insert into api_key_grant (api_key_id, datasource_id, can_read, can_write)
       values (${apiKeyId}, ${datasourceId}, true, true)`,
    )
    expect(dup).toContain('api_key_grant_key_datasource_uq')
    await client.query('ROLLBACK')
  })
})

describeDb('ensureAdmin', () => {
  const username = 'itest_admin'
  let db: ReturnType<typeof createPlatformDb>['db']
  let pool: ReturnType<typeof createPlatformDb>['pool']

  beforeAll(() => {
    const created = createPlatformDb(TEST_DATABASE_URL as string)
    db = created.db
    pool = created.pool
  })

  afterAll(async () => {
    await pool.query('delete from admin_user where username = $1', [username])
    await pool.end()
  })

  test('只增不覆盖：第二次调用不改动已有口令哈希', async () => {
    await pool.query('delete from admin_user where username = $1', [username])

    expect((await ensureAdmin(db, username, 'first-password')).status).toBe('created')

    const stored = await db
      .select({ passwordHash: adminUser.passwordHash })
      .from(adminUser)
      .where(eq(adminUser.username, username))
    const firstHash = stored[0]?.passwordHash as string
    expect(verifyPassword('first-password', firstHash)).toBe(true)

    expect((await ensureAdmin(db, username, 'second-password')).status).toBe('exists')

    const after = await db
      .select({ passwordHash: adminUser.passwordHash })
      .from(adminUser)
      .where(eq(adminUser.username, username))
    expect(after[0]?.passwordHash).toBe(firstHash)
    expect(verifyPassword('second-password', after[0]?.passwordHash as string)).toBe(false)
  })
})
