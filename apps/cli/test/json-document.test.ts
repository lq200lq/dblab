import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeEach, describe, expect, it } from 'vitest'

import { MalformedConfigError } from '../src/core/errors'
import {
  loadJsonDoc,
  removeMcpServer,
  serializeJsonDoc,
  upsertMcpServer,
} from '../src/adapters/json-document'
import type { McpEntry } from '../src/adapters/types'

const ENTRY: McpEntry = {
  type: 'http',
  url: 'http://localhost:4000/mcp',
  headers: { Authorization: 'Bearer dblab_ab12cd34_x' },
}

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dblab-cli-json-'))
})

describe('loadJsonDoc', () => {
  it('文件不存在返回 null', async () => {
    expect(await loadJsonDoc(join(dir, 'none.json'))).toBeNull()
  })

  it('损坏的 JSON 抛 MalformedConfigError', async () => {
    const path = join(dir, 'bad.json')
    await writeFile(path, '{ "mcpServers": ', 'utf8')
    await expect(loadJsonDoc(path)).rejects.toBeInstanceOf(MalformedConfigError)
  })

  it('顶层不是对象也抛错', async () => {
    const path = join(dir, 'arr.json')
    await writeFile(path, '[1,2,3]', 'utf8')
    await expect(loadJsonDoc(path)).rejects.toBeInstanceOf(MalformedConfigError)
  })
})

describe('upsertMcpServer', () => {
  it('保留同级条目与顶层其它键', async () => {
    const path = join(dir, 'config.json')
    const original = `${JSON.stringify(
      {
        theme: 'dark',
        mcpServers: { memory4j: { type: 'http', url: 'http://localhost:18080/mcp' } },
      },
      null,
      2,
    )}\n`
    await writeFile(path, original, 'utf8')

    const doc = (await loadJsonDoc(path))!
    const { doc: next, action } = upsertMcpServer(doc, 'dblab', ENTRY)
    expect(action).toBe('created')

    const written = serializeJsonDoc(next)
    const parsed = JSON.parse(written) as Record<string, unknown>
    expect((parsed.mcpServers as Record<string, unknown>).memory4j).toEqual({
      type: 'http',
      url: 'http://localhost:18080/mcp',
    })
    expect(parsed.theme).toBe('dark')
    expect((parsed.mcpServers as Record<string, unknown>).dblab).toEqual(ENTRY)
    expect(written.endsWith('\n')).toBe(true)
  })

  it('二次写入内容一致时返回 unchanged 且文本不变', async () => {
    const path = join(dir, 'config.json')
    await writeFile(path, '{}\n', 'utf8')

    const doc = (await loadJsonDoc(path))!
    const first = upsertMcpServer(doc, 'dblab', ENTRY)
    const second = upsertMcpServer(first.doc, 'dblab', ENTRY)
    expect(second.action).toBe('unchanged')
    expect(second.doc).toBe(first.doc)
  })

  it('已有 dblab 但 url 变化时走 updated', () => {
    const doc = {
      path: 'x',
      text: '',
      data: { mcpServers: { dblab: { ...ENTRY, url: 'http://old/mcp' } } },
      indent: '  ',
      eol: '\n' as const,
      trailingNewline: true,
    }
    const result = upsertMcpServer(doc, 'dblab', ENTRY)
    expect(result.action).toBe('updated')
  })
})

describe('缩进、换行与末尾换行保留', () => {
  it('4 空格缩进保留', async () => {
    const path = join(dir, 'four.json')
    await writeFile(path, `{\n    "mcpServers": {}\n}\n`, 'utf8')
    const doc = (await loadJsonDoc(path))!
    const { doc: next } = upsertMcpServer(doc, 'dblab', ENTRY)
    const written = serializeJsonDoc(next)
    expect(written).toContain('\n    "mcpServers"')
  })

  it('CRLF 与无末尾换行保留', async () => {
    const path = join(dir, 'crlf.json')
    await writeFile(path, '{\r\n  "mcpServers": {}\r\n}', 'utf8')
    const doc = (await loadJsonDoc(path))!
    expect(doc.eol).toBe('\r\n')
    expect(doc.trailingNewline).toBe(false)

    const { doc: next } = upsertMcpServer(doc, 'dblab', ENTRY)
    const written = serializeJsonDoc(next)
    expect(written.includes('\r\n')).toBe(true)
    expect(written.endsWith('\n')).toBe(false)
    expect(written.includes('\n\n')).toBe(false)
  })
})

describe('removeMcpServer', () => {
  it('只摘掉 dblab，其余保留', async () => {
    const path = join(dir, 'config.json')
    await writeFile(
      path,
      `${JSON.stringify({ mcpServers: { dblab: ENTRY, exa: { url: 'http://exa' } } }, null, 2)}\n`,
      'utf8',
    )
    const doc = (await loadJsonDoc(path))!
    const { doc: next, removed } = removeMcpServer(doc, 'dblab')
    expect(removed).toBe(true)

    const parsed = JSON.parse(serializeJsonDoc(next)) as Record<string, Record<string, unknown>>
    expect(parsed.mcpServers).toEqual({ exa: { url: 'http://exa' } })
  })

  it('没有该条目时不动', async () => {
    const path = join(dir, 'config.json')
    await writeFile(path, '{}\n', 'utf8')
    const doc = (await loadJsonDoc(path))!
    expect(removeMcpServer(doc, 'dblab').removed).toBe(false)
  })
})

describe('读文件后写回不产生额外改动', () => {
  it('未改动的文件序列化后与原文一致', async () => {
    const content = `${JSON.stringify({ a: 1, mcpServers: { dblab: ENTRY } }, null, 2)}\n`
    const path = join(dir, 'same.json')
    await writeFile(path, content, 'utf8')
    const doc = (await loadJsonDoc(path))!
    expect(serializeJsonDoc(doc)).toBe(content)
    expect(await readFile(path, 'utf8')).toBe(content)
  })
})
