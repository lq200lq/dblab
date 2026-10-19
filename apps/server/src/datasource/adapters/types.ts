import type {
  DatasourceTestResult,
  Engine,
  QueryResult,
  TableDescription,
  TableSummary,
} from '@dblab/shared'

/** 适配器层的小工具：错误文案脱敏与取值。 */

export interface ExecuteOptions {
  /** 返回行数上限；只对读生效。 */
  maxRows: number
  statementTimeoutMs: number
}

/**
 * 一个数据源的执行面。
 * 连通性探测在池之外另开连接，查询与内省走池。
 */
export interface DriverAdapter {
  readonly engine: Engine
  testConnection(): Promise<DatasourceTestResult>
  listTables(schema?: string): Promise<TableSummary[]>
  /** 表不存在时返回 null——由调用方决定怎么说这句话。 */
  describeTable(table: string, schema?: string): Promise<TableDescription | null>
  /**
   * 在**只读事务**里执行。写语句在这里会被数据库自己拒掉，
   * 这是语句分类器之外的第二层，也是唯一真正的安全边界。
   */
  executeRead(sql: string, options: ExecuteOptions): Promise<QueryResult>
  executeWrite(sql: string, options: ExecuteOptions): Promise<QueryResult>
  close(): Promise<void>
}

/**
 * 执行期失败。带上平台错误码与**已脱敏**的文案：
 * 适配器知道自己连接口令，脱敏必须在它这一层做完，别把原始文案往上传。
 */
export class DriverError extends Error {
  readonly code: 'QUERY_TIMEOUT' | 'QUERY_FAILED'

  constructor(code: 'QUERY_TIMEOUT' | 'QUERY_FAILED', message: string) {
    super(message)
    this.name = 'DriverError'
    this.code = code
  }
}

export function isDriverError(error: unknown): error is DriverError {
  return error instanceof DriverError
}

/** 把驱动返回的原始错误码翻成平台错误码，供审计与界面展示。 */
export type DriverErrorCode = 'DATASOURCE_AUTH_FAILED' | 'DATASOURCE_UNREACHABLE'

/** 错误文案要脱敏后再落库/展示：驱动有时会把连接串回显出来。 */
export function redactSecrets(text: string, secrets: ReadonlyArray<string | undefined>): string {
  let out = text
  for (const secret of secrets) {
    if (secret && secret.length > 0) out = out.split(secret).join('***')
  }
  return out
}

/**
 * 驱动错误文案是否值得展示。
 *
 * 连接/认证阶段的 FATAL 是数据库用**服务器端编码**发出的（本机 PostgreSQL 的
 * lc_messages 是 Chinese (Simplified)_China.936），而 client_encoding 的协商还没生效，
 * 到 Node 侧已经被解成替换字符，重解也救不回来。这种文案直接丢掉，
 * 由调用方改用平台自己的中文码文案——界面与审计里宁可少一句细节，也不显示乱码。
 */
export function safeDriverMessage(
  raw: string,
  secrets: ReadonlyArray<string | undefined>,
): string | null {
  const redacted = redactSecrets(raw, secrets)
  if (redacted.includes('\ufffd')) return null
  return redacted
}

export function errorMessageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
