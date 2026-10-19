import { mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { CliError } from './errors'
import { assertApiKeyShape } from './key'
import { readTextIfExists, writeAtomic } from '../fs/atomic'
import { DEFAULT_SERVER_ORIGIN, normalizeMcpUrl } from './url'

/**
 * 「当前连接」的记录。
 *
 * `connect` / `setup` 写入一把密钥后，后续命令就该知道用户此刻接的是哪把、连的哪个地址，
 * 不必每次重敲。这是一份**明文密钥副本**（客户端配置文件里本来就有同一把），
 * 所以落盘尽力收到 0600，任何输出都必须先过 maskKey。
 */
export interface StoredConnection {
  version: 1
  /** 完整的 MCP 地址（含 /mcp）。 */
  url: string
  key: string
  updatedAt: string
}

/** 记录文件所在的位置，报错文案里要能指到人。 */
export function connectionConfigPath(homeDir: string): string {
  return join(homeDir, '.dblab', 'config.json')
}

export async function saveConnection(homeDir: string, connection: { url: string; key: string }): Promise<void> {
  const path = connectionConfigPath(homeDir)
  const payload: StoredConnection = {
    version: 1,
    url: normalizeMcpUrl(connection.url),
    key: assertApiKeyShape(connection.key),
    updatedAt: new Date().toISOString(),
  }

  await mkdir(dirname(path), { recursive: true })
  await writeAtomic(path, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
}

/** 没有记录返回 null；有记录但读不懂时报错，绝不静默当成「没连过」。 */
export async function loadConnection(homeDir: string): Promise<StoredConnection | null> {
  const path = connectionConfigPath(homeDir)
  const text = await readTextIfExists(path)
  if (text === null) return null

  const invalid = (reason: string): CliError =>
    new CliError('usage', `连接记录无法使用：${path}`, `${reason} 请重跑一次 dblab connect 覆盖它。`)

  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    throw invalid('不是合法 JSON。')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw invalid('顶层不是对象。')
  }

  const candidate = parsed as Partial<StoredConnection>
  if (typeof candidate.url !== 'string' || typeof candidate.key !== 'string') {
    throw invalid('缺少 url 或 key 字段。')
  }

  return { version: 1, url: normalizeMcpUrl(candidate.url), key: assertApiKeyShape(candidate.key), updatedAt: candidate.updatedAt ?? '' }
}

export async function clearConnection(homeDir: string): Promise<boolean> {
  const path = connectionConfigPath(homeDir)
  if ((await readTextIfExists(path)) === null) return false
  await rm(path, { force: true })
  return true
}

export type ConnectionSource = 'flag' | 'connection'

export interface ResolvedTarget {
  mcpUrl: string
  apiKey: string
  source: ConnectionSource
}

/**
 * 把 `--key` / `--url` 与连接记录合成一次命令真正的目标。
 *
 * 只有「密钥也来自记录」时才连地址一起用记录里的：显式给了 `--key` 却不给 `--url`，
 * 维持原有的默认地址语义，免得换服务器时把授权打到另一台上。
 */
export async function resolveTarget(options: {
  homeDir: string
  url?: string
  key?: string
}): Promise<ResolvedTarget> {
  const path = connectionConfigPath(options.homeDir)

  // 给了 --key 就按给的来，哪怕空串也要报错，而不是悄悄回落到记录里那把。
  if (options.key !== undefined) {
    return {
      mcpUrl: normalizeMcpUrl(options.url ?? DEFAULT_SERVER_ORIGIN),
      apiKey: assertApiKeyShape(options.key),
      source: 'flag',
    }
  }

  const stored = await loadConnection(options.homeDir)
  if (stored === null) {
    throw new CliError(
      'usage',
      '缺少 --key',
      `先跑一次 dblab connect 建立连接记录（写在 ${path}），或直接传 --key <明文>。`,
    )
  }

  return {
    mcpUrl: normalizeMcpUrl(options.url ?? stored.url),
    apiKey: stored.key,
    source: 'connection',
  }
}

/** 打印「这把密钥是哪来的」，避免用户以为授权给了另一把。 */
export function sourceLabel(source: ConnectionSource): string {
  return source === 'flag' ? '--key' : '本机连接记录'
}
