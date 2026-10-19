import type { ErrorCode } from '../errors'

/** 语句分类：读、写、拒绝。拒绝是最重要的默认值。 */
export const SQL_CLASSES = ['read', 'write', 'denied'] as const
export type SqlClass = (typeof SQL_CLASSES)[number]

export const SQL_CLASS_LABEL: Record<SqlClass, string> = {
  read: '读',
  write: '写',
  denied: '拒绝',
}

export function isSqlClass(value: string): value is SqlClass {
  return (SQL_CLASSES as readonly string[]).includes(value)
}

export interface ClassifyResult {
  cls: SqlClass
  /** 首个关键字（大写）。空串表示没取到关键字，此时 cls 必为 denied。 */
  keyword: string
  /** cls 为 denied 时的具体原因；read/write 时为 undefined。 */
  code?: ErrorCode
  /** 命中的风险项，写进审计 detail，便于事后解释「为什么拒了」。 */
  notes: string[]
}
