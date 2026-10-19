import { ERROR_MESSAGE_BY_CODE, type DatasourceTestResult, type QueryResult, type TableDescription, type TableSummary } from '@dblab/shared'
import { Pool, type PoolClient } from 'pg'
import Cursor from 'pg-cursor'

import type { ResolvedDriverConfig } from '../driver-config'

import { errorMessageOf, safeDriverMessage, DriverError, type DriverAdapter, type ExecuteOptions } from './types'

/** 连接失败的错误码集合：网络层到不了目标。 */
const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'ECONNRESET',
  'EPIPE',
  'EAI_AGAIN',
])

/** 认证失败（PostgreSQL SQLSTATE 28xxx）。 */
const AUTH_SQLSTATES = new Set(['28P01', '28000'])

/** 语句被取消：statement_timeout 命中。 */
const CANCELED_SQLSTATE = '57014'

const DEFAULT_SCHEMA = 'public'
const MAX_LISTED_TABLES = 2_000

/**
 * 连通性探测。用一次性的连接池：探测连的**是别人的库**，可能失败在握手阶段，
 * 不与查询用的操作池共用，免得失败状态被带进正常路径。
 */
export async function testPostgresConnection(
  config: ResolvedDriverConfig,
): Promise<DatasourceTestResult> {
  const startedAt = Date.now()
  const pool = new Pool(connectionOptions(config, 1))
  pool.on('error', () => {})

  try {
    const result = await pool.query<{ version: string }>('select version() as version')
    return {
      ok: true,
      latencyMs: Date.now() - startedAt,
      serverVersion: result.rows[0]?.version ?? null,
      errorCode: null,
      message: null,
    }
  } catch (error) {
    const code = classifyConnectionError(error)
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      serverVersion: null,
      errorCode: code,
      message: safeDriverMessage(errorMessageOf(error), [config.password]) ?? ERROR_MESSAGE_BY_CODE[code],
    }
  } finally {
    await pool.end().catch(() => {})
  }
}

function connectionOptions(config: ResolvedDriverConfig, max: number) {
  // 传离散字段而不是拼 postgresql://user:pass@host：
  // 口令里出现 @ : / # ? % 会把连接串拼坏，而且报错信息完全看不出是拼串的问题。
  return {
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    // rejectUnauthorized 缺省为 true（即校验证书）。内网自签证书要靠
    // connectOptions.sslVerify=false 显式关掉，不做静默放行。
    ssl: config.ssl ? { rejectUnauthorized: config.sslVerify } : undefined,
    max,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 1_000,
  }
}

export class PostgresAdapter implements DriverAdapter {
  readonly engine = 'postgres' as const
  private readonly pool: Pool

  constructor(private readonly config: ResolvedDriverConfig, poolMax: number) {
    this.pool = new Pool(connectionOptions(config, poolMax))
    // 池里空闲连接出错会以 'error' 事件抛出，没人接就是未捕获异常、直接杀进程。
    this.pool.on('error', () => {})
  }

  testConnection(): Promise<DatasourceTestResult> {
    return testPostgresConnection(this.config)
  }

  async listTables(schema?: string): Promise<TableSummary[]> {
    const result = await this.runPlain<{ schema: string; name: string; kind: string }>(
      `select table_schema as schema, table_name as name, table_type as kind
         from information_schema.tables
        where table_schema not in ('pg_catalog', 'information_schema')
          and ($1::text is null or table_schema = $1::text)
        order by table_schema, table_name
        limit ${MAX_LISTED_TABLES}`,
      [schema ?? null],
      { timeoutMs: 5_000 },
    )

    return result.rows.map((row) => ({ schema: row.schema, name: row.name, kind: row.kind }))
  }

  async describeTable(table: string, schema?: string): Promise<TableDescription | null> {
    const targetSchema = schema ?? DEFAULT_SCHEMA

    // 表名与库名全部走绑定参数，不做任何标识符拼接。
    const columns = await this.runPlain<{
      column_name: string
      data_type: string
      is_nullable: string
      column_default: string | null
      is_primary_key: boolean
    }>(
      `select c.column_name,
              c.data_type,
              c.is_nullable,
              c.column_default,
              (pk.column_name is not null) as is_primary_key
         from information_schema.columns c
         left join (
              select kcu.column_name
                from information_schema.table_constraints tc
                join information_schema.key_column_usage kcu
                  on kcu.constraint_name = tc.constraint_name
                 and kcu.table_schema = tc.table_schema
               where tc.constraint_type = 'PRIMARY KEY'
                 and tc.table_schema = $1::text
                 and tc.table_name = $2::text
         ) pk on pk.column_name = c.column_name
        where c.table_schema = $1::text and c.table_name = $2::text
        order by c.ordinal_position`,
      [targetSchema, table],
      { timeoutMs: 5_000 },
    )

    if (columns.rows.length === 0) return null

    const described = columns.rows.map((row) => ({
      name: row.column_name,
      dataType: row.data_type,
      nullable: row.is_nullable === 'YES',
      defaultValue: row.column_default,
      primaryKey: row.is_primary_key,
    }))

    return {
      schema: targetSchema,
      name: table,
      columns: described,
      primaryKey: described.filter((column) => column.primaryKey).map((column) => column.name),
    }
  }

  executeRead(sql: string, options: ExecuteOptions): Promise<QueryResult> {
    return this.runInTransaction(sql, options, { readOnly: true, stream: true })
  }

  executeWrite(sql: string, options: ExecuteOptions): Promise<QueryResult> {
    return this.runInTransaction(sql, options, { readOnly: false, stream: false })
  }

  async close(): Promise<void> {
    await this.pool.end().catch(() => {})
  }

  /** 不带事务的内省查询（只读目录表，无副作用）。 */
  private async runPlain<T extends Record<string, unknown>>(
    sql: string,
    params: unknown[],
    options: { timeoutMs: number },
  ): Promise<{ rows: T[] }> {
    const client = await this.pool.connect()
    try {
      await client.query(`SET statement_timeout = ${safeIntMs(options.timeoutMs)}`)
      const result = await client.query<T>(sql, params)
      return { rows: result.rows }
    } catch (error) {
      throw this.toDriverError(error)
    } finally {
      await client.query('RESET statement_timeout').catch(() => {})
      client.release()
    }
  }

  /**
   * 读走 BEGIN TRANSACTION READ ONLY：这是分类器之外的第二层，也是唯一真正的安全边界。
   * 分类器被绕过时，写语句会在这里被 PostgreSQL 拒掉。
   */
  private async runInTransaction(
    sql: string,
    options: ExecuteOptions,
    shape: { readOnly: boolean; stream: boolean },
  ): Promise<QueryResult> {
    const client = await this.pool.connect()
    let transactionOpen = false

    try {
      await client.query(shape.readOnly ? 'BEGIN TRANSACTION READ ONLY' : 'BEGIN')
      transactionOpen = true
      // SET LOCAL 是事务级的，事务一结束就自动失效，不会把状态留给池里的下一位使用者。
      await client.query(`SET LOCAL statement_timeout = ${safeIntMs(options.statementTimeoutMs)}`)

      const result = shape.stream
        ? await this.streamWithRowCap(client, sql, options.maxRows)
        : await this.runWrite(client, sql)

      await client.query('COMMIT')
      transactionOpen = false
      return result
    } catch (error) {
      if (transactionOpen) await client.query('ROLLBACK').catch(() => {})
      throw this.toDriverError(error)
    } finally {
      client.release()
    }
  }

  /** 用游标只取 maxRows+1 行：不把整表搬到内存里，靠多取一行判断是否截断。 */
  private streamWithRowCap(client: PoolClient, sql: string, maxRows: number): Promise<QueryResult> {
    return new Promise<QueryResult>((resolve, reject) => {
      const cursor = client.query(new Cursor(sql))
      cursor.read(maxRows + 1, (error, rows, result) => {
        if (error) {
          cursor.close(() => reject(error))
          return
        }
        const truncated = rows.length > maxRows
        const kept = truncated ? rows.slice(0, maxRows) : rows
        const columns = (result?.fields ?? []).map((field) => field.name)
        cursor.close((closeError) => {
          if (closeError) reject(closeError)
          else
            resolve({
              columns,
              rows: kept as Record<string, unknown>[],
              rowCount: kept.length,
              truncated,
            })
        })
      })
    })
  }

  private async runWrite(client: PoolClient, sql: string): Promise<QueryResult> {
    const result = await client.query(sql)
    return {
      columns: (result.fields ?? []).map((field) => field.name),
      rows: (result.rows ?? []) as Record<string, unknown>[],
      rowCount: result.rowCount ?? 0,
      truncated: false,
    }
  }

  private toDriverError(error: unknown): DriverError {
    const message = safeDriverMessage(errorMessageOf(error), [this.config.password]) ?? '语句执行失败'
    const code = (error as { code?: unknown } | null)?.code
    if (code === CANCELED_SQLSTATE) {
      return new DriverError('QUERY_TIMEOUT', message)
    }
    return new DriverError('QUERY_FAILED', message)
  }
}

function classifyConnectionError(error: unknown): 'DATASOURCE_AUTH_FAILED' | 'DATASOURCE_UNREACHABLE' {
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code === 'string' && AUTH_SQLSTATES.has(code)) return 'DATASOURCE_AUTH_FAILED'
  if (typeof code === 'string' && UNREACHABLE_CODES.has(code)) return 'DATASOURCE_UNREACHABLE'
  return 'DATASOURCE_UNREACHABLE'
}

/** statement_timeout 只能拼数字进去（不能参数化），所以先确保它真的是正整数。 */
function safeIntMs(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 15_000
  return Math.min(Math.trunc(value), 600_000)
}
