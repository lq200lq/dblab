import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { main, type MainOptions } from '../src/cli'
import { runSetup } from '../src/commands/setup'
import type { CommandContext } from '../src/commands/shared'
import { loadConnection, saveConnection } from '../src/core/connection-store'
import { createOutput } from '../src/core/output'
import type { Prompts } from '../src/core/prompts'
import { CLI_VERSION } from '../src/core/version'

const KEY = `dblab_ab12cd34_${'A'.repeat(43)}`
const URL = 'http://localhost:4000'

function collector(): { stream: NodeJS.WritableStream; text: () => string } {
  const chunks: string[] = []
  return {
    stream: {
      write: (chunk: string) => (chunks.push(chunk), true),
    } as unknown as NodeJS.WritableStream,
    text: () => chunks.join(''),
  }
}

/** 命令层的输出统一收进内存，避免污染测试进程的 stdout。 */
async function run(argv: string[], extra: Partial<MainOptions> = {}) {
  const stdout = collector()
  const stderr = collector()
  const code = await main(argv, {
    stdout: stdout.stream,
    stderr: stderr.stream,
    homeDir: home,
    color: false,
    ...extra,
  })
  return { code, stdout: stdout.text(), stderr: stderr.text() }
}

function okFetch() {
  const impl = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'DELETE') return new Response(null, { status: 204 })
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: { serverInfo: { name: 'dblab', version: '0.1.0' } },
      }),
      { status: 200, headers: { 'content-type': 'application/json', 'mcp-session-id': 's1' } },
    )
  }) as unknown as typeof fetch
  return impl
}

const rejectWith = (status: number): typeof fetch =>
  (async () => new Response('{}', { status })) as unknown as typeof fetch

interface McpCall {
  method: string
  url: string
  sessionId?: string | null
}

/**
 * 假 /mcp：走完 initialize → notifications/initialized → tools/call 三段，
 * 并记下每一步带的会话头——工具调用必须带上 initialize 回的那个 id。
 */
function fakeMcpDatasources(
  items: Array<Record<string, unknown>>,
  options: { initStatus?: number; omitStructured?: boolean } = {},
) {
  const calls: McpCall[] = []
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'DELETE') return new Response(null, { status: 204 })

    const body = JSON.parse(String(init?.body)) as { method?: string }
    const headers = (init?.headers ?? {}) as Record<string, string>
    calls.push({ method: body.method ?? '?', url, sessionId: headers['mcp-session-id'] })

    if (body.method === 'initialize') {
      if (options.initStatus !== undefined) return new Response('{}', { status: options.initStatus })
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'dblab', version: '0.1.0' } } }),
        { status: 200, headers: { 'content-type': 'application/json', 'mcp-session-id': 'sess-9' } },
      )
    }
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })

    const payload = { items }
    const result = {
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      ...(options.omitStructured ? {} : { structuredContent: payload }),
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 2, result }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch

  return { impl, calls }
}

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'dblab-cli-cmd-'))
  // 不隔离 APPDATA，本机真实安装的 Cursor/Qoder 会让「未安装」用例假绿。
  vi.stubEnv('APPDATA', join(home, '__appdata__'))
})

afterEach(() => {
  vi.unstubAllEnvs()
})

async function seed(relative: string, content: string): Promise<string> {
  const path = join(home, relative)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content, 'utf8')
  return path
}

function mcpServersOf(json: Record<string, unknown>): Record<string, unknown> {
  const value = json.mcpServers
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

async function readMcpServers(file: string): Promise<Record<string, unknown>> {
  return mcpServersOf(JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>)
}

describe('参数与用法', () => {
  it('无命令时打印用法并返回 2', async () => {
    const { code, stdout } = await run([])
    expect(code).toBe(2)
    expect(stdout).toContain('用法：')
  })

  it('--version 输出版本号', async () => {
    const { code, stdout } = await run(['--version'])
    expect(code).toBe(0)
    expect(stdout.trim()).toBe(CLI_VERSION)
  })

  it('未知命令返回 2', async () => {
    const { code, stderr } = await run(['nope'])
    expect(code).toBe(2)
    expect(stderr).toContain('未知命令')
  })

  it('connect 缺少 --key 返回 2', async () => {
    const { code, stderr } = await run(['connect'])
    expect(code).toBe(2)
    expect(stderr).toContain('缺少 --key')
  })

  it('未知客户端 id 返回 2', async () => {
    const { code, stderr } = await run(['connect', '--url', URL, '--key', KEY, '--agents', 'vscode'])
    expect(code).toBe(2)
    expect(stderr).toContain('未知的客户端')
  })
})

describe('scan', () => {
  it('列出五个客户端并标出状态', async () => {
    await seed('.claude.json', `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`)
    const { code, stdout } = await run(['scan'])

    expect(code).toBe(0)
    expect(stdout).toContain('Claude Code')
    expect(stdout).toContain('Codex CLI')
    expect(stdout).toContain('Qoder CN')
    expect(stdout).toContain('已安装，未接入')
  })
})

describe('connect', () => {
  it('--dry-run 只预览，不写文件，且不泄露密钥', async () => {
    const path = await seed('.cursor/mcp.json', '{}\n')
    const { code, stdout } = await run(['connect', '--url', URL, '--key', KEY, '--dry-run'])

    expect(code).toBe(0)
    expect(await readFile(path, 'utf8')).toBe('{}\n')
    expect(stdout).toContain('dblab_ab12cd34_••••')
    expect(stdout).not.toContain(KEY)
  })

  it('不传 --url 时用 compose 的 18400', async () => {
    await seed('.cursor/mcp.json', '{}\n')
    await seed('.codex/config.toml', 'model = "x"\n')
    const { code, stdout } = await run(['connect', '--key', KEY, '--dry-run'])
    expect(code).toBe(0)
    expect(stdout).toContain('服务地址：http://localhost:18400/mcp')
    expect(stdout).toContain('url = "http://localhost:18400/mcp"')
  })

  it('--dry-run 按各客户端自己的格式展示（Codex 是 TOML 段）', async () => {
    await seed('.cursor/mcp.json', '{}\n')
    await seed('.codex/config.toml', 'model = "x"\n')
    const { code, stdout } = await run(['connect', '--url', URL, '--key', KEY, '--dry-run'])

    expect(code).toBe(0)
    // Cursor 走 mcpServers JSON，Codex 必须是 TOML 段，不能统一成一份 JSON
    expect(stdout).toContain('"mcpServers"')
    expect(stdout).toContain('[mcp_servers.dblab]')
    expect(stdout).toContain('http_headers = { "Authorization" = "Bearer dblab_ab12cd34_••••" }')
    expect(stdout).not.toContain(KEY)
    expect(await readFile(join(home, '.codex/config.toml'), 'utf8')).toBe('model = "x"\n')
  })

  it('校验通过后写入并保持其它条目', async () => {
    const path = await seed(
      '.cursor/mcp.json',
      `${JSON.stringify({ mcpServers: { exa: { url: 'http://exa' } } }, null, 2)}\n`,
    )
    const { code, stdout } = await run(['connect', '--url', URL, '--key', KEY], {
      fetchImpl: okFetch(),
    })

    expect(code).toBe(0)
    const servers = await readMcpServers(path)
    expect(servers.dblab).toEqual({
      type: 'http',
      url: 'http://localhost:4000/mcp',
      headers: { Authorization: `Bearer ${KEY}` },
    })
    expect(servers.exa).toEqual({ url: 'http://exa' })
    expect(stdout).not.toContain(KEY)
  })

  it('密钥校验 401 返回 1 且不写文件', async () => {
    const path = await seed('.cursor/mcp.json', '{}\n')
    const { code, stderr } = await run(['connect', '--url', URL, '--key', KEY], {
      fetchImpl: rejectWith(401),
    })

    expect(code).toBe(1)
    expect(stderr).toContain('密钥无效')
    expect(await readFile(path, 'utf8')).toBe('{}\n')
  })

  it('某份配置损坏时整体不写（退出码 3）', async () => {
    await seed('.cursor/mcp.json', '{ broken')
    await seed('.codex/config.toml', 'model = "x"\n')
    const { code, stderr } = await run(
      ['connect', '--url', URL, '--key', KEY, '--agents', 'cursor,codex'],
      { fetchImpl: okFetch() },
    )

    expect(code).toBe(3)
    expect(stderr).toContain('无法解析')
    // 另一份没被连带写入
    expect(await readFile(join(home, '.codex/config.toml'), 'utf8')).toBe('model = "x"\n')
  })

  it('重复执行返回无需改动', async () => {
    await seed('.cursor/mcp.json', '{}\n')
    const fetchImpl = okFetch()
    await run(['connect', '--url', URL, '--key', KEY], { fetchImpl })

    const { code, stdout } = await run(['connect', '--url', URL, '--key', KEY], { fetchImpl })
    expect(code).toBe(0)
    expect(stdout).toContain('无需改动')
  })

  it('--skip-validate 时服务不可达也能落配置', async () => {
    const path = await seed('.cursor/mcp.json', '{}\n')
    const { code } = await run(['connect', '--url', URL, '--key', KEY, '--skip-validate'], {
      fetchImpl: (async () => {
        throw new TypeError('fetch failed')
      }) as unknown as typeof fetch,
    })

    expect(code).toBe(0)
    expect((await readMcpServers(path)).dblab).toBeDefined()
  })
})

describe('disconnect', () => {
  it('摘掉 dblab 条目，保留同级条目', async () => {
    await seed('.cursor/mcp.json', '{}\n')
    await run(['connect', '--url', URL, '--key', KEY], { fetchImpl: okFetch() })

    const { code, stdout } = await run(['disconnect'])
    expect(code).toBe(0)
    expect(stdout).toContain('已移除')
    expect(
      (await readMcpServers(join(home, '.cursor/mcp.json'))).dblab,
    ).toBeUndefined()
  })

  it('没有配置时提示且返回 0', async () => {
    const { code, stdout } = await run(['disconnect'])
    expect(code).toBe(0)
    expect(stdout).toContain('没有找到')
  })
})

describe('setup 向导', () => {
  function makePrompts(overrides: Partial<Prompts> = {}): Prompts {
    return {
      input: async () => URL,
      password: async () => KEY,
      checkbox: async (options) => options.choices.filter((c) => c.checked).map((c) => c.value),
      confirm: async () => true,
      ...overrides,
    }
  }

  function makeCtx(fetchImpl?: typeof fetch): {
    ctx: CommandContext
    text: () => string
  } {
    const stdout = collector()
    const stderr = collector()
    return {
      ctx: {
        homeDir: home,
        out: createOutput({ stdout: stdout.stream, stderr: stderr.stream, color: false }),
        ...(fetchImpl ? { fetchImpl } : {}),
      },
      text: () => `${stdout.text()}${stderr.text()}`,
    }
  }

  it('走完流程后写入选中的客户端', async () => {
    await seed('.cursor/mcp.json', '{}\n')
    await seed('.claude.json', '{}\n')
    const { ctx, text } = makeCtx(okFetch())

    expect(await runSetup(ctx, { prompts: makePrompts() })).toBe(0)

    const servers = await readMcpServers(join(home, '.cursor/mcp.json'))
    expect(servers.dblab).toBeDefined()
    expect(text()).not.toContain(KEY)
    expect((await loadConnection(home))?.key).toBe(KEY)
  })

  it('密钥校验失败且用户不重试时抛错（不写文件）', async () => {
    const path = await seed('.cursor/mcp.json', '{}\n')
    const { ctx } = makeCtx(rejectWith(401))

    await expect(
      runSetup(ctx, { prompts: makePrompts({ confirm: async () => false }) }),
    ).rejects.toThrow(/校验/)
    expect(await readFile(path, 'utf8')).toBe('{}\n')
  })

  it('重试后会接受新密钥', async () => {
    await seed('.cursor/mcp.json', '{}\n')
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValue(
        new Response(
          JSON.stringify({ jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'dblab' } } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ) as unknown as typeof fetch
    const { ctx } = makeCtx(fetchImpl)

    expect(await runSetup(ctx, { prompts: makePrompts() })).toBe(0)
    expect((await readMcpServers(join(home, '.cursor/mcp.json'))).dblab).toBeDefined()
  })

  it('一个客户端都没检测到时返回 2', async () => {
    const { ctx } = makeCtx(okFetch())
    expect(await runSetup(ctx, { prompts: makePrompts() })).toBe(2)
  })

  it('用户取消确认时不写文件', async () => {
    const path = await seed('.cursor/mcp.json', '{}\n')
    const { ctx } = makeCtx(okFetch())

    const code = await runSetup(ctx, { prompts: makePrompts({ confirm: async () => false }) })
    expect(code).toBe(0)
    expect(await readFile(path, 'utf8')).toBe('{}\n')
  })
})

describe('连接记录', () => {
  it('connect 成功后记下这把密钥与这个地址', async () => {
    await seed('.cursor/mcp.json', '{}\n')
    const { code, stdout } = await run(['connect', '--url', URL, '--key', KEY], { fetchImpl: okFetch() })

    expect(code).toBe(0)
    expect(stdout).toContain('已记录本机连接')
    expect(stdout).not.toContain(KEY)
    const stored = await loadConnection(home)
    expect(stored?.key).toBe(KEY)
    expect(stored?.url).toBe(`${URL}/mcp`)
  })

  it('--dry-run 只是预览，不留记录', async () => {
    await seed('.cursor/mcp.json', '{}\n')
    const { code } = await run(['connect', '--url', URL, '--key', KEY, '--dry-run'])

    expect(code).toBe(0)
    expect(await loadConnection(home)).toBeNull()
  })

  it('整体断开清掉记录，按 --agents 只摘一家时保留', async () => {
    await seed('.cursor/mcp.json', '{}\n')
    await seed('.claude.json', '{}\n')
    await run(['connect', '--url', URL, '--key', KEY], { fetchImpl: okFetch() })

    const partial = await run(['disconnect', '--agents', 'cursor'])
    expect(partial.code).toBe(0)
    expect(partial.stdout).not.toContain('已清除本机连接记录')
    expect((await loadConnection(home))?.key).toBe(KEY)

    const full = await run(['disconnect'])
    expect(full.code).toBe(0)
    expect(full.stdout).toContain('已清除本机连接记录')
    expect(await loadConnection(home)).toBeNull()
  })
})

describe('datasource list', () => {
  it('以密钥身份连 /mcp，列出读写权限', async () => {
    const mcp = fakeMcpDatasources([
      { name: 'orders', engine: 'postgres', database: 'orders_db', canRead: true, canWrite: false },
      { name: 'staging', engine: 'mysql', database: 'stg', canRead: false, canWrite: true },
    ])
    const { code, stdout } = await run(['datasource', 'list', '--url', URL, '--key', KEY], {
      fetchImpl: mcp.impl,
    })

    expect(code).toBe(0)
    expect(stdout).toContain('orders')
    expect(stdout).toContain('只读')
    expect(stdout).toContain('只写')
    expect(stdout).toContain('dblab_ab12cd34_••••')
    expect(stdout).not.toContain(KEY)

    // 工具调用必须发生在完整握手之后，且带上 initialize 回传的会话 id
    expect(mcp.calls.map((call) => call.method)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/call',
    ])
    expect(mcp.calls[2]?.sessionId).toBe('sess-9')
    expect(mcp.calls[0]?.url).toBe(`${URL}/mcp`)
  })

  it('没有 structuredContent 时退回 content 里的那份 JSON', async () => {
    const mcp = fakeMcpDatasources(
      [{ name: 'orders', engine: 'postgres', database: 'd', canRead: true, canWrite: true }],
      { omitStructured: true },
    )
    const { code, stdout } = await run(['datasource', 'list', '--url', URL, '--key', KEY], {
      fetchImpl: mcp.impl,
    })

    expect(code).toBe(0)
    expect(stdout).toContain('读+写')
  })

  it('一把权限都没有时是提示而不是失败', async () => {
    const mcp = fakeMcpDatasources([])
    const { code, stdout, stderr } = await run(['datasource', 'list', '--url', URL, '--key', KEY], {
      fetchImpl: mcp.impl,
    })

    expect(code).toBe(0)
    expect(`${stdout}${stderr}`).toContain('没有任何数据源权限')
  })

  it('密钥被拒时退出码 1', async () => {
    const mcp = fakeMcpDatasources([], { initStatus: 401 })
    const { code, stderr } = await run(['datasource', 'list', '--url', URL, '--key', KEY], {
      fetchImpl: mcp.impl,
    })

    expect(code).toBe(1)
    expect(stderr).toContain('密钥无效')
  })

  it('省略 --key 时用记录里的密钥与地址', async () => {
    await saveConnection(home, { url: 'http://localhost:4100', key: KEY })
    const mcp = fakeMcpDatasources([
      { name: 'orders', engine: 'postgres', database: 'd', canRead: true, canWrite: false },
    ])
    const { code, stdout } = await run(['datasource', 'list'], { fetchImpl: mcp.impl })

    expect(code).toBe(0)
    expect(mcp.calls[0]?.url).toBe('http://localhost:4100/mcp')
    expect(stdout).toContain('本机连接记录')
  })

  it('没有记录又没给 --key 时报用法错误', async () => {
    const { code, stderr } = await run(['datasource', 'list'])
    expect(code).toBe(2)
    expect(stderr).toContain('缺少 --key')
  })

  it('未知的子命令报用法错误，且不去连服务', async () => {
    const { code, stderr } = await run(['datasource', 'remove'])
    expect(code).toBe(2)
    expect(stderr).toContain('未知的 datasource 子命令')
  })
})
