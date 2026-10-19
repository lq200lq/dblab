import { decryptSecret, datasource, type PlatformDb } from '@dblab/db'

export type DatasourceRow = typeof datasource.$inferSelect

/**
 * 解析后的驱动连接参数：口令已解密，字段名与驱动入参对齐。
 * 适配器只认连接参数，不认平台概念（id/名称/启停）。
 */
export interface ResolvedDriverConfig {
  engine: DatasourceRow['engine']
  host: string
  port: number
  database: string
  user: string
  password: string
  /** 是否走 TLS。 */
  ssl: boolean
  /** 是否校验证书链与主机名。缺省即校验。 */
  sslVerify: boolean
}

/**
 * 连接开关的取值口径：ssl 缺省关，sslVerify 缺省开（安全默认）。
 * 落库的行与「还没落库的表单」都必须走这里，否则两处的 TLS 语义会悄悄分叉。
 */
export function sslFlagsOf(options: { ssl?: boolean; sslVerify?: boolean }): {
  ssl: boolean
  sslVerify: boolean
} {
  return { ssl: options.ssl === true, sslVerify: options.sslVerify !== false }
}

/**
 * 行 → 连接参数。口令解密失败会抛带码异常（主密钥不可用 / 密文解不开），
 * 由统一错误处理翻成对外错误码；**绝不返回空口令**——空口令会被读成「没配口令」。
 */
export function resolveDriverConfig(row: DatasourceRow): ResolvedDriverConfig {
  return {
    engine: row.engine,
    host: row.host,
    port: row.port,
    database: row.databaseName,
    user: row.username,
    password: decryptSecret(row.passwordCiphertext),
    ...sslFlagsOf(row.connectOptions),
  }
}
