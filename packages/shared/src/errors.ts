/**
 * 错误码的唯一来源：HTTP 状态、中文兜底文案、以及用于审计 denial_reason 的小写形式都在这里对齐。
 * 服务端只发 code + message，前端不自己编中文——兜底文案也取这里。
 */
export const ERROR_CODES = [
  // 管理面鉴权
  'UNAUTHORIZED',
  'INVALID_CREDENTIALS',
  'FORBIDDEN',

  // 通用
  'NOT_FOUND',
  'VALIDATION_FAILED',
  'CONFLICT',
  'INTERNAL',

  // 数据源
  'DATASOURCE_NOT_FOUND',
  'DATASOURCE_NAME_TAKEN',
  'DATASOURCE_DISABLED',
  'DATASOURCE_UNREACHABLE',
  'DATASOURCE_AUTH_FAILED',
  'MASTER_KEY_UNAVAILABLE',
  'CREDENTIAL_UNDECRYPTABLE',

  // API 密钥
  'API_KEY_NOT_FOUND',
  'API_KEY_INVALID',
  'API_KEY_EXPIRED',
  'API_KEY_REVOKED',
  'API_KEY_DISABLED',
  'IP_NOT_ALLOWED',

  // MCP 授权与语句闸门
  'DATASOURCE_NOT_FOUND_OR_UNAUTHORIZED',
  'NO_READ_GRANT',
  'NO_WRITE_GRANT',
  'DDL_FORBIDDEN',
  'MULTI_STATEMENT_FORBIDDEN',
  'HAZARD_STATEMENT_FORBIDDEN',
  'TRANSACTION_CONTROL_FORBIDDEN',
  'EMPTY_STATEMENT',
  'UNKNOWN_STATEMENT',
  'SQL_TOO_LARGE',
  'WRITE_STATEMENT_IN_READ_TOOL',
  'QUERY_TIMEOUT',
  'QUERY_FAILED',
  'UNKNOWN_TOOL',
  'AUDIT_WRITE_FAILED',
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

export function isErrorCode(value: string): value is ErrorCode {
  return (ERROR_CODES as readonly string[]).includes(value)
}

export const HTTP_STATUS_BY_CODE: Record<ErrorCode, number> = {
  UNAUTHORIZED: 401,
  INVALID_CREDENTIALS: 401,
  FORBIDDEN: 403,

  NOT_FOUND: 404,
  VALIDATION_FAILED: 400,
  CONFLICT: 409,
  INTERNAL: 500,

  DATASOURCE_NOT_FOUND: 404,
  DATASOURCE_NAME_TAKEN: 409,
  DATASOURCE_DISABLED: 409,
  DATASOURCE_UNREACHABLE: 502,
  DATASOURCE_AUTH_FAILED: 502,
  MASTER_KEY_UNAVAILABLE: 500,
  CREDENTIAL_UNDECRYPTABLE: 500,

  API_KEY_NOT_FOUND: 404,
  API_KEY_INVALID: 401,
  API_KEY_EXPIRED: 401,
  API_KEY_REVOKED: 401,
  API_KEY_DISABLED: 401,
  IP_NOT_ALLOWED: 403,

  DATASOURCE_NOT_FOUND_OR_UNAUTHORIZED: 403,
  NO_READ_GRANT: 403,
  NO_WRITE_GRANT: 403,
  DDL_FORBIDDEN: 403,
  MULTI_STATEMENT_FORBIDDEN: 403,
  HAZARD_STATEMENT_FORBIDDEN: 403,
  TRANSACTION_CONTROL_FORBIDDEN: 403,
  EMPTY_STATEMENT: 400,
  UNKNOWN_STATEMENT: 400,
  SQL_TOO_LARGE: 413,
  WRITE_STATEMENT_IN_READ_TOOL: 403,
  QUERY_TIMEOUT: 504,
  QUERY_FAILED: 400,
  UNKNOWN_TOOL: 404,
  AUDIT_WRITE_FAILED: 500,
}

/** 服务端没给 message 时前端用的兜底中文。 */
export const ERROR_MESSAGE_BY_CODE: Record<ErrorCode, string> = {
  UNAUTHORIZED: '请先登录',
  INVALID_CREDENTIALS: '账号或密码不正确',
  FORBIDDEN: '没有权限执行该操作',

  NOT_FOUND: '资源不存在',
  VALIDATION_FAILED: '提交的内容不合法',
  CONFLICT: '与现有数据冲突',
  INTERNAL: '服务端内部错误',

  DATASOURCE_NOT_FOUND: '数据源不存在',
  DATASOURCE_NAME_TAKEN: '数据源名称已被占用',
  DATASOURCE_DISABLED: '该数据源已停用',
  DATASOURCE_UNREACHABLE: '无法连接该数据源',
  DATASOURCE_AUTH_FAILED: '数据源账号或口令不正确',
  MASTER_KEY_UNAVAILABLE: '凭据主密钥不可用，无法加解密数据源口令',
  CREDENTIAL_UNDECRYPTABLE: '数据源口令解不开，可能是主密钥已变更',

  API_KEY_NOT_FOUND: '密钥不存在',
  API_KEY_INVALID: '密钥无效',
  API_KEY_EXPIRED: '密钥已过期',
  API_KEY_REVOKED: '密钥已被吊销',
  API_KEY_DISABLED: '密钥已被停用',
  IP_NOT_ALLOWED: '调用来源 IP 不在白名单内',

  DATASOURCE_NOT_FOUND_OR_UNAUTHORIZED: '数据源不存在或未授权',
  NO_READ_GRANT: '该密钥没有此数据源的读权限',
  NO_WRITE_GRANT: '该密钥没有此数据源的写权限',
  DDL_FORBIDDEN: '平台不允许执行结构变更语句（DDL）',
  MULTI_STATEMENT_FORBIDDEN: '平台不允许一次执行多条语句',
  HAZARD_STATEMENT_FORBIDDEN: '该语句被平台判定为高风险，已拒绝',
  TRANSACTION_CONTROL_FORBIDDEN: '平台不允许客户端自行控制事务',
  EMPTY_STATEMENT: '没有可执行的语句',
  UNKNOWN_STATEMENT: '无法识别的语句',
  SQL_TOO_LARGE: '语句长度超出上限',
  WRITE_STATEMENT_IN_READ_TOOL: '写入语句请调用 execute 工具',
  QUERY_TIMEOUT: '语句执行超时',
  QUERY_FAILED: '语句执行失败',
  UNKNOWN_TOOL: '未知的工具名',
  AUDIT_WRITE_FAILED: '审计记录写入失败，操作结果未能记账',
}

/** 审计里的 denial_reason 用同一套词表的小写形式，避免两套命名漂移。 */
export function toDenialReason(code: ErrorCode): string {
  return code.toLowerCase()
}

export interface ApiErrorBody {
  code: ErrorCode
  message: string
  details?: unknown
}

/** 服务端与前端共用的一句判定，避免两边各自写 typeof 检查。 */
export function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.code === 'string' && typeof candidate.message === 'string'
}
