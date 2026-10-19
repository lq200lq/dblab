import { adapters } from '../adapters/registry'
import type { AgentAdapter, DetectResult, McpEntry, WriteResult } from '../adapters/types'
import { CliError } from '../core/errors'
import type { Output } from '../core/output'
import { visualWidth, padEndVisual } from '../core/output'

export interface CommandContext {
  homeDir: string
  out: Output
  fetchImpl?: typeof fetch
}

export interface ScannedAgent {
  adapter: AgentAdapter
  detection: DetectResult
}

export async function scanAgents(homeDir: string): Promise<ScannedAgent[]> {
  const results: ScannedAgent[] = []
  for (const adapter of adapters) {
    results.push({ adapter, detection: await adapter.detect(homeDir) })
  }
  return results
}

export function statusTextOf(detection: DetectResult): string {
  if (detection.malformed) return '配置损坏'
  if (!detection.installed) return '未检测到'
  if (detection.hasDblabEntry) return '已接入 dblab'
  return '已安装，未接入'
}

export function printHeader(out: Output, title: string): void {
  out.plain(title)
  out.plain('')
}

/** 统一的两列表格：名字 + 状态 + 路径。 */
export function printAgentRows(out: Output, rows: Array<{ label: string; status: string; path: string }>): void {
  const labelWidth = Math.max(...rows.map((row) => visualWidth(row.label)), 0)
  const statusWidth = Math.max(...rows.map((row) => visualWidth(row.status)), 0)
  for (const row of rows) {
    out.plain(`  ${padEndVisual(row.label, labelWidth)}  ${padEndVisual(row.status, statusWidth)}  ${row.path}`)
  }
}

/** `--agents` 解析：未知 id 直接报错，别静默忽略。 */
export function parseAgentIds(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined
  const ids = raw
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
  if (ids.length === 0) {
    throw new CliError('usage', '--agents 不能为空', `可选值：${adapters.map((a) => a.id).join(', ')}`)
  }
  const known = new Set(adapters.map((adapter) => adapter.id))
  const unknown = ids.filter((id) => !known.has(id as never))
  if (unknown.length > 0) {
    throw new CliError(
      'usage',
      `未知的客户端：${unknown.join(', ')}`,
      `可选值：${adapters.map((a) => a.id).join(', ')}`,
    )
  }
  return ids
}

/** 显式指定 --agents 时按指定来（哪怕没检测到）；否则只作用于检测到的。 */
export async function resolveTargets(
  homeDir: string,
  ids: string[] | undefined,
): Promise<ScannedAgent[]> {
  const scanned = await scanAgents(homeDir)
  if (ids === undefined) {
    const installed = scanned.filter((item) => item.detection.installed)
    if (installed.length === 0) {
      throw new CliError(
        'usage',
        '本机没有检测到任何已安装的 Agent 客户端',
        `可以先用 dblab scan 看一遍，或用 --agents 显式指定（${adapters.map((a) => a.id).join(', ')}）。`,
      )
    }
    return installed
  }
  const wanted = new Set(ids)
  return scanned.filter((item) => wanted.has(item.adapter.id))
}

/** 写盘前的统一闸门：任何一份配置文件解析不了，就整体不写。 */
export function assertWritable(targets: ScannedAgent[]): void {
  const broken = targets.filter((item) => item.detection.malformed)
  if (broken.length === 0) return
  const detail = broken
    .map((item) => `  - ${item.adapter.displayName}：${item.detection.configPath}`)
    .join('\n')
  throw new CliError(
    'write',
    `以下配置文件无法解析，本次未做任何写入：\n${detail}`,
    '请先手工修好这些文件（或删掉备份还原），再重试。',
  )
}

export const ACTION_LABEL: Record<WriteResult['action'], string> = {
  created: '新建',
  updated: '已更新',
  unchanged: '无需改动',
}

export interface WriteOutcome {
  target: ScannedAgent
  result: WriteResult
}

/**
 * 逐个写入。单个客户端失败只记下来继续走——其余客户端没有理由被连带失败；
 * 每一条都会打印出来，用户能看清哪些成功、哪些要手工处理。
 */
export async function writeAll(
  targets: ScannedAgent[],
  entry: McpEntry,
  ctx: CommandContext,
): Promise<WriteOutcome[]> {
  const outcomes: WriteOutcome[] = []
  for (const target of targets) {
    try {
      outcomes.push({ target, result: await target.adapter.write(ctx.homeDir, entry) })
    } catch (error) {
      if (error instanceof CliError) {
        ctx.out.error(`${target.adapter.displayName}：${error.message}`)
        if (error.hint) ctx.out.plain(`  ${error.hint}`)
        continue
      }
      throw error
    }
  }
  return outcomes
}
