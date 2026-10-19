import { printAgentRows, printHeader, scanAgents, statusTextOf, type CommandContext } from './shared'

/** 只读扫描：每台机器上五个客户端装没装、配置在哪、有没有接入 dblab。 */
export async function runScan(ctx: CommandContext): Promise<number> {
  const scanned = await scanAgents(ctx.homeDir)

  printHeader(ctx.out, 'Agent 客户端扫描结果：')
  printAgentRows(
    ctx.out,
    scanned.map((item) => ({
      label: item.adapter.displayName,
      status: statusTextOf(item.detection),
      path: item.detection.configPath,
    })),
  )
  ctx.out.plain('')

  const broken = scanned.filter((item) => item.detection.malformed)
  for (const item of broken) {
    ctx.out.warn(`${item.adapter.displayName} 的配置文件无法解析：${item.detection.malformed}`)
  }

  const installed = scanned.filter((item) => item.detection.installed).length
  ctx.out.plain(`已安装 ${installed} 个，共检查 ${scanned.length} 个。`)
  return 0
}
