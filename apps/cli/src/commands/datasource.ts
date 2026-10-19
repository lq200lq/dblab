import { AdminApi, DEFAULT_PORT, ENGINE_LABEL, type DatasourceInput, type Engine } from '../core/admin-api'
import { sourceLabel, type ConnectionSource } from '../core/connection-store'
import { CliError } from '../core/errors'
import { apiKeyPrefixOf, assertApiKeyShape, maskKey } from '../core/key'
import type { Prompts } from '../core/prompts'
import { adminBaseUrlOf, DEFAULT_SERVER_ORIGIN, normalizeMcpUrl } from '../core/url'

import type { CommandContext } from './shared'

export interface DatasourceOptions {
  url?: string
  /** 要授权的密钥明文；由调用方解析（`--key` 或本机连接记录），到这里必须已经有了。 */
  key: string
  /** 只影响输出文案：让用户看清授权用的是哪来的那把密钥。 */
  keySource?: ConnectionSource
  name?: string
  engine?: string
  host?: string
  port?: string
  database?: string
  username?: string
  /** 目标库口令。命令行传会留在 shell 历史，优先用 DBLAB_DB_PASSWORD 或交互输入。 */
  password?: string
  /** true 给读+写；省略只给读。 */
  write?: boolean
  adminUser?: string
  adminPassword?: string
  /** 交互补齐用的输入实现；非交互（脚本）时省略。 */
  prompts?: Prompts
}

/**
 * 注册数据源并自动授权给指定密钥。
 *
 * 平台只有管理员会话能建数据源与改授权（Agent 那把 API 密钥没有这两个权限），
 * 所以这一步必然要走一次 `admin` 登录。两个口令都只在本次命令的内存里。
 */
export async function runDatasource(
  ctx: CommandContext,
  options: DatasourceOptions,
): Promise<number> {
  const mcpUrl = normalizeMcpUrl(options.url ?? DEFAULT_SERVER_ORIGIN)
  const apiKey = assertApiKeyShape(options.key)

  // 先确认管理员口令，再问一堆连接参数：免得用户填完六项才发现登不上。
  const admin = resolveAdmin(options)
  const input = await collectInput(options)
  const api = new AdminApi({
    baseUrl: adminBaseUrlOf(mcpUrl),
    ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
  })

  ctx.out.plain(`管理面：${adminBaseUrlOf(mcpUrl)}`)
  ctx.out.plain(`目标密钥：${maskKey(apiKey)}（来自 ${sourceLabel(options.keySource ?? 'flag')}）`)

  await api.login(admin.user, admin.password)
  const target = await api.findApiKeyByPrefix(apiKeyPrefixOf(apiKey))
  ctx.out.success(`已登录：${admin.user}　授权目标：密钥「${target.name}」`)

  const probe = await api.probeDatasource(input)
  if (!probe.ok) {
    ctx.out.error(`连通性探测失败：${probe.message ?? '未知原因'}`)
    ctx.out.plain('  没有创建数据源，也没有改动任何授权。')
    return 3
  }
  ctx.out.success(`连通性正常：${probe.serverVersion ?? '已连接'}（${probe.latencyMs}ms）`)

  const created = await api.createDatasource(input)
  const permission = { canRead: true, canWrite: options.write === true }
  await api.grantDatasource(target.id, { id: created.id, name: created.name }, permission)

  ctx.out.success(`已创建并授权：${created.name}（#${created.id}）→ ${grantLabel(permission)}`)
  ctx.out.plain('')
  ctx.out.plain('Agent 侧不用重连：下一次 tools/list 就能看到新库。')
  return 0
}

export function grantLabel(permission: { canRead: boolean; canWrite: boolean }): string {
  if (permission.canRead && permission.canWrite) return '读+写'
  if (permission.canWrite) return '只写'
  return '只读'
}

function resolveAdmin(options: DatasourceOptions): { user: string; password: string } {
  const user = options.adminUser ?? process.env.DBLAB_ADMIN_USER ?? 'admin'
  const password = options.adminPassword ?? process.env.DBLAB_ADMIN_PASSWORD ?? ''
  if (password.length === 0) {
    throw new CliError(
      'usage',
      '缺少管理员口令',
      '用 --admin-password，或设环境变量 DBLAB_ADMIN_PASSWORD（后者不会留在命令历史里）。',
    )
  }
  return { user, password }
}

/** 补齐数据源参数：给了就用给的，缺的在交互模式下问，非交互缺必要项直接报错。 */
async function collectInput(options: DatasourceOptions): Promise<DatasourceInput> {
  const prompts = options.prompts
  const engine = await resolveEngine(options, prompts)

  const name = await resolveText(options.name, prompts, '数据源名称')
  const host = await resolveText(options.host, prompts, '数据库主机', 'localhost')
  const database = await resolveText(options.database, prompts, '库名')
  const username = await resolveText(options.username, prompts, '数据库账号')
  const port = await resolvePort(options.port, engine, prompts)
  const password = await resolvePassword(options, prompts)

  return { name, engine, host, port, database, username, password }
}

async function resolveEngine(options: DatasourceOptions, prompts: Prompts | undefined): Promise<Engine> {
  if (options.engine !== undefined) return assertEngine(options.engine)
  if (prompts === undefined) throw new CliError('usage', '缺少 --engine', '可选 postgres 或 mysql。')
  const answer = await prompts.input({
    message: '数据库类型',
    default: 'postgres',
    validate: (value) => {
      try {
        assertEngine(value)
        return true
      } catch {
        return '只能填 postgres 或 mysql'
      }
    },
  })
  return assertEngine(answer)
}

function assertEngine(value: string): Engine {
  const lowered = value.trim().toLowerCase()
  if (lowered !== 'postgres' && lowered !== 'mysql') {
    throw new CliError('usage', `不支持的引擎：${value}`, '可选 postgres 或 mysql。')
  }
  return lowered
}

async function resolvePort(
  options: string | undefined,
  engine: Engine,
  prompts: Prompts | undefined,
): Promise<number> {
  if (options !== undefined) return assertPort(options)
  // 非交互时按引擎默认端口，省掉一个必填项。
  if (prompts === undefined) return DEFAULT_PORT[engine]
  const answer = await prompts.input({
    message: `端口（${ENGINE_LABEL[engine]}）`,
    default: String(DEFAULT_PORT[engine]),
    validate: (value) => {
      try {
        assertPort(value)
        return true
      } catch {
        return '端口要是 1-65535 的整数'
      }
    },
  })
  return assertPort(answer)
}

function assertPort(value: string): number {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new CliError('usage', `端口不合法：${value}`)
  }
  return port
}

async function resolveText(
  given: string | undefined,
  prompts: Prompts | undefined,
  message: string,
  defaultValue?: string,
): Promise<string> {
  const trimmed = given?.trim()
  if (trimmed !== undefined && trimmed.length > 0) return trimmed

  if (prompts !== undefined) {
    const answer = await prompts.input({
      message,
      ...(defaultValue !== undefined ? { default: defaultValue } : {}),
      validate: (value) => (value.trim().length > 0 ? true : '不能为空'),
    })
    const value = answer.trim()
    if (value.length === 0) throw new CliError('usage', `${message}不能为空`)
    return value
  }

  if (defaultValue !== undefined) return defaultValue
  throw new CliError('usage', `缺少 ${message}`, `加上对应参数，或去掉 --key 之外的必填项改用交互补齐。`)
}

async function resolvePassword(options: DatasourceOptions, prompts: Prompts | undefined): Promise<string> {
  if (options.password !== undefined && options.password.length > 0) return options.password
  const fromEnv = process.env.DBLAB_DB_PASSWORD
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv
  if (prompts !== undefined) return prompts.password({ message: '数据库口令' })

  throw new CliError(
    'usage',
    '缺少数据库口令',
    '用环境变量 DBLAB_DB_PASSWORD（推荐，不进命令历史）、--password，或省略参数走交互输入。',
  )
}
