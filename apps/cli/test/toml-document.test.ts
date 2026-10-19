import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeEach, describe, expect, it } from 'vitest'
import { parse as parseToml } from 'smol-toml'

import { MalformedConfigError } from '../src/core/errors'
import {
  hasTomlServer,
  loadTomlDoc,
  removeTomlServer,
  upsertTomlServer,
} from '../src/adapters/toml-document'
import type { McpEntry } from '../src/adapters/types'

const ENTRY: McpEntry = {
  type: 'http',
  url: 'http://localhost:4000/mcp',
  headers: { Authorization: 'Bearer dblab_ab12cd34_x' },
}

const SAMPLE = `model = "gpt-6-luna"

[mcp_servers]

[mcp_servers.codegraph]
command = "codegraph"
args = ["serve", "--mcp"]

[mcp_servers.memory4j]
url = "http://localhost:18080/mcp"
http_headers = { "X-Memory4J-Principal-Id" = "liuqi" }

[desktop]
conversationDetailMode = "STEPS_COMMANDS"
`

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dblab-cli-toml-'))
})

async function docFrom(text: string) {
  const path = join(dir, 'config.toml')
  await writeFile(path, text, 'utf8')
  return (await loadTomlDoc(path))!
}

describe('loadTomlDoc', () => {
  it('不存在返回 null，损坏抛 MalformedConfigError', async () => {
    expect(await loadTomlDoc(join(dir, 'none.toml'))).toBeNull()
    const path = join(dir, 'bad.toml')
    await writeFile(path, 'a = = 1', 'utf8')
    await expect(loadTomlDoc(path)).rejects.toBeInstanceOf(MalformedConfigError)
  })
})

describe('upsertTomlServer', () => {
  it('插入新段且不动其它内容', async () => {
    const doc = await docFrom(SAMPLE)
    const { doc: next, action } = upsertTomlServer(doc, 'dblab', ENTRY)
    expect(action).toBe('created')

    expect(next.text).toContain('[mcp_servers.dblab]')
    // 无关段落逐字保留
    expect(next.text).toContain('[mcp_servers.codegraph]\ncommand = "codegraph"')
    expect(next.text).toContain('[mcp_servers.memory4j]\nurl = "http://localhost:18080/mcp"')
    expect(next.text).toContain('[desktop]\nconversationDetailMode = "STEPS_COMMANDS"')
    expect(next.text.startsWith('model = "gpt-6-luna"\n')).toBe(true)
  })

  it('只替换 dblab 段，不碰相邻段', async () => {
    const doc = await docFrom(SAMPLE)
    const first = upsertTomlServer(doc, 'dblab', ENTRY).doc
    const changed = upsertTomlServer(first, 'dblab', { ...ENTRY, url: 'http://other:5000/mcp' })
    expect(changed.action).toBe('updated')
    expect(changed.doc.text).toContain('url = "http://other:5000/mcp"')
    expect(changed.doc.text).toContain('[desktop]')
    expect(changed.doc.text.match(/\[mcp_servers\.dblab\]/g)).toHaveLength(1)
  })

  it('内容一致时返回 unchanged', async () => {
    const doc = await docFrom(SAMPLE)
    const first = upsertTomlServer(doc, 'dblab', ENTRY).doc
    expect(upsertTomlServer(first, 'dblab', ENTRY).action).toBe('unchanged')
  })

  it('吞掉已有的 dblab 子表', async () => {
    const withSub = `${SAMPLE}\n[mcp_servers.dblab]\nurl = "http://old/mcp"\n\n[mcp_servers.dblab.env]\nFOO = "1"\n`
    const doc = await docFrom(withSub)
    const { doc: next } = upsertTomlServer(doc, 'dblab', ENTRY)
    expect(next.text).not.toContain('FOO')
    expect(next.text.match(/\[mcp_servers\.dblab\]/g)).toHaveLength(1)
  })

  it('mcp_servers 是内联表时拒绝写入', async () => {
    const doc = await docFrom('mcp_servers = { a = { url = "http://a" } }\n')
    expect(() => upsertTomlServer(doc, 'dblab', ENTRY)).toThrow(/内联表/)
  })

  it('转义 URL 与头里的引号（用真实 TOML 解析器回读）', async () => {
    const doc = await docFrom(SAMPLE)
    const tricky: McpEntry = {
      type: 'http',
      url: 'http://localhost:4000/mcp',
      headers: { Authorization: 'Bearer a"b\\c' },
    }
    const { doc: next } = upsertTomlServer(doc, 'dblab', tricky)

    // 写出来的必须是合法 TOML，且值能原样读回——这是「别让 Agent 端解析失败」的底线。
    const parsed = parseToml(next.text) as {
      mcp_servers: { dblab: { url: string; http_headers: Record<string, string> } }
    }
    expect(parsed.mcp_servers.dblab.url).toBe(tricky.url)
    expect(parsed.mcp_servers.dblab.http_headers.Authorization).toBe(tricky.headers.Authorization)
  })

  it('CRLF 文件保留 CRLF', async () => {
    const doc = await docFrom('model = "x"\r\n[mcp_servers]\r\n')
    const { doc: next } = upsertTomlServer(doc, 'dblab', ENTRY)
    expect(next.text.includes('\r\n')).toBe(true)
    expect(next.text.includes('\n\n')).toBe(false)
  })
})

describe('removeTomlServer', () => {
  it('删掉 dblab 段并保留 memory4j', async () => {
    const doc = await docFrom(SAMPLE)
    const written = upsertTomlServer(doc, 'dblab', ENTRY).doc
    const { doc: next, removed } = removeTomlServer(written, 'dblab')
    expect(removed).toBe(true)
    expect(hasTomlServer(next, 'dblab')).toBe(false)
    expect(next.text).toContain('[mcp_servers.memory4j]')
    expect(next.text).toContain('[desktop]')
  })

  it('没有该段时不动', async () => {
    const doc = await docFrom(SAMPLE)
    expect(removeTomlServer(doc, 'dblab').removed).toBe(false)
  })
})
