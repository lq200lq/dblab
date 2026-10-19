import { describe, expect, test } from 'vitest'

import { classifySql } from '../src/sql/classify'

const READ = [
  'SELECT 1',
  '  \n\t SELECT * FROM t',
  'select id, name from users where id = 1',
  'EXPLAIN SELECT 1',
  'EXPLAIN ANALYZE SELECT 1',
  'SHOW TABLES',
  'SHOW CREATE TABLE t',
  'SHOW VARIABLES LIKE "x"',
  'WITH a AS (SELECT 1) SELECT * FROM a',
  'WITH RECURSIVE a AS (SELECT 1) SELECT * FROM a',
  'WITH a AS (SELECT 1), b AS (SELECT 2) SELECT * FROM a, b',
  '(SELECT 1)',
  'VALUES (1), (2)',
  'TABLE t',
  'DESCRIBE t',
  'DESC t',
  '-- 注释\nSELECT 1',
  '/* 块注释 */ SELECT 1',
  '/*/* 嵌套块注释 */ 还在注释里 */ SELECT 1',
  "SELECT ';' AS s",
  "SELECT 'a; DROP TABLE t;' AS s",
  'SELECT * FROM "weird;name"',
  'SELECT `weird;name` FROM t',
  'SELECT $$ ; DROP TABLE t $$ AS s',
  'SELECT $tag$ INSERT INTO t $tag$ AS s',
  'SELECT 1 -- 注释里带分号; DROP TABLE t',
  'SELECT 1 /* ; DROP TABLE t */',
  'SELECT nextval(\'s\')',
  'select * from t where note like \'%update%\'',
  'SELECT',
]

const WRITE = [
  'INSERT INTO t VALUES (1)',
  'insert into t (a) values (1)',
  'UPDATE t SET a = 1',
  'UPDATE t SET a = 1 WHERE id = 2',
  'DELETE FROM t',
  'DELETE FROM t WHERE id = 1',
  'REPLACE INTO t VALUES (1)',
  'MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN UPDATE SET a = 1',
  'WITH a AS (SELECT 1) INSERT INTO t SELECT * FROM a',
  'WITH a AS (SELECT 1) UPDATE t SET a = 1',
  'WITH a AS (SELECT 1) DELETE FROM t',
  '/* 前置注释 */ INSERT INTO t VALUES (1)',
  'INSERT INTO t VALUES (1);',
]

const DENIED: Array<[string, string]> = [
  ['CREATE TABLE t (a int)', 'DDL_FORBIDDEN'],
  ['CREATE TEMP TABLE t (a int)', 'DDL_FORBIDDEN'],
  ['CREATE INDEX i ON t (a)', 'DDL_FORBIDDEN'],
  ['ALTER TABLE t ADD c int', 'DDL_FORBIDDEN'],
  ['DROP TABLE t', 'DDL_FORBIDDEN'],
  ['DROP DATABASE d', 'DDL_FORBIDDEN'],
  ['TRUNCATE t', 'DDL_FORBIDDEN'],
  ['TRUNCATE TABLE t', 'DDL_FORBIDDEN'],
  ['GRANT ALL ON t TO u', 'DDL_FORBIDDEN'],
  ['REVOKE ALL ON t FROM u', 'DDL_FORBIDDEN'],
  ['COMMENT ON TABLE t IS \'x\'', 'DDL_FORBIDDEN'],
  ['RENAME TABLE a TO b', 'DDL_FORBIDDEN'],
  ['VACUUM FULL t', 'DDL_FORBIDDEN'],
  ['ANALYZE t', 'DDL_FORBIDDEN'],
  ['CLUSTER t', 'DDL_FORBIDDEN'],
  ['REINDEX TABLE t', 'DDL_FORBIDDEN'],
  ['REFRESH MATERIALIZED VIEW v', 'DDL_FORBIDDEN'],
  ['COPY t FROM \'/tmp/x.csv\'', 'DDL_FORBIDDEN'],
  ['DO $$ BEGIN PERFORM 1; END $$', 'DDL_FORBIDDEN'],
  ['CALL p()', 'DDL_FORBIDDEN'],
  ['PREPARE p AS SELECT 1', 'DDL_FORBIDDEN'],
  ['EXECUTE p', 'DDL_FORBIDDEN'],
  ['DEALLOCATE p', 'DDL_FORBIDDEN'],
  ['DECLARE c CURSOR FOR SELECT 1', 'DDL_FORBIDDEN'],
  ['HANDLER t OPEN', 'DDL_FORBIDDEN'],
  ['WITH a AS (SELECT 1) DROP TABLE t', 'DDL_FORBIDDEN'],

  ['SET search_path = public', 'TRANSACTION_CONTROL_FORBIDDEN'],
  ['SET GLOBAL max_connections = 1', 'TRANSACTION_CONTROL_FORBIDDEN'],
  ['SET @@session.autocommit = 1', 'TRANSACTION_CONTROL_FORBIDDEN'],
  ['BEGIN', 'TRANSACTION_CONTROL_FORBIDDEN'],
  ['BEGIN TRANSACTION', 'TRANSACTION_CONTROL_FORBIDDEN'],
  ['START TRANSACTION READ ONLY', 'TRANSACTION_CONTROL_FORBIDDEN'],
  ['COMMIT', 'TRANSACTION_CONTROL_FORBIDDEN'],
  ['ROLLBACK', 'TRANSACTION_CONTROL_FORBIDDEN'],
  ['SAVEPOINT s1', 'TRANSACTION_CONTROL_FORBIDDEN'],
  ['RELEASE SAVEPOINT s1', 'TRANSACTION_CONTROL_FORBIDDEN'],
  ['END', 'TRANSACTION_CONTROL_FORBIDDEN'],
  ['LOCK TABLES t WRITE', 'TRANSACTION_CONTROL_FORBIDDEN'],

  ['SELECT 1; DROP TABLE t', 'MULTI_STATEMENT_FORBIDDEN'],
  ['SELECT 1 --2; DROP TABLE t', 'MULTI_STATEMENT_FORBIDDEN'],

  ["SELECT 'a' INTO OUTFILE '/tmp/x'", 'HAZARD_STATEMENT_FORBIDDEN'],
  ["SELECT 'a' INTO DUMPFILE '/tmp/x'", 'HAZARD_STATEMENT_FORBIDDEN'],
  ['SELECT * INTO newt FROM t', 'HAZARD_STATEMENT_FORBIDDEN'],
  ["LOAD DATA INFILE '/tmp/x' INTO TABLE t", 'HAZARD_STATEMENT_FORBIDDEN'],
  ["SELECT LOAD_FILE('/etc/passwd')", 'HAZARD_STATEMENT_FORBIDDEN'],
  ['SELECT * FROM dblink(\'c\', \'select 1\') AS t(a int)', 'HAZARD_STATEMENT_FORBIDDEN'],
  ["SELECT lo_import('/etc/passwd')", 'HAZARD_STATEMENT_FORBIDDEN'],
  ["SELECT pg_read_file('/etc/passwd')", 'HAZARD_STATEMENT_FORBIDDEN'],
  ["SELECT pg_read_binary_file('/etc/passwd')", 'HAZARD_STATEMENT_FORBIDDEN'],
  ["SELECT pg_ls_dir('/')", 'HAZARD_STATEMENT_FORBIDDEN'],
  ['SELECT pg_sleep(600)', 'HAZARD_STATEMENT_FORBIDDEN'],
  ["SELECT xp_cmdshell('whoami')", 'HAZARD_STATEMENT_FORBIDDEN'],
  ['SELECT * FROM t FOR UPDATE', 'HAZARD_STATEMENT_FORBIDDEN'],
  ['SELECT * FROM t FOR SHARE', 'HAZARD_STATEMENT_FORBIDDEN'],
  ['SELECT * FROM t LOCK IN SHARE MODE', 'HAZARD_STATEMENT_FORBIDDEN'],
  ['SELECT 1 \u0000; DROP TABLE t', 'HAZARD_STATEMENT_FORBIDDEN'],

  ['', 'EMPTY_STATEMENT'],
  ['   ', 'EMPTY_STATEMENT'],
  [';', 'EMPTY_STATEMENT'],
  ['-- 只有注释', 'EMPTY_STATEMENT'],
  ['/* 只有注释 */', 'EMPTY_STATEMENT'],
  ['FOO BAR', 'UNKNOWN_STATEMENT'],
  ['x' + 'y'.repeat(11), 'UNKNOWN_STATEMENT'],
  ['--only a comment', 'UNKNOWN_STATEMENT'],
]

describe('classifySql / 只读语句', () => {
  for (const sql of READ) {
    test(`read: ${JSON.stringify(sql)}`, () => {
      const result = classifySql(sql)
      expect(result.cls).toBe('read')
      expect(result.code).toBeUndefined()
    })
  }
})

describe('classifySql / 写入语句', () => {
  for (const sql of WRITE) {
    test(`write: ${JSON.stringify(sql)}`, () => {
      const result = classifySql(sql)
      expect(result.cls).toBe('write')
      expect(result.code).toBeUndefined()
    })
  }
})

describe('classifySql / 拒绝语句', () => {
  for (const [sql, code] of DENIED) {
    test(`denied(${code}): ${JSON.stringify(sql)}`, () => {
      const result = classifySql(sql)
      expect(result.cls).toBe('denied')
      expect(result.code).toBe(code)
    })
  }
})

describe('classifySql / 长度上限', () => {
  test('超过上限即拒绝', () => {
    const long = `SELECT '${'a'.repeat(200)}'`
    expect(classifySql(long, { maxBytes: 50 }).code).toBe('SQL_TOO_LARGE')
    expect(classifySql(long, { maxBytes: 50_000 }).cls).toBe('read')
  })

  test('按 UTF-8 字节数而非字符数计', () => {
    // 30 个汉字 = 90 字节；上限 60 字节必须判超限。
    const sql = `SELECT '${'汉'.repeat(30)}'`
    expect(classifySql(sql, { maxBytes: 60 }).code).toBe('SQL_TOO_LARGE')
    expect(classifySql(sql, { maxBytes: 120 }).cls).toBe('read')
  })
})

describe('classifySql / 混淆不得漏过', () => {
  const wrappers: Array<[string, (sql: string) => string]> = [
    ['前缀行注释', (sql) => `-- 注释\n${sql}`],
    ['前缀块注释', (sql) => `/* 注释 */ ${sql}`],
    ['前缀空白换行', (sql) => `\n\n\t  ${sql}`],
    ['尾随注释', (sql) => `${sql} -- 尾随`],
    ['尾随块注释', (sql) => `${sql} /* 尾随 */`],
    ['组合包裹', (sql) => `-- a\n/* b */\n  ${sql}  /* c */ -- d`],
  ]

  const hostile = DENIED.filter(([sql]) => sql.trim().length > 0).map(([sql]) => sql)

  for (const [name, wrap] of wrappers) {
    for (const sql of hostile) {
      test(`${name}: ${JSON.stringify(sql)}`, () => {
        expect(classifySql(wrap(sql)).cls).toBe('denied')
      })
    }
  }
})
