/**
 * 查询结果规范化。
 *
 * 不做这一步的后果很具体：`JSON.stringify` 遇到 BigInt 会**抛错**，
 * 而抛错发生在工具处理器里，Agent 侧看到的是「服务端坏了」而不是「工具失败了」。
 * 二进制同理——把 bytea 原始字节塞进 Agent 的上下文既没用又危险。
 */

const MAX_DEPTH = 8

export function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row)) {
    out[key] = normalizeValue(value)
  }
  return out
}

export function normalizeValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return null

  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'number') {
    // JSON 没有 NaN / Infinity 的表示，落到 null 比落成 null 字符串更不容易误导。
    return Number.isFinite(value) ? value : null
  }
  if (typeof value === 'string' || typeof value === 'boolean') return value

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString()
  }
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    return `<binary ${value.length} bytes>`
  }

  if (depth >= MAX_DEPTH) return '<max depth>'

  if (Array.isArray(value)) {
    return value.map((item) => normalizeValue(item, depth + 1))
  }

  if (typeof value === 'object') {
    const source = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const [key, nested] of Object.entries(source)) {
      out[key] = normalizeValue(nested, depth + 1)
    }
    return out
  }

  // 函数、symbol 等：JSON 表达不了，也不该出现在数据库结果里。
  return null
}
