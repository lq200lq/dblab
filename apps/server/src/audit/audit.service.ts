import type {
  ActorKind,
  ApiKeyGrant,
  AuditAction,
  AuditDecision,
  AuditLog,
  AuditLogPage,
  AuditLogQuery,
  Engine,
  ErrorCode,
  SqlClass,
} from '@dblab/shared'
import { auditLog, type PlatformDb } from '@dblab/db'
import { and, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm'

/** sql_text 的入库上限。MCP 侧另有更小的语句上限，这里只是防止任何路径写入无界文本。 */
const MAX_SQL_TEXT_CHARS = 100_000

export interface AuditEntry {
  actorKind: ActorKind
  actorId?: number | null
  actorName: string
  apiKeyId?: number | null
  apiKeyPrefix?: string | null
  datasourceId?: number | null
  datasourceName?: string | null
  engine?: Engine | null
  action: AuditAction
  toolName?: string | null
  sqlText?: string | null
  classification?: SqlClass | null
  decision: AuditDecision
  denialReason?: string | null
  rowCount?: number | null
  durationMs?: number | null
  clientIp?: string | null
  errorCode?: ErrorCode | null
  errorMessage?: string | null
  detail?: Record<string, unknown> | null
}

/**
 * 审计。只暴露 record（写一行）与 list（查），没有更新与删除入口；
 * DB 触发器再兜一层，绕过本服务直接写 SQL 也一样改不动。
 */
export class AuditService {
  constructor(private readonly db: PlatformDb) {}

  async record(entry: AuditEntry): Promise<void> {
    // 拒绝必须给得出理由：DB 上有 CHECK，先在这里拦下来，报错更贴近出事的地方。
    if (entry.decision === 'denied' && !entry.denialReason) {
      throw new Error(`审计记录不完整：decision=denied 时必须给出 denialReason（action=${entry.action}）`)
    }

    await this.db.insert(auditLog).values({
      actorKind: entry.actorKind,
      actorId: entry.actorId ?? null,
      actorName: entry.actorName,
      apiKeyId: entry.apiKeyId ?? null,
      apiKeyPrefix: entry.apiKeyPrefix ?? null,
      datasourceId: entry.datasourceId ?? null,
      datasourceName: entry.datasourceName ?? null,
      engine: entry.engine ?? null,
      action: entry.action,
      toolName: entry.toolName ?? null,
      sqlText: entry.sqlText ? entry.sqlText.slice(0, MAX_SQL_TEXT_CHARS) : null,
      classification: entry.classification ?? null,
      decision: entry.decision,
      denialReason: entry.denialReason ?? null,
      rowCount: entry.rowCount ?? null,
      durationMs: entry.durationMs ?? null,
      clientIp: entry.clientIp ?? null,
      errorCode: entry.errorCode ?? null,
      errorMessage: entry.errorMessage ?? null,
      detail: entry.detail ?? null,
    })
  }

  /**
   * 管理面用：审计写失败不该把登录这类操作也拖垮，记日志放行。
   * MCP 执行路径**不能**用这个——那里审计失败必须让调用方知道。
   */
  async tryRecord(entry: AuditEntry): Promise<boolean> {
    try {
      await this.record(entry)
      return true
    } catch (err) {
      console.error('[audit] 写入失败：', err)
      return false
    }
  }

  async list(query: AuditLogQuery): Promise<AuditLogPage> {
    const conditions: SQL[] = []
    if (query.apiKeyId !== undefined) conditions.push(eq(auditLog.apiKeyId, query.apiKeyId))
    if (query.datasourceId !== undefined) {
      conditions.push(eq(auditLog.datasourceId, query.datasourceId))
    }
    if (query.decision !== undefined) conditions.push(eq(auditLog.decision, query.decision))
    if (query.classification !== undefined) {
      conditions.push(eq(auditLog.classification, query.classification))
    }
    if (query.action !== undefined) conditions.push(eq(auditLog.action, query.action))
    if (query.from !== undefined) conditions.push(gte(auditLog.createdAt, new Date(query.from)))
    if (query.to !== undefined) conditions.push(lte(auditLog.createdAt, new Date(query.to)))

    const where = conditions.length > 0 ? and(...conditions) : undefined

    const totalRows = await this.db
      .select({ total: sql<number>`cast(count(*) as int)` })
      .from(auditLog)
      .where(where)

    const rows = await this.db
      .select()
      .from(auditLog)
      .where(where)
      .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize)

    return {
      items: rows.map(toAuditLog),
      total: totalRows[0]?.total ?? 0,
      page: query.page,
      pageSize: query.pageSize,
    }
  }
}

type AuditLogRow = typeof auditLog.$inferSelect

function toAuditLog(row: AuditLogRow): AuditLog {
  return {
    id: row.id,
    actorKind: row.actorKind,
    actorName: row.actorName,
    apiKeyId: row.apiKeyId,
    apiKeyPrefix: row.apiKeyPrefix,
    datasourceId: row.datasourceId,
    datasourceName: row.datasourceName,
    engine: row.engine,
    action: row.action,
    toolName: row.toolName,
    sqlText: row.sqlText,
    classification: row.classification,
    decision: row.decision,
    denialReason: row.denialReason,
    rowCount: row.rowCount,
    durationMs: row.durationMs,
    clientIp: row.clientIp,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    detail: row.detail,
    createdAt: row.createdAt.toISOString(),
  }
}

/** 授权快照：拒绝时把「当时允许什么」记进 detail，事后不必去猜。 */
export function grantSnapshot(grant: Pick<ApiKeyGrant, 'canRead' | 'canWrite'> | undefined): {
  granted: { canRead: boolean; canWrite: boolean }
} {
  return { granted: { canRead: grant?.canRead ?? false, canWrite: grant?.canWrite ?? false } }
}
