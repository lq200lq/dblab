import type { ActorKind, AuditAction, AuditDecision, Engine, ErrorCode, SqlClass } from '@dblab/shared'
import { bigint, bigserial, index, inet, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

/**
 * 调用记录，只增不改（由 DB 触发器结构性保证，见迁移 0001）。
 *
 * 故意**不建外键**：数据源或密钥被删掉后，历史记录仍要能说明当时打的是谁，
 * 所以 datasource_name / api_key_prefix 这些字段是反范式的快照。
 *
 * 每次调用只写一行，在结果已知后写一次（含失败与拒绝路径）。
 * 数据源在别的库上，没有共享事务可加入，"先写 pending 再回填" 这条路也不存在。
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    actorKind: text('actor_kind').$type<ActorKind>().notNull(),
    actorId: bigint('actor_id', { mode: 'number' }),
    actorName: text('actor_name').notNull(),
    apiKeyId: bigint('api_key_id', { mode: 'number' }),
    apiKeyPrefix: text('api_key_prefix'),
    datasourceId: bigint('datasource_id', { mode: 'number' }),
    datasourceName: text('datasource_name'),
    engine: text('engine').$type<Engine>(),
    action: text('action').$type<AuditAction>().notNull(),
    toolName: text('tool_name'),
    sqlText: text('sql_text'),
    classification: text('classification').$type<SqlClass>(),
    decision: text('decision').$type<AuditDecision>().notNull(),
    denialReason: text('denial_reason'),
    rowCount: integer('row_count'),
    durationMs: integer('duration_ms'),
    clientIp: inet('client_ip'),
    errorCode: text('error_code').$type<ErrorCode>(),
    errorMessage: text('error_message'),
    detail: jsonb('detail').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_log_created_idx').on(t.createdAt.desc(), t.id.desc()),
    index('audit_log_key_created_idx').on(t.apiKeyId, t.createdAt),
    index('audit_log_datasource_created_idx').on(t.datasourceId, t.createdAt),
    index('audit_log_decision_created_idx').on(t.decision, t.createdAt),
  ],
)
