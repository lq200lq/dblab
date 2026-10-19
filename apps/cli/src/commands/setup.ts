import { buildEntry } from '../adapters/types'
import { connectionConfigPath, saveConnection } from '../core/connection-store'
import { CliError } from '../core/errors'
import { assertApiKeyShape, maskKey } from '../core/key'
import type { Prompts } from '../core/prompts'
import { DEFAULT_SERVER_ORIGIN, normalizeMcpUrl } from '../core/url'
import { validateApiKey } from '../core/validate'

import { serverLabel } from './connect'
import {
  ACTION_LABEL,
  assertWritable,
  printHeader,
  scanAgents,
  writeAll,
  type CommandContext,
} from './shared'

export interface SetupOptions {
  /** 给了就跳过地址提问，脚本化时用。 */
  url?: string
  prompts: Prompts
}

/**
 * 交互向导：地址 → 密钥 → 校验 → 扫描 → 勾选 → 写入。
 * 密钥在任何一步校验通过前都不会落进配置文件。
 */
export async function runSetup(ctx: CommandContext, options: SetupOptions): Promise<number> {
  const { prompts, out } = { prompts: options.prompts, out: ctx.out }

  out.plain('DbLab CLI：把本机的 Agent 接到 DbLab 的 MCP 端点。')
  out.plain('')

  const mcpUrl = await askUrl(prompts, options.url)
  const apiKey = await askKey(ctx, prompts, mcpUrl)

  const scanned = await scanAgents(ctx.homeDir)
  const installed = scanned.filter((item) => item.detection.installed)
  const notInstalled = scanned.filter((item) => !item.detection.installed)

  out.plain('')
  printHeader(out, '扫描结果：')
  for (const item of scanned) {
    const mark = !item.detection.installed
      ? '未检测到'
      : item.detection.hasDblabEntry
        ? '已接入'
        : '已安装'
    out.plain(`  ${item.adapter.displayName}  ${mark}  ${item.detection.configPath}`)
  }

  if (installed.length === 0) {
    out.warn('没有检测到任何已安装的 Agent 客户端，先装一个再回来跑 dblab setup。')
    return 2
  }

  out.plain('')
  const selected = await prompts.checkbox<string>({
    message: '选择要写入的客户端（空格勾选，回车确认）',
    choices: [
      ...installed.map((item) => ({
        name: `${item.adapter.displayName}${item.detection.hasDblabEntry ? '（已有 dblab，将更新）' : ''}`,
        value: item.adapter.id as string,
        checked: true,
      })),
      ...notInstalled.map((item) => ({
        name: `${item.adapter.displayName}（未检测到，可强制写入）`,
        value: item.adapter.id as string,
        checked: false,
      })),
    ],
  })

  if (selected.length === 0) {
    out.warn('没有选中任何客户端，已退出。')
    return 2
  }

  const targets = scanned.filter((item) => selected.includes(item.adapter.id))
  assertWritable(targets)

  out.plain('')
  out.plain('即将写入：')
  for (const item of targets) {
    const action = !item.detection.configExists
      ? '新建配置文件'
      : item.detection.hasDblabEntry
        ? '更新 dblab 条目'
        : '新增 dblab 条目'
    out.plain(`  ${item.adapter.displayName}  ${action}  ${item.detection.configPath}`)
  }
  out.plain(`  密钥（脱敏）：${maskKey(apiKey)}`)
  out.plain('')

  const confirmed = await prompts.confirm({ message: '确认写入？', default: true })
  if (!confirmed) {
    out.plain('已取消，未做任何改动。')
    return 0
  }

  const outcomes = await writeAll(targets, buildEntry(mcpUrl, apiKey), ctx)

  out.plain('')
  printHeader(out, '写入结果：')
  for (const { target, result } of outcomes) {
    out.plain(`  ${target.adapter.displayName}  ${ACTION_LABEL[result.action]}  ${result.path}`)
    if (result.backupPath) out.plain(`    备份：${result.backupPath}`)
  }

  await saveConnection(ctx.homeDir, { url: mcpUrl, key: apiKey })
  out.plain('')
  out.plain(`已记录本机连接：${maskKey(apiKey)} → ${mcpUrl}`)
  out.plain(`  ${connectionConfigPath(ctx.homeDir)}`)
  out.plain('')
  out.plain('重启对应的 Agent 客户端即可加载 dblab 工具。')
  return 0
}

async function askUrl(prompts: Prompts, preset: string | undefined): Promise<string> {
  if (preset !== undefined) return normalizeMcpUrl(preset)

  const answer = await prompts.input({
    message: 'DbLab 服务地址',
    default: DEFAULT_SERVER_ORIGIN,
    validate: (value) => {
      try {
        normalizeMcpUrl(value.length === 0 ? DEFAULT_SERVER_ORIGIN : value)
        return true
      } catch (error) {
        return error instanceof Error ? error.message : '地址不合法'
      }
    },
  })
  return normalizeMcpUrl(answer.length === 0 ? DEFAULT_SERVER_ORIGIN : answer)
}

/** 密钥要先过形态、再过真实链路；不通过就让用户重填，而不是带着错密钥去写文件。 */
async function askKey(ctx: CommandContext, prompts: Prompts, mcpUrl: string): Promise<string> {
  for (;;) {
    const raw = await prompts.password({
      message: 'DbLab API 密钥（管控台「密钥」创建，明文只显示一次）',
      validate: (value) => {
        try {
          assertApiKeyShape(value)
          return true
        } catch (error) {
          return error instanceof Error ? error.message : '密钥形态不正确'
        }
      },
    })
    const apiKey = assertApiKeyShape(raw)

    const result = await validateApiKey({
      mcpUrl,
      apiKey,
      ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
    })
    if (result.ok) {
      ctx.out.success(`校验通过：${serverLabel(result.serverName, result.serverVersion)}`)
      return apiKey
    }

    ctx.out.error(`校验失败：${result.message}`)
    if (result.hint) ctx.out.plain(`  ${result.hint}`)

    const retry = await prompts.confirm({ message: '重新输入密钥？', default: true })
    if (!retry) throw new CliError('validate', '密钥未通过校验，已退出')
  }
}
