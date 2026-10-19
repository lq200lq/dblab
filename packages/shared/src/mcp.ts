import type { AuditAction } from './audit'

/**
 * MCP 工具词表。服务端按授权动态注册（只读密钥看不到 execute），
 * 中文标签给审计页展示用，两处同源。
 */
export const MCP_TOOL_NAMES = [
  'list_datasources',
  'list_tables',
  'describe_table',
  'query',
  'execute',
] as const

export type McpToolName = (typeof MCP_TOOL_NAMES)[number]

export const MCP_TOOL_LABEL: Record<McpToolName, string> = {
  list_datasources: '列出数据源',
  list_tables: '列出数据表',
  describe_table: '查看表结构',
  query: '执行查询',
  execute: '执行写操作',
}

/** 需要写授权才会被注册的工具。 */
export const WRITE_TOOLS: ReadonlySet<McpToolName> = new Set<McpToolName>(['execute'])

export function isMcpToolName(value: string): value is McpToolName {
  return (MCP_TOOL_NAMES as readonly string[]).includes(value)
}

export function auditActionForTool(tool: string): AuditAction {
  if (tool === 'list_datasources') return 'mcp.list_datasources'
  if (tool === 'list_tables') return 'mcp.list_tables'
  if (tool === 'describe_table') return 'mcp.describe_table'
  if (tool === 'query') return 'mcp.query'
  if (tool === 'execute') return 'mcp.execute'
  return 'mcp.unknown_tool'
}
