import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeEach, describe, expect, it } from 'vitest'

import {
  clearConnection,
  connectionConfigPath,
  loadConnection,
  resolveTarget,
  saveConnection,
} from '../src/core/connection-store'
import { CliError, isCliError } from '../src/core/errors'

const KEY = `dblab_ab12cd34_${'A'.repeat(43)}`

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'dblab-cli-store-'))
})

/** 先建出目录，再手工塞进一份坏内容，模拟「文件被人动过」。 */
async function writeRaw(json: string): Promise<void> {
  await saveConnection(home, { url: 'http://localhost:4000/mcp', key: KEY })
  await writeFile(connectionConfigPath(home), json, 'utf8')
}

async function expectCliError(promise: Promise<unknown>): Promise<CliError> {
  const caught = await promise.catch((error: unknown) => error)
  expect(isCliError(caught)).toBe(true)
  return caught as CliError
}

describe('saveConnection / loadConnection', () => {
  it('原样往返，并把地址归一化成完整的 /mcp', async () => {
    await saveConnection(home, { url: 'http://localhost:4000', key: KEY })
    const stored = await loadConnection(home)

    expect(stored).not.toBeNull()
    expect(stored?.url).toBe('http://localhost:4000/mcp')
    expect(stored?.key).toBe(KEY)
    expect(stored?.updatedAt).not.toBe('')
  })

  it('落在 ~/.dblab/config.json', async () => {
    await saveConnection(home, { url: 'http://localhost:4000/mcp', key: KEY })
    expect(connectionConfigPath(home)).toBe(join(home, '.dblab', 'config.json'))
    const raw = JSON.parse(await readFile(connectionConfigPath(home), 'utf8')) as { key: string }
    expect(raw.key).toBe(KEY)
  })

  it.skipIf(process.platform === 'win32')('落盘权限收到 0600', async () => {
    await saveConnection(home, { url: 'http://localhost:4000/mcp', key: KEY })
    expect(((await stat(connectionConfigPath(home))).mode & 0o777).toString(8)).toBe('600')
  })

  it('没有记录时返回 null', async () => {
    expect(await loadConnection(home)).toBeNull()
  })

  it('记录不是合法 JSON 时报错并指向文件', async () => {
    await writeRaw('{ 这不是 JSON\n')
    const error = await expectCliError(loadConnection(home))
    expect(error.message).toContain('连接记录无法使用')
    expect(error.message).toContain('config.json')
    expect(error.exitCode).toBe(2)
  })

  it('记录缺字段时报错，不静默当成没连过', async () => {
    await writeRaw(JSON.stringify({ version: 1, url: 'http://localhost:4000/mcp' }))
    const error = await expectCliError(loadConnection(home))
    expect(error.message).toContain('连接记录无法使用')
    expect(error.hint).toContain('缺少 url 或 key')
  })

  it('clearConnection 只在真有文件时算清掉', async () => {
    expect(await clearConnection(home)).toBe(false)
    await saveConnection(home, { url: 'http://localhost:4000/mcp', key: KEY })
    expect(await clearConnection(home)).toBe(true)
    expect(await loadConnection(home)).toBeNull()
  })
})

describe('resolveTarget', () => {
  it('--key 优先，地址不会被记录带跑', async () => {
    const other = `dblab_zzzzzzzz_${'B'.repeat(43)}`
    await saveConnection(home, { url: 'http://localhost:4100/mcp', key: other })

    const target = await resolveTarget({ homeDir: home, key: KEY })
    expect(target.apiKey).toBe(KEY)
    expect(target.source).toBe('flag')
    // 显式给了密钥却没给地址：维持默认的 compose 端口，
    // 免得换服务器时把授权悄悄打到记录那台上。
    expect(target.mcpUrl).toBe('http://localhost:18400/mcp')
  })

  it('省略 --key 时同时用记录里的密钥与地址', async () => {
    await saveConnection(home, { url: 'http://localhost:4100/mcp', key: KEY })

    const target = await resolveTarget({ homeDir: home })
    expect(target.apiKey).toBe(KEY)
    expect(target.mcpUrl).toBe('http://localhost:4100/mcp')
    expect(target.source).toBe('connection')
  })

  it('--url 显式覆盖记录里的地址', async () => {
    await saveConnection(home, { url: 'http://localhost:4100/mcp', key: KEY })
    const target = await resolveTarget({ homeDir: home, url: 'http://localhost:4000' })
    expect(target.mcpUrl).toBe('http://localhost:4000/mcp')
  })

  it('空串的 --key 不回落到记录', async () => {
    await saveConnection(home, { url: 'http://localhost:4100/mcp', key: KEY })
    expect((await expectCliError(resolveTarget({ homeDir: home, key: '  ' }))).message).toContain('密钥形态不对')
  })

  it('没有记录时教用户怎么建立记录', async () => {
    const error = await expectCliError(resolveTarget({ homeDir: home }))
    expect(error.message).toBe('缺少 --key')
    expect(error.hint).toContain('dblab connect')
    expect(error.hint).toContain(join('.dblab', 'config.json'))
  })
})
