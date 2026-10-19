import { describe, expect, test } from 'vitest'

import { normalizeRow, normalizeValue } from '../src/sql/normalize'

describe('结果规范化', () => {
  test('BigInt 变十进制字符串（否则 JSON.stringify 会在工具处理器里抛错）', () => {
    expect(normalizeValue(9007199254740993n)).toBe('9007199254740993')
    expect(() => JSON.stringify(normalizeValue(9007199254740993n))).not.toThrow()
  })

  test('Date 变 ISO，非法 Date 变 null', () => {
    expect(normalizeValue(new Date('2026-10-19T04:00:00.000Z'))).toBe('2026-10-19T04:00:00.000Z')
    expect(normalizeValue(new Date('nope'))).toBeNull()
  })

  test('NaN 与 Infinity 变 null（JSON 表达不了）', () => {
    expect(normalizeValue(Number.NaN)).toBeNull()
    expect(normalizeValue(Number.POSITIVE_INFINITY)).toBeNull()
    expect(normalizeValue(Number.NEGATIVE_INFINITY)).toBeNull()
  })

  test('二进制只留长度描述，不把原始字节塞进上下文', () => {
    expect(normalizeValue(Buffer.from([1, 2, 3, 4]))).toBe('<binary 4 bytes>')
    expect(normalizeValue(new Uint8Array([1, 2]))).toBe('<binary 2 bytes>')
  })

  test('数值字符串原样保留（pg 的 numeric 回来就是字符串）', () => {
    expect(normalizeValue('1234567890123456789.0123456789')).toBe('1234567890123456789.0123456789')
  })

  test('undefined 与函数变 null', () => {
    expect(normalizeValue(undefined)).toBeNull()
    expect(normalizeValue(() => 1)).toBeNull()
  })

  test('嵌套对象与数组递归处理', () => {
    const row = normalizeRow({
      id: 1n,
      meta: { at: new Date('2026-01-02T03:04:05.000Z'), blob: Buffer.from([9]), ratio: Number.NaN },
      tags: ['a', 2n, null],
    })
    expect(row).toEqual({
      id: '1',
      meta: { at: '2026-01-02T03:04:05.000Z', blob: '<binary 1 bytes>', ratio: null },
      tags: ['a', '2', null],
    })
    expect(() => JSON.stringify(row)).not.toThrow()
  })

  test('超深嵌套截断，不做无界递归', () => {
    let deep: unknown = 1n
    for (let i = 0; i < 20; i++) deep = { nested: deep }
    expect(JSON.stringify(normalizeValue(deep))).toContain('<max depth>')
  })

  test('规范化后的对象可以安全序列化', () => {
    const row = normalizeRow({ big: 12345678901234567890n, when: new Date(), blobs: [Buffer.from([1])] })
    expect(() => JSON.stringify(row)).not.toThrow()
  })
})
