/** 审计动作词表与中文标签。服务端写、前端展示，两处必须同源，否则界面上会出现没见过的动作名。 */
export const AUDIT_ACTIONS = [
  'auth.login',
  'auth.login_failed',
  'auth.logout',
  'datasource.create',
  'datasource.update',
  'datasource.delete',
  'datasource.test',
  'api_key.create',
  'api_key.update',
  'api_key.grants',
  'api_key.revoke',
  'mcp.list_datasources',
  'mcp.list_tables',
  'mcp.describe_table',
  'mcp.query',
  'mcp.execute',
  'mcp.unknown_tool',
] as const

export type AuditAction = (typeof AUDIT_ACTIONS)[number]

export const AUDIT_ACTION_LABEL: Record<AuditAction, string> = {
  'auth.login': '管理员登录',
  'auth.login_failed': '登录失败',
  'auth.logout': '管理员登出',
  'datasource.create': '新建数据源',
  'datasource.update': '修改数据源',
  'datasource.delete': '删除数据源',
  'datasource.test': '测试连接',
  'api_key.create': '新建密钥',
  'api_key.update': '修改密钥',
  'api_key.grants': '调整授权',
  'api_key.revoke': '吊销密钥',
  'mcp.list_datasources': '列出数据源',
  'mcp.list_tables': '列出数据表',
  'mcp.describe_table': '查看表结构',
  'mcp.query': '执行查询',
  'mcp.execute': '执行写操作',
  'mcp.unknown_tool': '调用未知工具',
}

export function isAuditAction(value: string): value is AuditAction {
  return (AUDIT_ACTIONS as readonly string[]).includes(value)
}

/** 调用方是人还是 Agent。 */
export const ACTOR_KINDS = ['admin', 'agent'] as const
export type ActorKind = (typeof ACTOR_KINDS)[number]

export const ACTOR_KIND_LABEL: Record<ActorKind, string> = {
  admin: '管理员',
  agent: 'Agent',
}

/** 授权判定结果。 */
export const AUDIT_DECISIONS = ['granted', 'denied'] as const
export type AuditDecision = (typeof AUDIT_DECISIONS)[number]

export const AUDIT_DECISION_LABEL: Record<AuditDecision, string> = {
  granted: '通过',
  denied: '拒绝',
}
