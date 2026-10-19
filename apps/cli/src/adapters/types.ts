export type AgentId = 'claude-code' | 'cursor' | 'codex' | 'qoder' | 'qoder-cn'

/** 写进各客户端的 MCP 条目。DbLab 走 Streamable HTTP，headers 里带 Bearer 密钥。 */
export interface McpEntry {
  type: 'http'
  url: string
  headers: Record<string, string>
}

export interface DetectResult {
  installed: boolean
  configPath: string
  configExists: boolean
  hasDblabEntry: boolean
  /** 文件存在但解析不了时填原因，调用方据此提示而不是静默跳过。 */
  malformed?: string
}

export interface WriteResult {
  path: string
  action: 'created' | 'updated' | 'unchanged'
  backupPath?: string
}

export interface RemoveResult {
  path: string
  removed: boolean
  backupPath?: string
}

export interface AgentAdapter {
  readonly id: AgentId
  readonly displayName: string
  detect(homeDir: string): Promise<DetectResult>
  write(homeDir: string, entry: McpEntry): Promise<WriteResult>
  remove(homeDir: string): Promise<RemoveResult>
  /** 按本客户端的格式渲染将要写入的片段，供 --dry-run 展示（密钥由调用方先脱敏）。 */
  renderEntry(entry: McpEntry): string
}

export function buildEntry(mcpUrl: string, apiKey: string): McpEntry {
  return {
    type: 'http',
    url: mcpUrl,
    headers: { Authorization: `Bearer ${apiKey}` },
  }
}

/** 条目比较：只在两边字段完全一致时才算「无需改动」。 */
export function entriesEqual(a: unknown, b: McpEntry): boolean {
  if (a === null || typeof a !== 'object') return false
  const candidate = a as Partial<McpEntry>
  if (candidate.url !== b.url) return false
  // 已有条目省略 type 时不动它：不少客户端把「有 url 无 type」等同于 http。
  if (candidate.type !== undefined && candidate.type !== b.type) return false
  const headers = candidate.headers
  if (headers === null || typeof headers !== 'object') return false
  const keys = Object.keys(b.headers)
  const candidateKeys = Object.keys(headers)
  if (candidateKeys.length !== keys.length) return false
  return keys.every((key) => (headers as Record<string, string>)[key] === b.headers[key])
}
