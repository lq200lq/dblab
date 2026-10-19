/**
 * PostgreSQL 错误码判定。
 *
 * 必须沿 cause 链找：drizzle 会把驱动原始错误包一层再抛，
 * 只看最外层的 code 会全部漏掉（症状是「重名返回 500」这类错。
 */
function hasPgErrorCode(error: unknown, expected: string): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth++) {
    if ((current as { code?: unknown }).code === expected) return true
    current = (current as { cause?: unknown }).cause
  }
  return false
}

/** 唯一约束冲突（23505）。 */
export function isUniqueViolation(error: unknown): boolean {
  return hasPgErrorCode(error, '23505')
}

/** 外键约束冲突（23503）：引用了不存在的行。 */
export function isForeignKeyViolation(error: unknown): boolean {
  return hasPgErrorCode(error, '23503')
}
