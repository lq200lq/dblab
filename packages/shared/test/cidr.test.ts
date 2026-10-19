import { describe, expect, test } from 'vitest'

import { ipMatchesCidr, isIpAllowed, isValidCidrInput, parseCidr, parseIp } from '../src/net/cidr'

describe('parseIp', () => {
  test('IPv4', () => {
    expect(parseIp('127.0.0.1')?.version).toBe(4)
    expect(parseIp('255.255.255.255')?.bytes).toEqual(new Uint8Array([255, 255, 255, 255]))
  })

  test('IPv6 压缩与展开', () => {
    expect(parseIp('::1')?.bytes).toEqual(
      new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
    )
    expect(parseIp('2001:db8::1')?.version).toBe(6)
    expect(parseIp('[::1]')?.version).toBe(6)
    expect(parseIp('fe80::1%eth0')?.version).toBe(6)
    expect(parseIp('::ffff:127.0.0.1')?.bytes).toEqual(
      new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 127, 0, 0, 1]),
    )
  })

  test('非法输入返回 null', () => {
    expect(parseIp('')).toBeNull()
    expect(parseIp('not-an-ip')).toBeNull()
    expect(parseIp('256.0.0.1')).toBeNull()
    expect(parseIp('1.2.3')).toBeNull()
    expect(parseIp('1::2::3')).toBeNull()
    expect(parseIp('12345::1')).toBeNull()
    expect(parseIp('::::')).toBeNull()
  })
})

describe('parseCidr', () => {
  test('缺省前缀按主机位处理', () => {
    expect(parseCidr('10.0.0.1')?.prefix).toBe(32)
    expect(parseCidr('::1')?.prefix).toBe(128)
  })

  test('前缀越界或非数字即非法', () => {
    expect(parseCidr('10.0.0.0/33')).toBeNull()
    expect(parseCidr('::/129')).toBeNull()
    expect(parseCidr('10.0.0.0/')).toBeNull()
    expect(parseCidr('10.0.0.0/a')).toBeNull()
  })
})

describe('ipMatchesCidr', () => {
  const cases: Array<[string, string, boolean]> = [
    ['127.0.0.1', '127.0.0.1', true],
    ['127.0.0.1', '127.0.0.0/8', true],
    ['128.0.0.1', '127.0.0.0/8', false],
    ['10.1.2.3', '10.0.0.0/8', true],
    ['10.1.2.3', '0.0.0.0/0', true],
    ['10.1.2.3', '10.0.0.0/0', true],
    ['10.1.2.3', '10.0.0.0/7', true],
    ['11.1.2.3', '10.0.0.0/7', true],
    ['12.1.2.3', '10.0.0.0/7', false],
    ['10.1.2.3', '10.1.2.3/32', true],
    ['10.1.2.4', '10.1.2.3/32', false],
    ['::1', '::1', true],
    ['::1', '::1/128', true],
    ['::2', '::1/128', false],
    ['2001:db8::5', '2001:db8::/32', true],
    ['2001:db9::5', '2001:db8::/32', false],
    ['::ffff:127.0.0.1', '::ffff:127.0.0.0/104', true],
    ['::ffff:127.0.0.1', '::ffff:10.0.0.0/104', false],
    ['[::1]', '::1/128', true],
  ]

  for (const [ip, cidr, expected] of cases) {
    test(`${ip} in ${cidr} → ${expected}`, () => {
      expect(ipMatchesCidr(ip, cidr)).toBe(expected)
    })
  }

  test('版本不同一律不匹配', () => {
    expect(ipMatchesCidr('10.0.0.1', '::/0')).toBe(false)
    expect(ipMatchesCidr('::1', '0.0.0.0/0')).toBe(false)
  })

  test('任一侧非法即不匹配', () => {
    expect(ipMatchesCidr('not-an-ip', '0.0.0.0/0')).toBe(false)
    expect(ipMatchesCidr('10.0.0.1', 'garbage')).toBe(false)
  })
})

describe('isIpAllowed', () => {
  test('空白名单表示不限制', () => {
    expect(isIpAllowed('1.2.3.4', [])).toBe(true)
  })

  test('命中任一网段即放行', () => {
    expect(isIpAllowed('10.1.2.3', ['127.0.0.1', '10.0.0.0/8'])).toBe(true)
    expect(isIpAllowed('127.0.0.1', ['::1', '10.0.0.0/8'])).toBe(false)
  })

  test('非法条目被跳过，且不放大范围', () => {
    expect(isIpAllowed('10.1.2.3', ['garbage', '10.0.0.0/8'])).toBe(true)
    expect(isIpAllowed('10.1.2.3', ['garbage'])).toBe(false)
  })

  test('无法解析的调用来源视为不允许', () => {
    expect(isIpAllowed('not-an-ip', ['0.0.0.0/0'])).toBe(false)
  })
})

describe('isValidCidrInput', () => {
  test('合法', () => {
    expect(isValidCidrInput('10.0.0.0/8')).toBe(true)
    expect(isValidCidrInput('10.0.0.1')).toBe(true)
    expect(isValidCidrInput('::/0')).toBe(true)
    expect(isValidCidrInput('[::1]')).toBe(true)
    expect(isValidCidrInput('  127.0.0.1  ')).toBe(true)
  })

  test('非法', () => {
    expect(isValidCidrInput('999.0.0.0/8')).toBe(false)
    expect(isValidCidrInput('abc')).toBe(false)
    expect(isValidCidrInput('10.0.0.0/')).toBe(false)
    expect(isValidCidrInput('')).toBe(false)
  })
})
