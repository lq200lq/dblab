import type { AuditAction, ErrorCode, McpToolName, QueryResult } from '@dblab/shared'
import { auditActionForTool, ERROR_MESSAGE_BY_CODE } from '@dblab/shared'
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

import type { GrantPermission } from '../api-key/service'
import type { AuditEntry } from '../audit/audit.service'
import { AppError } from '../common/errors'
import type { DatasourceRow } from '../datasource/driver-config'
import { normalizeRow } from '../sql/normalize'
import { runGuardedSql, type GuardOutcome } from '../sql/guard'

import type { McpDeps, McpSessionContext } from './context'

interface ToolContext {
  deps: McpDeps
  session: McpSessionContext
}

/** 工具侧要填的审计字段：身份、数据源与 clientIp 由这里统一补。 */
type ToolAuditEntry = Pick<
  AuditEntry,
  | 'action'
  | 'toolName'
  | 'decision'
  | 'denialReason'
  | 'sqlText'
  | 'classification'
  | 'rowCount'
  | 'durationMs'
  | 'errorCode'
  | 'errorMessage'
  | 'detail'
> & { datasource?: DatasourceRow }

/** 工具的返回：文本与结构化内容都给，客户端至少能读到其中一个。 */
function okResult(payload: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
  }
}

/**
 * 拒绝与失败都用 isError 返回，不抛异常：
 * 抛出去在不少客户端里会被渲染成「服务端坏了」，而这不是「工具调用失败了」。
 */
function failResult(code: ErrorCode, details?: Record<string, unknown>): CallToolResult {
  const message = ERROR_MESSAGE_BY_CODE[code]
  const payload: Record<string, unknown> = { ok: false, code, message, ...(details ?? {}) }
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
  }
}

type Access =
  | { ok: true; row: DatasourceRow; permission: GrantPermission }
  | { ok: false; code: ErrorCode }

/**
 * 按名字解析数据源并取授权。
 *
 * **未授权与不存在返回同一个码**：否则 Agent 可以靠返回码把「平台上有哪些库」枚举出来。
 */
async function resolveAccess(
  context: ToolContext,
  datasourceName: string,
): Promise<Access> {
  const row = await context.deps.datasources.findByName(datasourceName)
  const permission = row ? context.session.permissions.get(row.id) : undefined
  if (!row || !permission) return { ok: false, code: 'DATASOURCE_NOT_FOUND_OR_UNAUTHORIZED' }
  return { ok: true, row, permission }
}

export function registerTools(
  server: McpServer,
  deps: McpDeps,
  session: McpSessionContext,
): Map<McpToolName, RegisteredTool> {
  const context: ToolContext = { deps, session }
  const tools = new Map<McpToolName, RegisteredTool>()

  tools.set(
    'list_datasources',
    server.registerTool(
      'list_datasources',
      {
        title: '列出可访问的数据源',
        description:
          '列出本密钥被授权访问的数据源及其读写权限。未授权的数据源不会出现在结果里。',
        inputSchema: {},
      },
      async () => {
        const startedAt = Date.now()
        const accessible = await listAccessible(context)

        await record(context, {
          action: 'mcp.list_datasources',
          toolName: 'list_datasources',
          decision: 'granted',
          durationMs: Date.now() - startedAt,
          detail: { count: accessible.items.length },
        })

        return okResult(accessible)
      },
    ),
  )

  tools.set(
    'list_tables',
    server.registerTool(
      'list_tables',
      {
        title: '列出数据表',
        description: '列出某个数据源里的表与视图。需要该数据源的读权限。',
        inputSchema: {
          datasource: z.string().min(1).describe('数据源名称，取自 list_datasources'),
          schema: z.string().min(1).optional().describe('库/模式名；不填用数据源默认值'),
        },
      },
      async (args) => {
        const startedAt = Date.now()
        const access = await resolveAccess(context, args.datasource)
        if (!access.ok) return deniedDatasource(context, 'list_tables', args.datasource, access.code, startedAt)
        if (!access.permission.canRead) {
          return deniedTool(context, 'list_tables', access.row, 'NO_READ_GRANT', startedAt)
        }

        try {
          const adapter = await context.deps.pools.adapterFor(access.row)
          const tables = await adapter.listTables(args.schema)
          await record(context, {
            action: 'mcp.list_tables',
            toolName: 'list_tables',
            datasource: access.row,
            decision: 'granted',
            durationMs: Date.now() - startedAt,
            detail: { schema: args.schema ?? null, count: tables.length },
          })
          return okResult({ datasource: access.row.name, tables })
        } catch (error) {
          return failedDatasource(context, 'list_tables', access.row, error, startedAt)
        }
      },
    ),
  )

  tools.set(
    'describe_table',
    server.registerTool(
      'describe_table',
      {
        title: '查看表结构',
        description: '给出某张表的列、类型、可空性、默认值与主键。需要该数据源的读权限。',
        inputSchema: {
          datasource: z.string().min(1).describe('数据源名称'),
          table: z.string().min(1).describe('表名'),
          schema: z.string().min(1).optional().describe('库/模式名；不填用数据源默认值'),
        },
      },
      async (args) => {
        const startedAt = Date.now()
        const access = await resolveAccess(context, args.datasource)
        if (!access.ok) {
          return deniedDatasource(context, 'describe_table', args.datasource, access.code, startedAt)
        }
        if (!access.permission.canRead) {
          return deniedTool(context, 'describe_table', access.row, 'NO_READ_GRANT', startedAt)
        }

        try {
          const adapter = await context.deps.pools.adapterFor(access.row)
          const described = await adapter.describeTable(args.table, args.schema)

          if (!described) {
            await record(context, {
              action: 'mcp.describe_table',
              toolName: 'describe_table',
              datasource: access.row,
              decision: 'granted',
              durationMs: Date.now() - startedAt,
              errorCode: 'QUERY_FAILED',
              errorMessage: '表不存在',
              detail: { table: args.table, schema: args.schema ?? null },
            })
            return failResult('QUERY_FAILED', { message: `表 ${args.table} 不存在` })
          }

          await record(context, {
            action: 'mcp.describe_table',
            toolName: 'describe_table',
            datasource: access.row,
            decision: 'granted',
            durationMs: Date.now() - startedAt,
            detail: { table: args.table, schema: described.schema, columns: described.columns.length },
          })
          return okResult({ datasource: access.row.name, table: described })
        } catch (error) {
          return failedDatasource(context, 'describe_table', access.row, error, startedAt)
        }
      },
    ),
  )

  tools.set(
    'query',
    server.registerTool(
      'query',
      {
        title: '执行只读查询',
        description:
          '执行只读语句（SELECT/EXPLAIN/SHOW）。需要该数据源的读权限。' +
          '写入语句请改用 execute 工具；结构变更（DDL）平台一律拒绝。' +
          '返回行数受平台上限约束，命中上限时结果里的 truncated 为 true。',
        inputSchema: {
          datasource: z.string().min(1).describe('数据源名称'),
          sql: z.string().min(1).describe('单条只读语句，不支持分号分隔的多条语句'),
          maxRows: z
            .number()
            .int()
            .min(1)
            .optional()
            .describe('期望返回的行数上限；不能超过平台配置的上限，超出按平台上限截断'),
        },
      },
      async (args) =>
        runSqlTool(context, {
          tool: 'query',
          mode: 'query',
          datasourceName: args.datasource,
          sql: args.sql,
          requestedMaxRows: args.maxRows,
        }),
    ),
  )

  tools.set(
    'execute',
    server.registerTool(
      'execute',
      {
        title: '执行写入语句',
        description:
          '执行数据变更语句（INSERT/UPDATE/DELETE）。需要该数据源的写权限。' +
          '结构变更（DDL：CREATE/ALTER/DROP/TRUNCATE 等）与事务控制语句平台一律拒绝。',
        inputSchema: {
          datasource: z.string().min(1).describe('数据源名称'),
          sql: z.string().min(1).describe('单条写入语句，不支持分号分隔的多条语句'),
        },
      },
      async (args) =>
        runSqlTool(context, {
          tool: 'execute',
          mode: 'execute',
          datasourceName: args.datasource,
          sql: args.sql,
        }),
    ),
  )

  // 统一收口：处理器里漏出来的任何异常（含审计写失败）都翻成 isError 结果。
  // 抛出去在部分客户端会被渲染成「服务端坏了」，而实际只是这一次调用失败了。
  for (const [name, tool] of tools) {
    const inner = tool.handler as (args: unknown, extra: unknown) => Promise<CallToolResult>
    tool.handler = (async (args: unknown, extra: unknown) => {
      try {
        return await inner(args, extra)
      } catch (error) {
        console.error(`[mcp] ${name} 处理失败：`, error)
        return failResult(errorCodeOf(error))
      }
    }) as typeof tool.handler
  }

  return tools
}

async function listAccessible(context: ToolContext): Promise<{
  items: Array<Record<string, unknown>>
}> {
  const all = await context.deps.datasources.list()
  const items = all
    .filter((datasource) => context.session.permissions.has(datasource.id))
    .map((datasource) => {
      const permission = context.session.permissions.get(datasource.id)
      return {
        name: datasource.name,
        engine: datasource.engine,
        database: datasource.database,
        canRead: permission?.canRead ?? false,
        canWrite: permission?.canWrite ?? false,
      }
    })
  return { items }
}

interface SqlToolInput {
  tool: 'query' | 'execute'
  mode: 'query' | 'execute'
  datasourceName: string
  sql: string
  requestedMaxRows?: number
}

async function runSqlTool(context: ToolContext, input: SqlToolInput): Promise<CallToolResult> {
  const startedAt = Date.now()
  const action = input.tool === 'query' ? 'mcp.query' : 'mcp.execute'

  const access = await resolveAccess(context, input.datasourceName)
  if (!access.ok) {
    return deniedDatasource(context, input.tool, input.datasourceName, access.code, startedAt, input.sql)
  }

  let adapter
  try {
    adapter = await context.deps.pools.adapterFor(access.row)
  } catch (error) {
    return failedDatasource(context, input.tool, access.row, error, startedAt, input.sql)
  }

  // 上限只能收紧不能放宽：Agent 传更大的值也按平台配置来。
  const maxRows = Math.min(input.requestedMaxRows ?? context.deps.env.mcpMaxRows, context.deps.env.mcpMaxRows)

  const outcome = await runGuardedSql(
    {
      adapter,
      grant: access.permission,
      mode: input.mode,
      maxSqlBytes: context.deps.env.mcpMaxSqlBytes,
      maxRows,
      statementTimeoutMs: context.deps.env.mcpStatementTimeoutMs,
    },
    input.sql,
  )
  const durationMs = Date.now() - startedAt

  await recordOutcome(context, {
    action,
    tool: input.tool,
    row: access.row,
    sql: input.sql,
    outcome,
    maxRows,
    durationMs,
  })

  if (outcome.status === 'ok') {
    return okResult(toPayload(access.row.name, outcome.result, durationMs, maxRows))
  }
  if (outcome.status === 'denied') {
    return failResult(outcome.code, { keyword: outcome.keyword })
  }
  return failResult(outcome.code, { keyword: outcome.keyword, message: outcome.message })
}

function toPayload(
  datasourceName: string,
  result: QueryResult,
  durationMs: number,
  maxRows: number,
): Record<string, unknown> {
  return {
    datasource: datasourceName,
    columns: result.columns,
    rows: result.rows.map((row) => normalizeRow(row)),
    rowCount: result.rowCount,
    truncated: result.truncated,
    maxRows,
    durationMs,
  }
}

/** 审计的公共字段：谁（哪把密钥）在什么时候、从哪个 IP 调的。 */
async function record(context: ToolContext, entry: ToolAuditEntry): Promise<void> {
  try {
    await context.deps.audit.record(buildAuditEntry(entry, context))
  } catch (error) {
    // 执行路径不能吞审计失败：写不进去就意味着这次调用没有留下痕迹，
    // 那也不能给 Agent 一个「成功」的假象，翻成带码的失败返回。
    console.error('[mcp] 审计写入失败：', error)
    throw new AppError('AUDIT_WRITE_FAILED', undefined, { cause: error })
  }
}

function buildAuditEntry(entry: ToolAuditEntry, context: ToolContext): AuditEntry {
  return {
    actorKind: 'agent',
    actorId: context.session.key.id,
    actorName: context.session.key.name,
    apiKeyId: context.session.key.id,
    apiKeyPrefix: context.session.key.prefix,
    clientIp: context.session.clientIp,
    datasourceId: entry.datasource?.id ?? null,
    datasourceName: entry.datasource?.name ?? null,
    engine: entry.datasource?.engine ?? null,
    action: entry.action,
    toolName: entry.toolName,
    sqlText: entry.sqlText ?? null,
    classification: entry.classification ?? null,
    decision: entry.decision,
    denialReason: entry.denialReason ?? null,
    rowCount: entry.rowCount ?? null,
    durationMs: entry.durationMs ?? null,
    errorCode: entry.errorCode ?? null,
    errorMessage: entry.errorMessage ?? null,
    detail: entry.detail ?? null,
  }
}

async function recordOutcome(
  context: ToolContext,
  input: {
    action: 'mcp.query' | 'mcp.execute'
    tool: 'query' | 'execute'
    row: DatasourceRow
    sql: string
    outcome: GuardOutcome
    maxRows: number
    durationMs: number
  },
): Promise<void> {
  const common = {
    action: input.action,
    toolName: input.tool,
    datasource: input.row,
    sqlText: input.sql,
    durationMs: input.durationMs,
  }

  if (input.outcome.status === 'ok') {
    await record(context, {
      ...common,
      decision: 'granted',
      classification: input.outcome.classification,
      rowCount: input.outcome.result.rowCount,
      detail: {
        keyword: input.outcome.keyword,
        maxRows: input.maxRows,
        truncated: input.outcome.result.truncated,
      },
    })
    return
  }

  if (input.outcome.status === 'denied') {
    await record(context, {
      ...common,
      decision: 'denied',
      classification: input.outcome.classification,
      denialReason: input.outcome.code.toLowerCase(),
      detail: { keyword: input.outcome.keyword, notes: input.outcome.notes },
    })
    return
  }

  await record(context, {
    ...common,
    decision: 'granted',
    classification: input.outcome.classification,
    errorCode: input.outcome.code,
    errorMessage: input.outcome.message,
    detail: { keyword: input.outcome.keyword, notes: input.outcome.notes },
  })
}

async function deniedDatasource(
  context: ToolContext,
  tool: McpToolName,
  requestedName: string,
  code: ErrorCode,
  startedAt: number,
  sql?: string,
): Promise<CallToolResult> {
  await record(context, {
    action: auditActionFor(tool),
    toolName: tool,
    decision: 'denied',
    denialReason: code.toLowerCase(),
    sqlText: sql ?? null,
    durationMs: Date.now() - startedAt,
    // 请求里的名字可能是编的，不进 datasource_name，放在 detail 里备查。
    detail: { requestedDatasource: requestedName },
  })
  return failResult(code)
}

async function deniedTool(
  context: ToolContext,
  tool: McpToolName,
  row: DatasourceRow,
  code: ErrorCode,
  startedAt: number,
): Promise<CallToolResult> {
  await record(context, {
    action: auditActionFor(tool),
    toolName: tool,
    datasource: row,
    decision: 'denied',
    denialReason: code.toLowerCase(),
    durationMs: Date.now() - startedAt,
  })
  return failResult(code)
}

async function failedDatasource(
  context: ToolContext,
  tool: McpToolName,
  row: DatasourceRow,
  error: unknown,
  startedAt: number,
  sql?: string,
): Promise<CallToolResult> {
  const code = errorCodeOf(error)
  await record(context, {
    action: auditActionFor(tool),
    toolName: tool,
    datasource: row,
    decision: 'granted',
    sqlText: sql ?? null,
    durationMs: Date.now() - startedAt,
    errorCode: code,
    errorMessage: ERROR_MESSAGE_BY_CODE[code],
  })
  return failResult(code)
}

/** 带码异常（如 DATASOURCE_DISABLED、主密钥不可用）直接取码，其余按执行失败处理。 */
function errorCodeOf(error: unknown): ErrorCode {
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code === 'string' && code in ERROR_MESSAGE_BY_CODE) return code as ErrorCode
  return 'QUERY_FAILED'
}

function auditActionFor(tool: McpToolName): AuditAction {
  return auditActionForTool(tool)
}
