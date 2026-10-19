import { sourceLabel, type ConnectionSource } from '../core/connection-store'
import { CliError } from '../core/errors'
import { maskKey } from '../core/key'
import { callMcpTool, closeMcpSession, openMcpSession, type McpEndpoint } from '../core/mcp-rpc'
import { padEndVisual, visualWidth } from '../core/output'

import { grantLabel } from './datasource'
import type { CommandContext } from './shared'

export interface DatasourceListOptions {
  /** 已归一化的 MCP 地址。 */
  mcpUrl: string
  apiKey: string
  keySource?: ConnectionSource
}

interface DatasourcePermission {
  name: string
  engine: string
  database: string
  canRead: boolean
  canWrite: boolean
}

/**
 * 列出这把密钥被授权的数据源。
 *
 * 走的是 Agent 自己那条链路（`/mcp` + Bearer + `list_datasources`），不是管理面：
 * 拿着密钥的人就该能自查「我到底能看哪些库」，不需要管理员口令，
 * 而且这份结果正是 Agent 实际看到的视图。
 */
export async function runDatasourceList(ctx: CommandContext, options: DatasourceListOptions): Promise<number> {
  const endpoint: McpEndpoint = {
    mcpUrl: options.mcpUrl,
    apiKey: options.apiKey,
    ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
  }

  ctx.out.plain(`服务：${options.mcpUrl}`)
  ctx.out.plain(`密钥：${maskKey(options.apiKey)}（来自 ${sourceLabel(options.keySource ?? 'flag')}）`)

  const session = await openMcpSession(endpoint)
  if ('kind' in session) {
    throw new CliError('validate', session.message, session.hint)
  }

  try {
    const outcome = await callMcpTool(endpoint, session.sessionId, 'list_datasources')
    if (!outcome.ok) throw new CliError('validate', outcome.failure.message, outcome.failure.hint)

    const items = permissionsOf(outcome.payload)
    if (items.length === 0) {
      ctx.out.plain('')
      ctx.out.warn('这把密钥目前没有任何数据源权限。')
      ctx.out.plain('  用 dblab datasource --name <名字> … 注册一个，注册时会授权给当前这把密钥。')
      return 0
    }

    ctx.out.plain('')
    printPermissionRows(ctx, items)
    ctx.out.plain('')
    ctx.out.plain(`共 ${items.length} 个数据源。改授权要管理员在管控台或 dblab datasource 里做。`)
    return 0
  } finally {
    await closeMcpSession(endpoint, session.sessionId)
  }
}

const COLUMNS = ['数据源', '引擎', '库', '权限'] as const

function printPermissionRows(ctx: CommandContext, items: DatasourcePermission[]): void {
  const rows = items.map((item) => [item.name, item.engine, item.database, grantLabel(item)] as const)
  const widths = COLUMNS.map((title, index) =>
    Math.max(visualWidth(title), ...rows.map((row) => visualWidth(row[index] ?? ''))),
  )

  ctx.out.plain(`  ${COLUMNS.map((title, index) => padEndVisual(title, widths[index] ?? 0)).join('  ')}`)
  for (const row of rows) {
    ctx.out.plain(`  ${row.map((cell, index) => padEndVisual(cell, widths[index] ?? 0)).join('  ')}`)
  }
}

function permissionsOf(payload: Record<string, unknown>): DatasourcePermission[] {
  const raw = Array.isArray(payload.items) ? payload.items : []
  const items: DatasourcePermission[] = []

  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue
    const candidate = entry as Record<string, unknown>
    if (typeof candidate.name !== 'string') continue
    items.push({
      name: candidate.name,
      engine: typeof candidate.engine === 'string' ? candidate.engine : '?',
      database: typeof candidate.database === 'string' ? candidate.database : '?',
      canRead: candidate.canRead === true,
      canWrite: candidate.canWrite === true,
    })
  }

  return items
}
