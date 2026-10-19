import { z } from 'zod'

import { ACTOR_KINDS, AUDIT_ACTIONS, AUDIT_DECISIONS } from '../audit'
import { ERROR_CODES } from '../errors'
import { SQL_CLASSES } from '../sql/class'

import { engineSchema, idSchema, isoDateTimeSchema, pageQuerySchema } from './common'
import { paginated } from './common'

export const auditLogQuerySchema = pageQuerySchema.extend({
  apiKeyId: z.coerce.number().int().positive().optional(),
  datasourceId: z.coerce.number().int().positive().optional(),
  decision: z.enum(AUDIT_DECISIONS).optional(),
  classification: z.enum(SQL_CLASSES).optional(),
  action: z.enum(AUDIT_ACTIONS).optional(),
  from: isoDateTimeSchema.optional(),
  to: isoDateTimeSchema.optional(),
})
export type AuditLogQuery = z.infer<typeof auditLogQuerySchema>

export const auditLogSchema = z.object({
  id: idSchema,
  actorKind: z.enum(ACTOR_KINDS),
  actorName: z.string(),
  apiKeyId: idSchema.nullable(),
  apiKeyPrefix: z.string().nullable(),
  datasourceId: idSchema.nullable(),
  /** 反范式字段：数据源或密钥被删掉后，历史记录仍能说明当时打的是谁。 */
  datasourceName: z.string().nullable(),
  engine: engineSchema.nullable(),
  action: z.enum(AUDIT_ACTIONS),
  toolName: z.string().nullable(),
  sqlText: z.string().nullable(),
  classification: z.enum(SQL_CLASSES).nullable(),
  decision: z.enum(AUDIT_DECISIONS),
  denialReason: z.string().nullable(),
  rowCount: z.number().int().nullable(),
  durationMs: z.number().int().nullable(),
  clientIp: z.string().nullable(),
  errorCode: z.enum(ERROR_CODES).nullable(),
  errorMessage: z.string().nullable(),
  detail: z.unknown().nullable(),
  createdAt: isoDateTimeSchema,
})
export type AuditLog = z.infer<typeof auditLogSchema>

export const auditLogPageSchema = paginated(auditLogSchema)
export type AuditLogPage = z.infer<typeof auditLogPageSchema>
