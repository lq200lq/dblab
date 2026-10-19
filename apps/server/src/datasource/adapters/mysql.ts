import {
  ERROR_MESSAGE_BY_CODE,
  type DatasourceTestResult,
  type QueryResult,
  type TableDescription,
  type TableSummary,
} from '@dblab/shared'
import { createPool, type Pool, type PoolConnection, type PoolOptions, type RowDataPacket } from 'mysql2/promise'

import type { ResolvedDriverConfig } from '../driver-config'

import { DriverError, errorMessageOf, safeDriverMessage, type DriverAdapter, type ExecuteOptions } from './types'

/** 认证被拒（MySQL 客户端错误码）。 */
const AUTH_CODES = new Set(['ER_ACCESS_DENIED_ERROR', 'ER_ACCESS_DENIED_NO_PASSWORD_ERROR'])

const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'ECONNRESET',
  'EPIPE',
  'ER_BAD_DB_ERROR',
  'PROTOCOL_CONNECTION_LOST',
  'EAI_AGAIN',
])

const TIMEOUT_CODES = new Set(['ER_QUERY_TIMEOUT', 'PROTOCOL_SEQUENCE_TIMEOUT', 'ER_STATEMENT_TIMEOUT'])

const MAX_LISTED_TABLES = 2_000

/**
 * 目录查询单独导出，好让测试直接断言这些字符串：MySQL 侧没有活库可验，
 * 「SQL 字符串本身正确、且全部走绑定参数、没有标识符拼接」就是能拿到的最强证据。
 */
export const MYSQL_CATALOG_SQL = {
  listTables: `select table_schema as \`schema\`, table_name as name, table_type as kind
     from information_schema.tables
    where table_schema not in ('mysql', 'information_schema', 'performance_schema', 'sys')
      and (? is null or table_schema = ?)
    order by table_schema, table_name
    limit ${MAX_LISTED_TABLES}`,
  describeTable: `select column_name, column_type, is_nullable, column_default, column_key
     from information_schema.columns
    where table_schema = ? and table_name = ?
    order by ordinal_position`,
} as const

/**
 * 读路径固定用这一串：READ ONLY 必须在 START TRANSACTION **之前**下发，
 * 因为它描述的是「下一个事务」的属性。
 */
export const MYSQL_READ_ONLY_SEQUENCE = [
  'SET TRANSACTION READ ONLY',
  'START TRANSACTION',
] as const

/**
 * 池选项单独导出，好让测试直接断言 multipleStatements 没被打开。
 * 这是全仓性价比最高的一行设置：一旦为 true，`SELECT 1; DROP TABLE t`
 * 即使绕过了语句分类器，也会被当成一个批次执行。
 */
export function mysqlPoolOptions(config: ResolvedDriverConfig, connectionLimit: number): PoolOptions {
  return {
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    connectionLimit,
    connectTimeout: 5_000,
    multipleStatements: false,
    ssl: config.ssl ? { rejectUnauthorized: config.sslVerify } : undefined,
  }
}

export async function testMysqlConnection(
  config: ResolvedDriverConfig,
): Promise<DatasourceTestResult> {
  const startedAt = Date.now()
  const pool = createPool(mysqlPoolOptions(config, 1))

  try {
    const [rows] = await pool.query<RowDataPacket[]>('select version() as version')
    return {
      ok: true,
      latencyMs: Date.now() - startedAt,
      serverVersion: (rows[0] as { version?: string } | undefined)?.version ?? null,
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

export class MysqlAdapter implements DriverAdapter {
  readonly engine = 'mysql' as const
  private readonly pool: Pool

  constructor(
    private readonly config: ResolvedDriverConfig,
    poolMax: number,
  ) {
    this.pool = createPool(mysqlPoolOptions(config, poolMax))
  }

  testConnection(): Promise<DatasourceTestResult> {
    return testMysqlConnection(this.config)
  }

  async listTables(schema?: string): Promise<TableSummary[]> {
    const rows = await this.select<{ schema: string; name: string; kind: string }>(
      MYSQL_CATALOG_SQL.listTables,
      [schema ?? null, schema ?? null],
    )
    return rows.map((row) => ({ schema: row.schema, name: row.name, kind: row.kind }))
  }

  async describeTable(table: string, schema?: string): Promise<TableDescription | null> {
    const targetSchema = schema ?? this.config.database

    const rows = await this.select<{
      column_name: string
      column_type: string
      is_nullable: string
      column_default: string | null
      column_key: string
    }>(MYSQL_CATALOG_SQL.describeTable, [targetSchema, table])

    if (rows.length === 0) return null

    const columns = rows.map((row) => ({
      name: row.column_name,
      dataType: row.column_type,
      nullable: row.is_nullable === 'YES',
      defaultValue: row.column_default,
      primaryKey: row.column_key === 'PRI',
    }))

    return {
      schema: targetSchema,
      name: table,
      columns,
      primaryKey: columns.filter((column) => column.primaryKey).map((column) => column.name),
    }
  }

  executeRead(sql: string, options: ExecuteOptions): Promise<QueryResult> {
    return this.withConnection(async (connection) => {
      // READ ONLY 只作用于下一个事务，用完即失效，不会留在池化连接上。
      for (const statement of MYSQL_READ_ONLY_SEQUENCE) {
        await connection.query(statement)
      }
      // max_execution_time 只约束 SELECT；DML 没有等价的会话级超时，
      // 这是 MySQL 侧已知的覆盖缺口，README 里有说明。
      await connection.query(`SET SESSION max_execution_time = ${safeIntMs(options.statementTimeoutMs)}`)
      // 会话级行数上限：多取一行用来判断是否截断。
      await connection.query(`SET SESSION sql_select_limit = ${safeLimit(options.maxRows)}`)
      try {
        return await this.queryRows(connection, sql, options.maxRows)
      } finally {
        await connection.query('COMMIT').catch(() => {})
      }
    })
  }

  executeWrite(sql: string, options: ExecuteOptions): Promise<QueryResult> {
    return this.withConnection(async (connection) => {
      await connection.query('START TRANSACTION')
      try {
        const [result] = await connection.query(sql)
        if (Array.isArray(result)) {
          const rows = result as Record<string, unknown>[]
          return { columns: rows[0] ? Object.keys(rows[0]) : [], rows, rowCount: rows.length, truncated: false }
        }
        const header = result as { affectedRows?: number }
        return { columns: [], rows: [], rowCount: header.affectedRows ?? 0, truncated: false }
      } finally {
        await connection.query('COMMIT').catch(() => {})
      }
    })
  }

  async close(): Promise<void> {
    await this.pool.end().catch(() => {})
  }

  private async select<T extends Record<string, unknown>>(sql: string, params: unknown[]): Promise<T[]> {
    return this.withConnection(async (connection) => {
      const [rows] = await connection.query<RowDataPacket[]>(sql, params)
      return rows as unknown as T[]
    })
  }

  private async queryRows(
    connection: PoolConnection,
    sql: string,
    maxRows: number,
  ): Promise<QueryResult> {
    const [rows] = await connection.query<RowDataPacket[]>(sql)
    const all = (rows as unknown as Record<string, unknown>[]) ?? []
    const truncated = all.length > maxRows
    const kept = truncated ? all.slice(0, maxRows) : all
    return {
      columns: kept[0] ? Object.keys(kept[0]) : [],
      rows: kept,
      rowCount: kept.length,
      truncated,
    }
  }

  /**
   * 取一条专用连接来跑，好让会话级设置有明确的归属；
   * 用完把这两个会话变量复位，否则会留污染给池里的下一位使用者。
   */
  private async withConnection<T>(task: (connection: PoolConnection) => Promise<T>): Promise<T> {
    const connection = await this.pool.getConnection()
    try {
      return await task(connection)
    } catch (error) {
      await connection.query('ROLLBACK').catch(() => {})
      throw this.toDriverError(error)
    } finally {
      await connection.query('SET SESSION sql_select_limit = DEFAULT').catch(() => {})
      await connection.query('SET SESSION max_execution_time = DEFAULT').catch(() => {})
      connection.release()
    }
  }

  private toDriverError(error: unknown): DriverError {
    const message = safeDriverMessage(errorMessageOf(error), [this.config.password]) ?? '语句执行失败'
    const code = (error as { code?: unknown } | null)?.code
    if (typeof code === 'string' && TIMEOUT_CODES.has(code)) {
      return new DriverError('QUERY_TIMEOUT', message)
    }
    return new DriverError('QUERY_FAILED', message)
  }
}

function classifyConnectionError(error: unknown): 'DATASOURCE_AUTH_FAILED' | 'DATASOURCE_UNREACHABLE' {
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code === 'string' && AUTH_CODES.has(code)) return 'DATASOURCE_AUTH_FAILED'
  if (typeof code === 'string' && UNREACHABLE_CODES.has(code)) return 'DATASOURCE_UNREACHABLE'
  return 'DATASOURCE_UNREACHABLE'
}

/** sql_select_limit / max_execution_time 只能拼数字进去（不能参数化），先确保是正整数。 */
function safeIntMs(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 15_000
  return Math.min(Math.trunc(value), 600_000)
}

function safeLimit(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 500
  return Math.min(Math.trunc(value), 100_000)
}
