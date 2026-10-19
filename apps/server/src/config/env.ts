import { z } from 'zod'

/**
 * 环境变量一次性校验。纯函数、无副作用：启动时调用一次，问题一次性全部抛出，
 * 而不是等到某个请求路径上才发现某个变量是空的。
 */

export interface AppEnv {
  databaseUrl: string
  port: number
  sessionTtlMinutes: number
  sessionCookieName: string
  /** Cookie 是否带 Secure。生产必开，本地 http 必须关，否则浏览器根本不回传。 */
  cookieSecure: boolean
  adminUser: string
  adminPassword: string
  mcpMaxSqlBytes: number
  mcpMaxRows: number
  mcpStatementTimeoutMs: number
  mcpSessionTtlMinutes: number
  /** /mcp 允许的 Host 主机名（不含端口）。含 `*` 表示不校验——只在明确知道自己处于受信网络时这么配。 */
  mcpAllowedHosts: string[]
  poolMax: number
  poolIdleEvictMinutes: number
  trustProxy: boolean
  /** 前端构建产物目录；存在时由服务端同端口托管，空串表示不托管。 */
  webDistDir: string
  isProduction: boolean
}

export interface ParseEnvResult {
  env: AppEnv
  /** 不影响启动但必须让人看见的提示（如回退到默认口令）。 */
  warnings: string[]
}

/** 空字符串按「没配」处理，好让 .env 里的 `KEY=` 落到默认值而不是变成 0。 */
function num(def: number, min = 1, max = Number.MAX_SAFE_INTEGER) {
  return z.preprocess(
    (v) => (v === '' || v === undefined || v === null ? undefined : v),
    z.coerce.number().int().min(min).max(max).default(def),
  )
}

function str(def: string) {
  return z.preprocess(
    (v) => (v === '' || v === undefined || v === null ? undefined : v),
    z.string().min(1).default(def),
  )
}

const envSchema = z.object({
  DATABASE_URL: z.preprocess(
    (v) => (v === '' || v === undefined || v === null ? undefined : v),
    z.string().min(1, '缺少 DATABASE_URL（可复制 .env.example 为 .env）'),
  ),
  PORT: num(4000, 1, 65535),
  SESSION_TTL_MINUTES: num(720),
  SESSION_COOKIE_NAME: str('dblab_session'),
  ADMIN_USER: str('admin'),
  ADMIN_PASSWORD: z.string().default(''),
  MCP_MAX_SQL_BYTES: num(100_000),
  MCP_MAX_ROWS: num(500),
  MCP_STATEMENT_TIMEOUT_MS: num(15_000),
  MCP_SESSION_TTL_MINUTES: num(30),
  MCP_ALLOWED_HOSTS: str('localhost,127.0.0.1,[::1]'),
  POOL_MAX: num(4),
  POOL_IDLE_EVICT_MINUTES: num(15),
  TRUST_PROXY: num(0, 0, 1),
  WEB_DIST_DIR: z.preprocess(
    (v) => (v === '' || v === undefined || v === null ? undefined : v),
    z.string().default(''),
  ),
})

export function parseEnv(source: NodeJS.ProcessEnv = process.env): ParseEnvResult {
  const parsed = envSchema.safeParse(source)
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
    )
    throw new Error(`环境变量不合法：\n  - ${problems.join('\n  - ')}`)
  }

  const raw = parsed.data
  const isProduction = source.NODE_ENV === 'production'
  const warnings: string[] = []

  // 生产必须显式给口令与主密钥：这两项用默认值上线等于没有管控。
  if (isProduction) {
    const missing: string[] = []
    if (!raw.ADMIN_PASSWORD) missing.push('ADMIN_PASSWORD')
    if (!source.CREDENTIAL_MASTER_KEY) missing.push('CREDENTIAL_MASTER_KEY')
    if (missing.length > 0) {
      throw new Error(`生产环境必须显式提供：${missing.join('、')}`)
    }
  }

  let adminPassword = raw.ADMIN_PASSWORD
  if (!adminPassword) {
    adminPassword = 'admin123'
    warnings.push('未设置 ADMIN_PASSWORD，已回退到默认口令 admin123（仅限本地开发）')
  }
  if (isProduction && adminPassword === 'admin123') {
    warnings.push('生产环境仍在使用默认口令 admin123，请尽快改掉')
  }

  return {
    env: {
      databaseUrl: raw.DATABASE_URL,
      port: raw.PORT,
      sessionTtlMinutes: raw.SESSION_TTL_MINUTES,
      sessionCookieName: raw.SESSION_COOKIE_NAME,
      cookieSecure: isProduction,
      adminUser: raw.ADMIN_USER,
      adminPassword,
      mcpMaxSqlBytes: raw.MCP_MAX_SQL_BYTES,
      mcpMaxRows: raw.MCP_MAX_ROWS,
      mcpStatementTimeoutMs: raw.MCP_STATEMENT_TIMEOUT_MS,
      mcpSessionTtlMinutes: raw.MCP_SESSION_TTL_MINUTES,
      mcpAllowedHosts: raw.MCP_ALLOWED_HOSTS.split(',')
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry.length > 0),
      poolMax: raw.POOL_MAX,
      poolIdleEvictMinutes: raw.POOL_IDLE_EVICT_MINUTES,
      trustProxy: raw.TRUST_PROXY === 1,
      webDistDir: raw.WEB_DIST_DIR,
      isProduction,
    },
    warnings,
  }
}
