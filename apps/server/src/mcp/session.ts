import { MCP_TOOL_NAMES, type McpToolName } from '@dblab/shared'
import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { randomUUID } from 'node:crypto'

import type { McpDeps, McpSessionContext } from './context'
import { registerTools } from './tools'

export interface McpSession {
  sessionId: string
  /** 建会话时用的密钥：后续请求的 Bearer 必须还是它，session id 本身不是凭证。 */
  apiKeyId: number
  server: McpServer
  transport: StreamableHTTPServerTransport
  context: McpSessionContext
  tools: Map<McpToolName, RegisteredTool>
  lastUsedAt: number
}

export interface McpSessionRegistryOptions {
  /** 会话空闲多久回收。 */
  ttlMinutes: number
  now?: () => number
}

/**
 * 会话注册表。会话是进程内状态（本平台单进程运行，没有跨节点的会话共享需求）。
 */
export class McpSessionRegistry {
  private readonly sessions = new Map<string, McpSession>()
  private sweeper: NodeJS.Timeout | undefined

  constructor(private readonly options: McpSessionRegistryOptions) {}

  get size(): number {
    return this.sessions.size
  }

  add(session: McpSession): void {
    this.sessions.set(session.sessionId, session)
  }

  get(sessionId: string): McpSession | undefined {
    return this.sessions.get(sessionId)
  }

  /** 只从表里摘掉；关闭交给调用方，便于先关传输再摘。 */
  take(sessionId: string): McpSession | undefined {
    const session = this.sessions.get(sessionId)
    if (session) this.sessions.delete(sessionId)
    return session
  }

  async remove(sessionId: string): Promise<void> {
    const session = this.take(sessionId)
    if (!session) return
    await session.server.close().catch(() => {})
  }

  startSweeper(): void {
    if (this.sweeper) return
    this.sweeper = setInterval(() => void this.sweepIdle(), 60_000)
    this.sweeper.unref()
  }

  stopSweeper(): void {
    if (!this.sweeper) return
    clearInterval(this.sweeper)
    this.sweeper = undefined
  }

  async closeAll(): Promise<void> {
    this.stopSweeper()
    const sessions = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.all(sessions.map((session) => session.server.close().catch(() => {})))
  }

  private async sweepIdle(): Promise<void> {
    const now = this.now()
    const idleMs = this.options.ttlMinutes * 60_000
    const stale = [...this.sessions.values()]
      .filter((session) => now - session.lastUsedAt > idleMs)
      .map((session) => session.sessionId)
    for (const sessionId of stale) {
      await this.remove(sessionId)
    }
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now()
  }
}

export interface McpSessionHooks {
  /** SDK 生成会话 id 后回调（发生在处理 initialize 时），调用方在这里登记会话。 */
  onInitialized?: (sessionId: string) => void
  /** 客户端发 DELETE 结束会话后回调。 */
  onClosed?: (sessionId: string) => void
}

export async function createMcpSession(
  deps: McpDeps,
  context: McpSessionContext,
  hooks: McpSessionHooks = {},
): Promise<McpSession> {
  const server = new McpServer({ name: 'dblab', version: '0.1.0' })
  const tools = registerTools(server, deps, context)

  // 会话回调只能从构造参数进：这层 Node 包装类没有暴露 onsessioninitialized 的 setter。
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sessionId) => hooks.onInitialized?.(sessionId),
    onsessionclosed: (sessionId) => hooks.onClosed?.(sessionId),
  })

  // 必须先接上：不 connect 的话传输层收到的消息没有处理器，请求会一直挂着不返回。
  await server.connect(transport)

  return {
    // sessionId 由传输在处理 initialize 时生成，这里先占位，由 onInitialized 回填。
    sessionId: '',
    apiKeyId: context.key.id,
    server,
    transport,
    context,
    tools,
    lastUsedAt: Date.now(),
  }
}

/**
 * 按当前授权刷新工具可见性。
 *
 * 只读密钥在 tools/list 里**看不到 execute**（而不是看得到但一调就被拒）——
 * 但闸门里的按分类判权仍然保留，两层都在。
 */
export function refreshToolAvailability(
  session: McpSession,
  permissions: Map<number, { canRead: boolean; canWrite: boolean }>,
): void {
  let canWriteAnywhere = false
  let canReadAnywhere = false
  for (const permission of permissions.values()) {
    if (permission.canWrite) canWriteAnywhere = true
    if (permission.canRead) canReadAnywhere = true
  }

  for (const name of MCP_TOOL_NAMES) {
    const tool = session.tools.get(name)
    if (!tool) continue
    const wanted =
      name === 'execute' ? canWriteAnywhere : name === 'list_datasources' ? true : canReadAnywhere
    if (wanted) tool.enable()
    else tool.disable()
  }
}
