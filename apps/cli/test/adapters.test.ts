import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { adapters, findAdapter } from '../src/adapters/registry'
import { buildEntry } from '../src/adapters/types'

const ENTRY = buildEntry('http://localhost:4000/mcp', `dblab_ab12cd34_${'A'.repeat(43)}`)

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'dblab-cli-home-'))
  // APPDATA 候选路径指向真实 AppData 会让「未安装」用例假绿，这里隔离掉。
  vi.stubEnv('APPDATA', join(home, '__appdata__'))
})

afterEach(() => {
  vi.unstubAllEnvs()
})

async function seed(relativePath: string, content: string): Promise<void> {
  const path = join(home, relativePath)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content, 'utf8')
}

describe('registry', () => {
  it('五个适配器 id 齐备且可查找', () => {
    expect(adapters.map((a) => a.id)).toEqual([
      'claude-code',
      'cursor',
      'codex',
      'qoder',
      'qoder-cn',
    ])
    expect(findAdapter('codex')?.displayName).toBe('Codex CLI')
  })
})

describe('未安装的空 home', () => {
  it('五个客户端都判定为未安装，且 excel 路径不报错', async () => {
    for (const adapter of adapters) {
      const result = await adapter.detect(home)
      expect(result.installed, adapter.id).toBe(false)
      expect(result.configExists, adapter.id).toBe(false)
      expect(result.malformed, adapter.id).toBeUndefined()
    }
  })
})

describe('JSON 系适配器', () => {
  const jsonCases: Array<{ id: string; file: string }> = [
    { id: 'claude-code', file: '.claude.json' },
    { id: 'cursor', file: '.cursor/mcp.json' },
    { id: 'qoder', file: '.qoder/settings.json' },
    { id: 'qoder-cn', file: '.qoder-cn/settings.json' },
  ]

  it.each(jsonCases)('$id：安装检测、写入幂等、删除恢复', async ({ id, file }) => {
    const adapter = findAdapter(id)!
    await seed(file, `${JSON.stringify({ theme: 'dark', mcpServers: { exa: { url: 'http://exa' } } }, null, 2)}\n`)

    const detected = await adapter.detect(home)
    expect(detected.installed).toBe(true)
    expect(detected.configExists).toBe(true)
    expect(detected.hasDblabEntry).toBe(false)

    const first = await adapter.write(home, ENTRY)
    expect(first.action).toBe('created')
    expect(first.backupPath).toBe(`${detected.configPath}.dblab.bak`)

    const parsed = JSON.parse(await readFile(detected.configPath, 'utf8')) as Record<string, unknown>
    expect((parsed.mcpServers as Record<string, unknown>).dblab).toEqual(ENTRY)
    expect((parsed.mcpServers as Record<string, unknown>).exa).toEqual({ url: 'http://exa' })
    expect(parsed.theme).toBe('dark')

    expect((await adapter.detect(home)).hasDblabEntry).toBe(true)

    const second = await adapter.write(home, ENTRY)
    expect(second.action).toBe('unchanged')

    const removed = await adapter.remove(home)
    expect(removed.removed).toBe(true)
    const after = JSON.parse(await readFile(detected.configPath, 'utf8')) as Record<string, unknown>
    expect((after.mcpServers as Record<string, unknown>).dblab).toBeUndefined()
    expect((after.mcpServers as Record<string, unknown>).exa).toEqual({ url: 'http://exa' })
  })

  it('目录存在但配置文件不存在时也算已安装，写入会新建文件', async () => {
    await mkdir(join(home, '.cursor'), { recursive: true })
    const adapter = findAdapter('cursor')!

    const detected = await adapter.detect(home)
    expect(detected.installed).toBe(true)
    expect(detected.configExists).toBe(false)

    const result = await adapter.write(home, ENTRY)
    expect(result.action).toBe('created')
    expect(result.backupPath).toBeUndefined()

    const parsed = JSON.parse(await readFile(detected.configPath, 'utf8')) as Record<string, unknown>
    expect((parsed.mcpServers as Record<string, unknown>).dblab).toEqual(ENTRY)
  })

  it('配置文件损坏时 detect 报 malformed，write 直接抛错且不改文件', async () => {
    await seed('.cursor/mcp.json', '{ broken')
    const adapter = findAdapter('cursor')!

    const detected = await adapter.detect(home)
    expect(detected.malformed).toBeDefined()

    await expect(adapter.write(home, ENTRY)).rejects.toThrow()
    expect(await readFile(join(home, '.cursor/mcp.json'), 'utf8')).toBe('{ broken')
  })
})

describe('Codex TOML 适配器', () => {
  it('写入只新增 dblab 段，其余逐字保留', async () => {
    const original = `model = "gpt-6-luna"\n\n[mcp_servers.memory4j]\nurl = "http://localhost:18080/mcp"\n\n[desktop]\nconversationDetailMode = "STEPS_COMMANDS"\n`
    await seed('.codex/config.toml', original)
    const adapter = findAdapter('codex')!

    const detected = await adapter.detect(home)
    expect(detected.installed).toBe(true)
    expect(detected.hasDblabEntry).toBe(false)

    const result = await adapter.write(home, ENTRY)
    expect(result.action).toBe('created')

    const written = await readFile(detected.configPath, 'utf8')
    expect(written).toContain('[mcp_servers.dblab]')
    expect(written).toContain('http_headers = { "Authorization" = "Bearer ')
    expect(written).toContain(`[mcp_servers.memory4j]\nurl = "http://localhost:18080/mcp"`)
    expect(written).toContain(`[desktop]\nconversationDetailMode = "STEPS_COMMANDS"`)

    expect((await adapter.write(home, ENTRY)).action).toBe('unchanged')

    const removed = await adapter.remove(home)
    expect(removed.removed).toBe(true)
    expect(await readFile(detected.configPath, 'utf8')).not.toContain('[mcp_servers.dblab]')
  })

  it('TOML 损坏时中止', async () => {
    await seed('.codex/config.toml', 'a = = 1')
    const adapter = findAdapter('codex')!
    expect((await adapter.detect(home)).malformed).toBeDefined()
    await expect(adapter.write(home, ENTRY)).rejects.toThrow()
  })
})
