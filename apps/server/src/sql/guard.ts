import type { ErrorCode, QueryResult, SqlClass } from '@dblab/shared'
import { classifySql } from '@dblab/shared'

import { DriverError, type DriverAdapter, type ExecuteOptions } from '../datasource/adapters/types'

/** 工具语义：query 只收读语句，execute 两者都收（但都要有对应授权）。 */
export type GuardMode = 'query' | 'execute'

export interface GuardGrant {
  canRead: boolean
  canWrite: boolean
}

export interface GuardRequest {
  adapter: DriverAdapter
  /** 该密钥在这个数据源上的授权；没有授权行时为 undefined。 */
  grant: GuardGrant | undefined
  mode: GuardMode
  maxSqlBytes: number
  maxRows: number
  statementTimeoutMs: number
}

/**
 * 三种结局，正好对应审计里的三个字段：
 * ok → decision=granted；denied → decision=denied + denial_reason；failed → decision=granted + error_code。
 */
export type GuardOutcome =
  | { status: 'ok'; classification: 'read' | 'write'; keyword: string; result: QueryResult }
  | {
      status: 'denied'
      classification: SqlClass
      code: ErrorCode
      keyword: string
      notes: string[]
    }
  | {
      status: 'failed'
      classification: 'read' | 'write'
      code: ErrorCode
      keyword: string
      message: string
      notes: string[]
    }

/**
 * 语句闸门：分类 → 判授权 → 在正确的执行通道里跑。
 *
 * 注意读与写的授权是**按分类**判的，不是按工具判的：
 * 否则「有写权限但没读权限」的密钥可以拿 execute 跑 SELECT 把数据读走。
 */
export async function runGuardedSql(request: GuardRequest, sql: string): Promise<GuardOutcome> {
  const classified = classifySql(sql, { maxBytes: request.maxSqlBytes })

  if (classified.cls === 'denied') {
    return {
      status: 'denied',
      classification: 'denied',
      code: classified.code ?? 'UNKNOWN_STATEMENT',
      keyword: classified.keyword,
      notes: classified.notes,
    }
  }

  const isWrite = classified.cls === 'write'

  if (isWrite) {
    // query 工具只收读语句：给个明确的方向，而不是让它去猜为什么写不了。
    if (request.mode === 'query') {
      return {
        status: 'denied',
        classification: 'write',
        code: 'WRITE_STATEMENT_IN_READ_TOOL',
        keyword: classified.keyword,
        notes: classified.notes,
      }
    }
    if (!request.grant?.canWrite) {
      return {
        status: 'denied',
        classification: 'write',
        code: 'NO_WRITE_GRANT',
        keyword: classified.keyword,
        notes: classified.notes,
      }
    }
  } else if (!request.grant?.canRead) {
    return {
      status: 'denied',
      classification: 'read',
      code: 'NO_READ_GRANT',
      keyword: classified.keyword,
      notes: classified.notes,
    }
  }

  const options: ExecuteOptions = {
    maxRows: request.maxRows,
    statementTimeoutMs: request.statementTimeoutMs,
  }

  try {
    const result = isWrite
      ? await request.adapter.executeWrite(sql, options)
      : await request.adapter.executeRead(sql, options)
    return {
      status: 'ok',
      classification: isWrite ? 'write' : 'read',
      keyword: classified.keyword,
      result,
    }
  } catch (error) {
    const classification = isWrite ? 'write' : 'read'
    if (error instanceof DriverError) {
      return {
        status: 'failed',
        classification,
        code: error.code,
        keyword: classified.keyword,
        message: error.message,
        notes: classified.notes,
      }
    }
    return {
      status: 'failed',
      classification,
      code: 'QUERY_FAILED',
      keyword: classified.keyword,
      message: '语句执行失败',
      notes: classified.notes,
    }
  }
}
