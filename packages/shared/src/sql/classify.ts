import type { ErrorCode } from '../errors'

import type { ClassifyResult, SqlClass } from './class'

/**
 * SQL 语句分类闸门。
 *
 * 这里只是**快速过滤层**，不是安全边界：真正的兜底是读路径上的只读事务
 * （PG 的 BEGIN TRANSACTION READ ONLY / MySQL 的 SET TRANSACTION READ ONLY）。
 * 分类器只负责「默认拒绝、快速失败」，凡是拿不准的一律归 denied。
 *
 * 掩码策略（决定误判方向的关键）：
 * - `--` 只有后接空白或行尾才算注释（MySQL 的规则）。PG 会更宽松地当注释，
 *   但那会让 `SELECT 1 --2; DROP TABLE t` 这类输入被整段掩掉，
 *   PG 实际会把 `; DROP TABLE t` 当第二条语句执行——所以这里选**掩得更少**的一侧，
 *   宁可把没掩掉的部分判成多语句而拒绝，也不放过。
 * - 字符串不把 `\` 当转义（PG standard_conforming_strings=on 的语义），同样是掩得更少的一侧。
 * - 块注释按 PG 的嵌套规则处理。
 * - 双引号标识符与反引号标识符整体掩掉：它们内部的分号与关键字不是语法结构
 *   （否则表名里带 `;` 会误判成多语句）。
 */

export interface ClassifyOptions {
  /** 语句字节数上限（UTF-8）。默认 100000。 */
  maxBytes?: number
}

const DEFAULT_MAX_BYTES = 100_000

/** 只读语句的首关键字。 */
const READ_KEYWORDS = new Set(['SELECT', 'EXPLAIN', 'SHOW', 'TABLE', 'VALUES', 'DESCRIBE', 'DESC'])

/** 数据变更首关键字。 */
const WRITE_KEYWORDS = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'REPLACE', 'UPSERT'])

/** 结构变更与平台明令禁止的首关键字。 */
const DDL_KEYWORDS = new Set([
  'CREATE',
  'ALTER',
  'DROP',
  'TRUNCATE',
  'GRANT',
  'REVOKE',
  'COMMENT',
  'RENAME',
  'VACUUM',
  'ANALYZE',
  'ANALYSE',
  'CLUSTER',
  'REINDEX',
  'REFRESH',
  'COPY',
  'IMPORT',
  'SECURITY',
  'CHECKPOINT',
  'DO',
  'CALL',
  'PREPARE',
  'EXECUTE',
  'DEALLOCATE',
  'DECLARE',
  'LISTEN',
  'NOTIFY',
  'UNLISTEN',
  'INSTALL',
  'UNINSTALL',
  'HANDLER',
])

/** 事务与执行控制：事务由平台自己开，客户端不许插手，SET 也不许。 */
const TRANSACTION_KEYWORDS = new Set([
  'BEGIN',
  'START',
  'END',
  'COMMIT',
  'ROLLBACK',
  'ABORT',
  'SAVEPOINT',
  'RELEASE',
  'SET',
  'RESET',
  'DISCARD',
  'LOCK',
  'UNLOCK',
  'LOAD',
  'FLUSH',
  'KILL',
  'SHUTDOWN',
])

/** 危险项：文件读写、外部连接、副作用函数。出现在语句任何位置都拒。 */
const HAZARD_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\boutfile\b/i, 'into-outfile'],
  [/\bdumpfile\b/i, 'into-dumpfile'],
  [/\bload_file\b/i, 'load-file'],
  [/\bload\s+data\b/i, 'load-data'],
  [/\bdblink\b/i, 'dblink'],
  [/\blo_import\b/i, 'lo-import'],
  [/\blo_export\b/i, 'lo-export'],
  [/\bpg_read_file\b/i, 'pg-read-file'],
  [/\bpg_read_binary_file\b/i, 'pg-read-binary-file'],
  [/\bpg_ls_dir\b/i, 'pg-ls-dir'],
  [/\bpg_sleep\b/i, 'pg-sleep'],
  [/\bxp_cmdshell\b/i, 'xp-cmdshell'],
]

/** 读语句上额外的风险项：只读授权不该拿写锁。 */
const READ_ONLY_HAZARD_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bfor\s+update\b/i, 'select-for-update'],
  [/\bfor\s+no\s+key\s+update\b/i, 'select-for-update'],
  [/\bfor\s+share\b/i, 'select-for-share'],
  [/\bfor\s+key\s+share\b/i, 'select-for-share'],
  [/\block\s+in\s+share\s+mode\b/i, 'lock-in-share-mode'],
]

const WORD_AT_START = /^[A-Za-z_][A-Za-z0-9_$]*/

function denied(keyword: string, code: ErrorCode, notes: string[]): ClassifyResult {
  return { cls: 'denied', keyword, code, notes }
}

function utf8ByteLength(input: string): number {
  let bytes = 0
  for (const ch of input) {
    const cp = ch.codePointAt(0) ?? 0
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4
  }
  return bytes
}

/** 把注释、字符串、带引号标识符整体掩成空白，只留下语法骨架。 */
function maskNonCode(input: string): string {
  const out: string[] = []
  const n = input.length
  let i = 0
  let blockDepth = 0

  const pushSpaces = (count: number): void => {
    for (let k = 0; k < count; k++) out.push(' ')
  }

  while (i < n) {
    const ch = input.charAt(i)
    const next = input.charAt(i + 1)

    if (blockDepth > 0) {
      if (ch === '/' && next === '*') {
        blockDepth++
        pushSpaces(2)
        i += 2
        continue
      }
      if (ch === '*' && next === '/') {
        blockDepth--
        pushSpaces(2)
        i += 2
        continue
      }
      pushSpaces(1)
      i++
      continue
    }

    // 行注释：`--` 后必须是空白或行尾，见文件头「掩码策略」。
    if (ch === '-' && next === '-' && (i + 2 >= n || /[\s]/.test(input.charAt(i + 2)))) {
      while (i < n && input.charAt(i) !== '\n') {
        pushSpaces(1)
        i++
      }
      continue
    }

    // `#` 是 MySQL 的行注释；PG 会直接报语法错，掩掉不影响安全。
    if (ch === '#') {
      while (i < n && input.charAt(i) !== '\n') {
        pushSpaces(1)
        i++
      }
      continue
    }

    if (ch === '/' && next === '*') {
      blockDepth = 1
      pushSpaces(2)
      i += 2
      continue
    }

    // 单引号字符串：`''` 是转义，`\` 不是转义。
    if (ch === "'") {
      pushSpaces(1)
      i++
      while (i < n) {
        if (input.charAt(i) === "'") {
          if (input.charAt(i + 1) === "'") {
            pushSpaces(2)
            i += 2
            continue
          }
          break
        }
        pushSpaces(1)
        i++
      }
      if (i < n) {
        pushSpaces(1)
        i++
      }
      continue
    }

    // 带引号标识符（"..." / `...`）：整体掩掉。MySQL 里 " 是字符串、` 是标识符，
    // 两者内部都不是语法结构，掩掉即可。
    if (ch === '"' || ch === '`') {
      const quote = ch
      pushSpaces(1)
      i++
      while (i < n) {
        if (input.charAt(i) === quote) {
          if (input.charAt(i + 1) === quote) {
            pushSpaces(2)
            i += 2
            continue
          }
          break
        }
        pushSpaces(1)
        i++
      }
      if (i < n) {
        pushSpaces(1)
        i++
      }
      continue
    }

    // PostgreSQL 的美元引用：$$...$$ 或 $tag$...$tag$。$1 这类占位符不匹配（tag 必须以字母/下划线开头）。
    if (ch === '$') {
      const rest = input.slice(i)
      const open = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(rest)
      if (open) {
        const tag = open[0]
        const end = input.indexOf(tag, i + tag.length)
        const stop = end === -1 ? n : end + tag.length
        pushSpaces(stop - i)
        i = stop
        continue
      }
    }

    out.push(ch)
    i++
  }

  return out.join('')
}

/** 取掩码文本里的词（大写），跳过空白与括号等非字母开头字符。 */
function wordAt(text: string, index: number): { word: string; end: number } | null {
  const m = WORD_AT_START.exec(text.slice(index))
  if (!m) return null
  return { word: m[0].toUpperCase(), end: index + m[0].length }
}

function isStatementKeyword(word: string): boolean {
  return (
    READ_KEYWORDS.has(word) ||
    WRITE_KEYWORDS.has(word) ||
    DDL_KEYWORDS.has(word) ||
    TRANSACTION_KEYWORDS.has(word) ||
    word === 'WITH'
  )
}

/**
 * WITH 之后找「最外层真正的首关键字」：CTE 定义都在括号里，跳过括号深度大于 0 的部分，
 * 深度回到 0 后遇到的第一个语句关键字就是最终语句（可能是 SELECT，也可能是 INSERT 等）。
 */
function outerKeywordAfterWith(text: string, from: number): string | null {
  let depth = 0
  let i = from
  const n = text.length
  while (i < n) {
    const ch = text.charAt(i)
    if (ch === '(') {
      depth++
      i++
      continue
    }
    if (ch === ')') {
      if (depth > 0) depth--
      i++
      continue
    }
    if (depth === 0 && /[A-Za-z_]/.test(ch)) {
      const got = wordAt(text, i)
      if (got) {
        if (isStatementKeyword(got.word) && got.word !== 'WITH') return got.word
        i = got.end
        continue
      }
    }
    i++
  }
  return null
}

function splitStatements(masked: string): string[] {
  return masked
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

function firstHazardMatch(
  patterns: ReadonlyArray<readonly [RegExp, string]>,
  text: string,
): string | null {
  for (const [re, note] of patterns) {
    if (re.test(text)) return note
  }
  return null
}

export function classifySql(sql: string, options: ClassifyOptions = {}): ClassifyResult {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES

  if (sql.includes('\u0000')) {
    return denied('', 'HAZARD_STATEMENT_FORBIDDEN', ['nul-byte'])
  }

  if (utf8ByteLength(sql) > maxBytes) {
    return denied('', 'SQL_TOO_LARGE', [`bytes>${maxBytes}`])
  }

  const masked = maskNonCode(sql)

  if (masked.includes('\u0000')) {
    return denied('', 'HAZARD_STATEMENT_FORBIDDEN', ['nul-byte'])
  }

  const statements = splitStatements(masked)
  if (statements.length === 0) {
    return denied('', 'EMPTY_STATEMENT', [])
  }
  if (statements.length > 1) {
    return denied('', 'MULTI_STATEMENT_FORBIDDEN', [`statements=${statements.length}`])
  }

  const only = statements[0] as string

  // 允许被括号包裹的只读语句，如 `(SELECT 1)`；括号后的关键字仍需是语句关键字。
  let probe = only
  while (probe.startsWith('(')) probe = probe.slice(1).trimStart()

  const first = wordAt(probe, 0)
  if (!first) {
    return denied('', 'UNKNOWN_STATEMENT', ['no-leading-keyword'])
  }
  const keyword = first.word

  // 危险项与首关键字无关，先扫一遍全文。
  const hazard = firstHazardMatch(HAZARD_PATTERNS, masked)
  if (hazard) {
    return denied(keyword, 'HAZARD_STATEMENT_FORBIDDEN', [hazard])
  }

  let cls: SqlClass
  if (keyword === 'WITH') {
    const outer = outerKeywordAfterWith(masked, first.end)
    if (!outer) {
      return denied(keyword, 'UNKNOWN_STATEMENT', ['with-without-statement'])
    }
    if (DDL_KEYWORDS.has(outer)) return denied(outer, 'DDL_FORBIDDEN', ['ddl-keyword'])
    if (TRANSACTION_KEYWORDS.has(outer)) {
      return denied(outer, 'TRANSACTION_CONTROL_FORBIDDEN', ['transaction-keyword'])
    }
    cls = WRITE_KEYWORDS.has(outer) ? 'write' : 'read'
  } else if (DDL_KEYWORDS.has(keyword)) {
    return denied(keyword, 'DDL_FORBIDDEN', ['ddl-keyword'])
  } else if (TRANSACTION_KEYWORDS.has(keyword)) {
    return denied(keyword, 'TRANSACTION_CONTROL_FORBIDDEN', ['transaction-keyword'])
  } else if (WRITE_KEYWORDS.has(keyword)) {
    cls = 'write'
  } else if (READ_KEYWORDS.has(keyword)) {
    cls = 'read'
  } else {
    return denied(keyword, 'UNKNOWN_STATEMENT', ['unknown-keyword'])
  }

  if (cls === 'read') {
    // 数据结构变更类 CTE（WITH x AS (INSERT ...) SELECT ...）在 PG 里是真的会写数据。
    // 只认「左括号后紧跟数据变更关键字」这一种形状：不能用「全文出现 UPDATE 就算写」，
    // 否则 `SELECT ... FOR UPDATE` 会被误判成写。
    const cteWrite = findParenthesizedWriteKeyword(masked)
    if (cteWrite) {
      return { cls: 'write', keyword: cteWrite, notes: ['data-modifying-cte'] }
    }

    // SELECT ... INTO（含 MySQL 的 INTO OUTFILE，上面已拦）会建表或写文件。
    if (/\binto\b/i.test(masked)) {
      return denied(keyword, 'HAZARD_STATEMENT_FORBIDDEN', ['select-into'])
    }

    const readHazard = firstHazardMatch(READ_ONLY_HAZARD_PATTERNS, masked)
    if (readHazard) {
      return denied(keyword, 'HAZARD_STATEMENT_FORBIDDEN', [readHazard])
    }
  }

  return { cls, keyword, notes: [] }
}

/** 找 `( INSERT|UPDATE|DELETE|MERGE|REPLACE ...` 这种形状：CTE 体内的数据变更语句。 */
function findParenthesizedWriteKeyword(text: string): string | null {
  const n = text.length
  for (let i = 0; i < n; i++) {
    if (text.charAt(i) !== '(') continue
    let j = i + 1
    while (j < n && /\s/.test(text.charAt(j))) j++
    const got = wordAt(text, j)
    if (got && WRITE_KEYWORDS.has(got.word)) return got.word
  }
  return null
}
