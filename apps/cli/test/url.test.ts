import { describe, expect, it } from 'vitest'

import { CliError } from '../src/core/errors'
import { hostOfMcpUrl, normalizeMcpUrl } from '../src/core/url'

describe('normalizeMcpUrl', () => {
  it('补 scheme 与 /mcp', () => {
    expect(normalizeMcpUrl('localhost:4000')).toBe('http://localhost:4000/mcp')
    expect(normalizeMcpUrl('127.0.0.1:4000')).toBe('http://127.0.0.1:4000/mcp')
  })

  it('保留已有 scheme 与 /mcp 路径', () => {
    expect(normalizeMcpUrl('http://localhost:4000')).toBe('http://localhost:4000/mcp')
    expect(normalizeMcpUrl('http://localhost:4000/mcp')).toBe('http://localhost:4000/mcp')
    expect(normalizeMcpUrl('https://db.internal/mcp')).toBe('https://db.internal/mcp')
  })

  it('去掉多余尾斜杠与首尾空白', () => {
    expect(normalizeMcpUrl('  http://localhost:4000/  ')).toBe('http://localhost:4000/mcp')
    expect(normalizeMcpUrl('http://localhost:4000/mcp/')).toBe('http://localhost:4000/mcp')
  })

  it('拒绝非 http/https、查询串与错误路径', () => {
    expect(() => normalizeMcpUrl('ftp://host')).toThrow(CliError)
    expect(() => normalizeMcpUrl('http://host/mcp?x=1')).toThrow(CliError)
    expect(() => normalizeMcpUrl('http://host/other')).toThrow(CliError)
    expect(() => normalizeMcpUrl('')).toThrow(CliError)
  })

  it('hostOfMcpUrl 只取主机名', () => {
    expect(hostOfMcpUrl('http://localhost:4000/mcp')).toBe('localhost')
    expect(hostOfMcpUrl('https://db.internal:8443/mcp')).toBe('db.internal')
  })
})
