/**
 * 中文标签的唯一出处。枚举词表本身在 @dblab/shared（服务端与前端同源），
 * 这里只补两件 shared 管不到的事：① 未知值的兜底，② 颜色基调（tone）。
 * 组件里不允许内联枚举中文字面量，标签一律从这里取。
 */
import {
  AUDIT_ACTION_LABEL,
  AUDIT_DECISION_LABEL,
  API_KEY_STATUS_LABEL,
  ACTOR_KIND_LABEL,
  ENGINE_LABEL,
  SQL_CLASS_LABEL,
  isAuditAction,
  isSqlClass,
  type ActorKind,
  type ApiKeyStatus,
  type AuditDecision,
  type Engine,
  type SqlClass,
} from '@dblab/shared'

/** 状态徽章的色基调。颜色只在 StatusBadge 里落地，这里只给「哪一族」。 */
export type Tone = 'ok' | 'warn' | 'danger' | 'neutral' | 'accent'

export function engineLabel(engine: Engine | string): string {
  return ENGINE_LABEL[engine as Engine] ?? String(engine)
}

export function apiKeyStatusLabel(status: ApiKeyStatus | string): string {
  return API_KEY_STATUS_LABEL[status as ApiKeyStatus] ?? String(status)
}

export function apiKeyStatusTone(status: ApiKeyStatus | string): Tone {
  if (status === 'active') return 'ok'
  if (status === 'disabled') return 'warn'
  if (status === 'revoked') return 'danger'
  return 'neutral'
}

export function actorKindLabel(kind: ActorKind | string): string {
  return ACTOR_KIND_LABEL[kind as ActorKind] ?? String(kind)
}

export function decisionLabel(decision: AuditDecision | string): string {
  return AUDIT_DECISION_LABEL[decision as AuditDecision] ?? String(decision)
}

export function decisionTone(decision: AuditDecision | string): Tone {
  if (decision === 'granted') return 'ok'
  if (decision === 'denied') return 'danger'
  return 'neutral'
}

export function sqlClassLabel(cls: SqlClass | string | null | undefined): string {
  if (!cls) return '—'
  return isSqlClass(cls) ? SQL_CLASS_LABEL[cls] : String(cls)
}

export function sqlClassTone(cls: SqlClass | string | null | undefined): Tone {
  if (cls === 'read') return 'accent'
  if (cls === 'write') return 'warn'
  if (cls === 'denied') return 'danger'
  return 'neutral'
}

export function auditActionLabel(action: string): string {
  return isAuditAction(action) ? AUDIT_ACTION_LABEL[action] : action
}
