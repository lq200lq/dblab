import { clearConnection, connectionConfigPath } from '../core/connection-store'

import { printHeader, parseAgentIds, scanAgents, type CommandContext } from './shared'

export interface DisconnectOptions {
  agents?: string
}

/** 只摘掉 dblab 这一条，其余配置原样保留。 */
export async function runDisconnect(ctx: CommandContext, options: DisconnectOptions): Promise<number> {
  const ids = parseAgentIds(options.agents)
  const scanned = await scanAgents(ctx.homeDir)
  const targets =
    ids === undefined
      ? scanned.filter((item) => item.detection.hasDblabEntry)
      : scanned.filter((item) => ids.includes(item.adapter.id))

  if (targets.length === 0) {
    ctx.out.plain('没有找到需要移除的 dblab 配置。')
    await forgetConnection(ctx, ids)
    return 0
  }

  printHeader(ctx.out, '移除结果：')
  let removedCount = 0
  for (const target of targets) {
    const result = await target.adapter.remove(ctx.homeDir)
    if (result.removed) {
      removedCount += 1
      ctx.out.plain(`  ${target.adapter.displayName}  已移除  ${result.path}`)
      if (result.backupPath) ctx.out.plain(`    备份：${result.backupPath}`)
    } else {
      ctx.out.plain(`  ${target.adapter.displayName}  未找到该条目  ${result.path}`)
    }
  }
  ctx.out.plain('')
  ctx.out.plain(`共移除 ${removedCount} 处。`)
  await forgetConnection(ctx, ids)
  return 0
}

/**
 * 整体断开才清掉连接记录：`--agents` 只摘了几家时，其余客户端还在用同一把密钥连着，
 * 那份记录仍然代表「当前连接」。
 */
async function forgetConnection(ctx: CommandContext, ids: string[] | undefined): Promise<void> {
  if (ids !== undefined) return
  if (await clearConnection(ctx.homeDir)) {
    ctx.out.plain('')
    ctx.out.plain(`已清除本机连接记录：${connectionConfigPath(ctx.homeDir)}`)
  }
}
