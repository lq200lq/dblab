import { CliError } from './errors'

/**
 * 管理端 REST 客户端。
 *
 * 只服务「注册数据源 + 授权」这一段：数据源与授权都必须用管理员会话（cookie），
 * Agent 用的 API 密钥没有这两个权限，所以这里走 `/api/v1/auth/login`。
 * 口令只在内存里活到本次命令结束，不落盘、不打印。
 */

export type Engine = 'postgres' | 'mysql'

export const ENGINE_LABEL: Record<Engine, string> = {
  postgres: 'PostgreSQL',
  mysql: 'MySQL',
}

export const DEFAULT_PORT: Record<Engine, number> = {
  postgres: 5432,
  mysql: 3306,
}

export interface DatasourceInput {
  name: string
  engine: Engine
  host: string
  port: number
  database: string
  username: string
  password: string
}

export interface Grant {
  datasourceId: number
  datasourceName: string
  canRead: boolean
  canWrite: boolean
}

export interface DatasourceSummary {
  id: number
  name: string
  engine: Engine
  host: string
  port: number
  database: string
  username: string
  enabled: boolean
}

export interface ProbeResult {
  ok: boolean
  latencyMs: number
  serverVersion: string | null
  message: string | null
}

export interface ApiKeySummary {
  id: number
  name: string
  /** `dblab_<定位段>`，不含秘密段，可以安全打印。 */
  prefix: string
  status: string
}

const DEFAULT_TIMEOUT_MS = 15_000

export interface AdminApiOptions {
  baseUrl: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export class AdminApi {
  private cookie: string | null = null

  constructor(private readonly options: AdminApiOptions) {}

  async login(username: string, password: string): Promise<void> {
    const result = await this.request<{ user: { username: string } }>('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    })
    // 会话只从 set-cookie 里取；拿不到就当登录失败，避免后面每个请求都 401。
    const setCookie = result.headers.get('set-cookie')
    if (setCookie) this.cookie = setCookie.split(';')[0] ?? null
    if (!this.cookie) {
      throw new CliError('validate', `登录异常：服务端没有回传会话 cookie`, '确认地址指向的是 DbLab 管理面。')
    }
  }

  async listDatasources(): Promise<DatasourceSummary[]> {
    const { body } = await this.request<{ items: unknown[] }>('/api/v1/datasources')
    return body.items as DatasourceSummary[]
  }

  async probeDatasource(input: DatasourceInput): Promise<ProbeResult> {
    const { body } = await this.request<ProbeResult>(
      '/api/v1/datasources/test',
      { method: 'POST', body: JSON.stringify(input) },
      'validate',
    )
    return body
  }

  async createDatasource(input: DatasourceInput): Promise<DatasourceSummary> {
    const { body } = await this.request<DatasourceSummary>(
      '/api/v1/datasources',
      { method: 'POST', body: JSON.stringify(input) },
      'write',
    )
    return body
  }

  async listApiKeys(): Promise<ApiKeySummary[]> {
    const { body } = await this.request<{ items: unknown[] }>('/api/v1/api-keys')
    return body.items as ApiKeySummary[]
  }

  async apiKeyGrants(keyId: number): Promise<Grant[]> {
    const { body } = await this.request<{ grants: Grant[] }>(`/api/v1/api-keys/${keyId}`)
    return body.grants
  }

  /**
   * 授权是整表替换，所以必须「读回原有 + 追加新的」再 PUT。
   * 直接 PUT 单条会把这把密钥对其它库的授权全部抹掉。
   */
  async grantDatasource(
    keyId: number,
    datasource: { id: number; name: string },
    permission: { canRead: boolean; canWrite: boolean },
  ): Promise<{ added: boolean; total: number }> {
    const existing = await this.apiKeyGrants(keyId)
    const index = existing.findIndex((grant) => grant.datasourceId === datasource.id)

    if (index === -1) {
      existing.push({ datasourceId: datasource.id, datasourceName: datasource.name, ...permission })
    } else {
      const current = existing[index]!
      // 已有授权不降级：只把读写并进来，避免「再注册一次反而把写权限关掉」。
      existing[index] = {
        ...current,
        canRead: current.canRead || permission.canRead,
        canWrite: current.canWrite || permission.canWrite,
      }
    }

    const payload = existing.map((grant) => ({
      datasourceId: grant.datasourceId,
      canRead: grant.canRead,
      canWrite: grant.canWrite,
    }))

    await this.request(
      `/api/v1/api-keys/${keyId}/grants`,
      { method: 'PUT', body: JSON.stringify({ grants: payload }) },
      'write',
    )

    return { added: true, total: payload.length }
  }

  /** 按明文密钥的定位段找回钥匙记录；找不到就说明这把密钥不属于该服务。 */
  async findApiKeyByPrefix(prefix: string): Promise<ApiKeySummary> {
    const keys = await this.listApiKeys()
    const found = keys.find((key) => key.prefix === prefix)
    if (!found) {
      throw new CliError(
        'validate',
        `这台服务上没有找到前缀为 ${prefix} 的密钥`,
        '确认密钥就是从当前地址这套 DbLab 签发的（换过库或重建过环境就查不到了）。',
      )
    }
    if (found.status !== 'active') {
      throw new CliError('validate', `密钥「${found.name}」当前状态是 ${found.status}`, '请先在管控台启用或重新签发。')
    }
    return found
  }

  private async request<T>(
    path: string,
    init: { method?: string; body?: string } = {},
    /** 决定失败时的退出码：读与校验算 1，落库的写算 3。 */
    kind: 'validate' | 'write' = 'validate',
  ): Promise<{ body: T; headers: Headers }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    const doFetch = this.options.fetchImpl ?? fetch

    try {
      const response = await doFetch(`${this.options.baseUrl}${path}`, {
        method: init.method ?? 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...(this.cookie ? { Cookie: this.cookie } : {}),
        },
        ...(init.body !== undefined ? { body: init.body } : {}),
        signal: controller.signal,
      })

      const text = await response.text()
      const parsed = text.length > 0 ? (JSON.parse(text) as unknown) : null

      if (!response.ok) {
        throw new CliError(kind, messageOf(parsed, response.status), hintForStatus(response.status, path))
      }
      return { body: parsed as T, headers: response.headers }
    } catch (error) {
      if (error instanceof CliError) throw error
      if (error instanceof Error && error.name === 'AbortError') {
        throw new CliError(kind, `请求 ${path} 超时`, '确认服务已启动且地址可达。')
      }
      throw new CliError(
        kind,
        `无法连接 ${this.options.baseUrl}`,
        `服务可能没启动，或 --url 指向了错误端口（compose 是 18400，源码直跑是 4000）。原始错误：${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    } finally {
      clearTimeout(timer)
    }
  }
}

function messageOf(parsed: unknown, status: number): string {
  if (parsed !== null && typeof parsed === 'object') {
    const candidate = parsed as { message?: string; code?: string }
    if (typeof candidate.message === 'string' && candidate.message.length > 0) return candidate.message
  }
  return `管理端请求失败（HTTP ${status}）`
}

function hintForStatus(status: number, path: string): string | undefined {
  if (status === 401) return '管理员账号或口令不正确，或会话已过期——重新执行并确认凭据。'
  if (status === 409 && path === '/api/v1/datasources') {
    return '同名数据源已存在。改个名字，或直接用管控台给它授权。'
  }
  return undefined
}
