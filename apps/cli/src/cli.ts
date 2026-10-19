import { homedir } from 'node:os'
import { parseArgs } from 'node:util'

import { runConnect } from './commands/connect'
import { runDatasource } from './commands/datasource'
import { runDatasourceList } from './commands/datasource-list'
import { runDisconnect } from './commands/disconnect'
import { runScan } from './commands/scan'
import { runSetup } from './commands/setup'
import type { CommandContext } from './commands/shared'
import { resolveTarget } from './core/connection-store'
import { CliError, EXIT_OK, EXIT_USAGE, isCliError } from './core/errors'
import { createOutput, type Output } from './core/output'
import { createPrompts, type Prompts } from './core/prompts'
import { DEFAULT_SERVER_ORIGIN } from './core/url'
import { CLI_VERSION } from './core/version'

export interface MainOptions {
  stdout?: NodeJS.WritableStream
  stderr?: NodeJS.WritableStream
  homeDir?: string
  fetchImpl?: typeof fetch
  color?: boolean
  /** 注入交互输入实现，测试用；省略时按需懒加载 @inquirer/prompts。 */
  prompts?: Prompts
}

interface ParsedArgs {
  values: {
    url?: string
    key?: string
    agents?: string
    name?: string
    engine?: string
    host?: string
    port?: string
    database?: string
    username?: string
    password?: string
    'admin-user'?: string
    'admin-password'?: string
    write?: boolean
    'dry-run'?: boolean
    'skip-validate'?: boolean
    help?: boolean
    version?: boolean
  }
  positionals: string[]
}

const USAGE = `dblab ${CLI_VERSION} — 把本机的 Agent 客户端接到 DbLab

默认服务地址：${DEFAULT_SERVER_ORIGIN}（docker-compose 映射的宿主机端口；源码直跑用 --url http://localhost:4000）

用法：
  dblab setup [--url <地址>]                 交互向导：填地址与密钥，扫描本机客户端并写入
  dblab scan                                 只扫描，不写任何文件
  dblab connect --key <密钥> [--url <地址>] [--agents <列表>] [--dry-run] [--skip-validate]
                                             非交互写入；--agents 省略时作用于全部已检测客户端
  dblab disconnect [--agents <列表>]         移除 dblab 条目（其余配置保留）
  dblab datasource [add] [...]               注册数据源，并自动授权给当前这把密钥
  dblab datasource list [--key <密钥>]       列出这把密钥被授权的数据源与读写权限

可选客户端 id：
  claude-code, cursor, codex, qoder, qoder-cn

datasource 的 --key 可以省略：connect / setup 会把这次用的密钥与地址记在
  ~/.dblab/config.json，省略时就用它（输出里会写明密钥是哪来的）。
  显式传 --key 时地址仍按 --url 或默认值走，不会被记录里的地址带跑。
  disconnect 不带 --agents 时连同这份记录一起清掉。

datasource 的参数（省略必填项时走交互补齐）：
  --name <名字> --engine postgres|mysql --host <主机> --port <端口>
  --database <库名> --username <账号> --password <口令>
  --write            同时给写权限（省略则只读）
  --admin-user <账号> --admin-password <口令>
                     建数据源与改授权只能用管理员会话；口令优先用环境变量
                     DBLAB_ADMIN_PASSWORD，目标库口令优先用 DBLAB_DB_PASSWORD

datasource list 不用管理员口令：它就以那把密钥的身份连 /mcp，
  列出的正是 Agent 实际能看到的视图。

退出码：0 成功 / 1 校验失败 / 2 用法错误 / 3 写入或探测失败`

export async function main(argv: string[], options: MainOptions = {}): Promise<number> {
  const out = createOutput({
    ...(options.stdout ? { stdout: options.stdout } : {}),
    ...(options.stderr ? { stderr: options.stderr } : {}),
    ...(options.color !== undefined ? { color: options.color } : {}),
  })

  let parsed: ParsedArgs
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        url: { type: 'string' },
        key: { type: 'string' },
        agents: { type: 'string' },
        name: { type: 'string' },
        engine: { type: 'string' },
        host: { type: 'string' },
        port: { type: 'string' },
        database: { type: 'string' },
        username: { type: 'string' },
        password: { type: 'string' },
        'admin-user': { type: 'string' },
        'admin-password': { type: 'string' },
        write: { type: 'boolean' },
        'dry-run': { type: 'boolean' },
        'skip-validate': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    }) as ParsedArgs
  } catch (error) {
    out.error(error instanceof Error ? error.message : '参数解析失败')
    out.plain('')
    out.plain(USAGE)
    return EXIT_USAGE
  }

  if (parsed.values.version) {
    out.plain(CLI_VERSION)
    return EXIT_OK
  }

  const command = parsed.positionals[0]
  if (parsed.values.help || command === undefined || command === 'help') {
    out.plain(USAGE)
    return command === undefined && !parsed.values.help ? EXIT_USAGE : EXIT_OK
  }

  const ctx: CommandContext = {
    homeDir: options.homeDir ?? homedir(),
    out,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  }

  try {
    switch (command) {
      case 'scan':
        return await runScan(ctx)
      case 'setup':
        return await runSetup(ctx, {
          prompts: await createPrompts(),
          ...(parsed.values.url !== undefined ? { url: parsed.values.url } : {}),
        })
      case 'connect':
        return await runConnect(ctx, {
          url: parsed.values.url ?? DEFAULT_SERVER_ORIGIN,
          key: requireFlag(parsed.values.key, '--key'),
          ...(parsed.values.agents !== undefined ? { agents: parsed.values.agents } : {}),
          ...(parsed.values['dry-run'] ? { dryRun: true } : {}),
          ...(parsed.values['skip-validate'] ? { skipValidate: true } : {}),
        })
      case 'disconnect':
        return await runDisconnect(ctx, {
          ...(parsed.values.agents !== undefined ? { agents: parsed.values.agents } : {}),
        })
      case 'datasource': {
        const sub = parsed.positionals[1]
        if (sub !== undefined && sub !== 'add' && sub !== 'list') {
          throw new CliError(
            'usage',
            `未知的 datasource 子命令：${sub}`,
            '可用：add（省略子命令时就是它，注册并授权）、list（列出这把密钥的权限）。',
          )
        }

        // 先把目标密钥拦下来，别为了一个用法错误去加载交互库。
        const target = await resolveTarget({
          homeDir: ctx.homeDir,
          ...(parsed.values.url !== undefined ? { url: parsed.values.url } : {}),
          ...(parsed.values.key !== undefined ? { key: parsed.values.key } : {}),
        })

        if (sub === 'list') {
          return await runDatasourceList(ctx, {
            mcpUrl: target.mcpUrl,
            apiKey: target.apiKey,
            keySource: target.source,
          })
        }

        // 只有这四项真的没法默认；host/port/口令有兜底值，缺了也不算「需要交互」。
        const required = {
          name: parsed.values.name,
          engine: parsed.values.engine,
          database: parsed.values.database,
          username: parsed.values.username,
        }
        const incomplete = Object.values(required).some((value) => value === undefined)
        const prompts = options.prompts ?? (incomplete ? await createPrompts() : undefined)

        return await runDatasource(ctx, {
          key: target.apiKey,
          keySource: target.source,
          ...compact({
            url: target.mcpUrl,
            name: parsed.values.name,
            engine: parsed.values.engine,
            host: parsed.values.host,
            port: parsed.values.port,
            database: parsed.values.database,
            username: parsed.values.username,
            password: parsed.values.password,
            adminUser: parsed.values['admin-user'],
            adminPassword: parsed.values['admin-password'],
          }),
          ...(prompts ? { prompts } : {}),
          ...(parsed.values.write ? { write: true } : {}),
        })
      }
      default:
        throw new CliError(
          'usage',
          `未知命令：${command}`,
          '可用命令：setup、scan、connect、disconnect、datasource（含 datasource list）。',
        )
    }
  } catch (error) {
    return reportError(out, error)
  }
}

function requireFlag(value: string | undefined, flag: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new CliError('usage', `缺少 ${flag}`, `例如 dblab connect --url ${DEFAULT_SERVER_ORIGIN} --key dblab_...`)
  }
  return value
}

/** 去掉 undefined，避免把 `key: undefined` 显式塞进带 exactOptionalPropertyTypes 的入参。 */
function compact<T extends Record<string, string | undefined>>(input: T): Partial<T> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) result[key] = value
  }
  return result as Partial<T>
}

function reportError(out: Output, error: unknown): number {
  if (isCliError(error)) {
    out.error(error.message)
    if (error.hint) out.plain(`  ${error.hint}`)
    return error.exitCode
  }
  out.error(`未预期的错误：${error instanceof Error ? error.message : String(error)}`)
  return EXIT_USAGE
}
