import { buildEntry, type McpEntry } from '../adapters/types'
import { connectionConfigPath, saveConnection } from '../core/connection-store'
import { assertApiKeyShape, maskKey } from '../core/key'
import { normalizeMcpUrl } from '../core/url'
import { validateApiKey } from '../core/validate'

import {
  ACTION_LABEL,
  assertWritable,
  parseAgentIds,
  printHeader,
  resolveTargets,
  writeAll,
  type CommandContext,
} from './shared'

export interface ConnectOptions {
  url: string
  key: string
  agents?: string
  dryRun?: boolean
  /** 跳过联网校验：服务暂时不可达但仍想先落配置时用。 */
  skipValidate?: boolean
}

export async function runConnect(ctx: CommandContext, options: ConnectOptions): Promise<number> {
  const mcpUrl = normalizeMcpUrl(options.url)
  const apiKey = assertApiKeyShape(options.key)
  const targets = await resolveTargets(ctx.homeDir, parseAgentIds(options.agents))

  ctx.out.plain(`服务地址：${mcpUrl}`)
  ctx.out.plain(`密钥：${maskKey(apiKey)}`)
  ctx.out.plain('')

  if (options.dryRun) {
    // dry-run 是离线预览：不联网、不写盘，只让人看清将要写入的形态。
    ctx.out.warn('--dry-run：不联网校验、不写文件')
  } else if (options.skipValidate) {
    ctx.out.warn('已跳过联网校验（--skip-validate）')
  } else {
    const result = await validateApiKey({
      mcpUrl,
      apiKey,
      ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
    })
    if (!result.ok) {
      ctx.out.error(`校验失败：${result.message}`)
      if (result.hint) ctx.out.plain(`  ${result.hint}`)
      return 1
    }
    ctx.out.success(`校验通过：${serverLabel(result.serverName, result.serverVersion)}`)
  }

  // 任何一份文件解析不了都不写；先全量预检，避免写一半留一半。
  assertWritable(targets)

  const entry = buildEntry(mcpUrl, apiKey)
  if (options.dryRun) {
    ctx.out.plain('')
    ctx.out.plain('将写入以下内容（密钥已脱敏）。整份配置文件不动，只新增或替换 dblab 这一处：')
    const masked = maskEntry(entry)
    for (const target of targets) {
      ctx.out.plain('')
      ctx.out.plain(`  ${target.adapter.displayName}  ${target.detection.configPath}`)
      for (const line of target.adapter.renderEntry(masked).split('\n')) {
        ctx.out.plain(`    ${line}`)
      }
    }
    return 0
  }

  const outcomes = await writeAll(targets, entry, ctx)

  ctx.out.plain('')
  printHeader(ctx.out, '写入结果：')
  for (const { target, result } of outcomes) {
    ctx.out.plain(`  ${target.adapter.displayName}  ${ACTION_LABEL[result.action]}  ${result.path}`)
    if (result.backupPath) ctx.out.plain(`    备份：${result.backupPath}`)
  }

  // 记完客户端再落这份记录：dry-run 走不到这里，所以它永远不会写盘。
  await saveConnection(ctx.homeDir, { url: mcpUrl, key: apiKey })
  ctx.out.plain('')
  ctx.out.plain(`已记录本机连接：${maskKey(apiKey)} → ${mcpUrl}`)
  ctx.out.plain(`  ${connectionConfigPath(ctx.homeDir)}`)
  ctx.out.plain('')
  ctx.out.plain('重启对应的 Agent 客户端即可加载 dblab 工具。')
  return 0
}

export function serverLabel(name?: string, version?: string): string {
  return [name ?? 'dblab', version ?? ''].join(' ').trim()
}

/** dry-run 只展示形态，Authorization 一律脱敏。 */
function maskEntry(entry: McpEntry): McpEntry {
  const secret = (entry.headers.Authorization ?? '').replace(/^Bearer\s+/, '')
  return { ...entry, headers: { Authorization: `Bearer ${maskKey(secret)}` } }
}
