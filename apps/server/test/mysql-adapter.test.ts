import { describe, expect, test } from 'vitest'

import type { ResolvedDriverConfig } from '../src/datasource/driver-config'
import {
  MYSQL_CATALOG_SQL,
  MYSQL_READ_ONLY_SEQUENCE,
  mysqlPoolOptions,
} from '../src/datasource/adapters/mysql'

/**
 * MySQL 侧没有活库可验（拿不到凭据），所以这一组是**不依赖数据库**的最强证据：
 * 目录 SQL 的字面形状、只读事务的下发顺序、以及那条最关键的池设置。
 */
const config: ResolvedDriverConfig = {
  engine: 'mysql',
  host: 'db.internal',
  port: 3306,
  database: 'app',
  user: 'reader',
  password: 'secret',
  ssl: false,
  sslVerify: true,
}

describe('MySQL 池设置', () => {
  test('multipleStatements 必须是 false', () => {
    // 一旦为 true，`SELECT 1; DROP TABLE t` 即便绕过语句分类器也会被当批次执行。
    expect(mysqlPoolOptions(config, 4).multipleStatements).toBe(false)
  })

  test('连接参数离散传入，不拼连接串；口令原样交给驱动', () => {
    const options = mysqlPoolOptions(config, 4)
    expect(options.host).toBe('db.internal')
    expect(options.port).toBe(3306)
    expect(options.database).toBe('app')
    expect(options.user).toBe('reader')
    expect(options.password).toBe('secret')
    expect(options.connectionLimit).toBe(4)
  })

  test('TLS 缺省校验证书，只有显式关掉才不校验', () => {
    expect(mysqlPoolOptions({ ...config, ssl: true }, 4).ssl).toEqual({ rejectUnauthorized: true })
    expect(mysqlPoolOptions({ ...config, ssl: true, sslVerify: false }, 4).ssl).toEqual({
      rejectUnauthorized: false,
    })
    expect(mysqlPoolOptions({ ...config, ssl: false }, 4).ssl).toBeUndefined()
  })
})

describe('MySQL 只读事务下发顺序', () => {
  test('READ ONLY 必须在 START TRANSACTION 之前（它描述的是下一个事务）', () => {
    expect(MYSQL_READ_ONLY_SEQUENCE).toEqual(['SET TRANSACTION READ ONLY', 'START TRANSACTION'])
  })
})

describe('MySQL 目录查询', () => {
  test('表名与库名只走绑定参数，不做标识符拼接', () => {
    // 只断言「参数出现的位置」，不锚定空白，改动格式不会误报。
    expect(MYSQL_CATALOG_SQL.listTables).toContain('(? is null or table_schema = ?)')
    expect(MYSQL_CATALOG_SQL.describeTable).toContain('where table_schema = ? and table_name = ?')
    for (const sql of [MYSQL_CATALOG_SQL.listTables, MYSQL_CATALOG_SQL.describeTable]) {
      expect(sql).not.toContain('${')
      expect(sql).not.toMatch(/table_name\s*=\s*'/)
    }
  })

  test('列表查询排除系统库并带上限', () => {
    for (const schema of ['mysql', 'information_schema', 'performance_schema', 'sys']) {
      expect(MYSQL_CATALOG_SQL.listTables).toContain(`'${schema}'`)
    }
    expect(MYSQL_CATALOG_SQL.listTables).toContain('limit 2000')
  })

  test('列信息按序返回并取主键标记', () => {
    expect(MYSQL_CATALOG_SQL.describeTable).toContain('order by ordinal_position')
    expect(MYSQL_CATALOG_SQL.describeTable).toContain('column_key')
  })
})
