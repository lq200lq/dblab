import { MalformedConfigError } from '../core/errors'
import { readTextIfExists } from '../fs/atomic'

import { entriesEqual, type McpEntry } from './types'

/**
 * JSON 配置的定点编辑。
 *
 * 只改 `mcpServers.<name>` 一处，其余键值靠「解析 → 赋值 → 按原缩进/换行重新序列化」保留。
 * 重排整个文件是这类工具最容易挨骂的地方，所以缩进、换行风格、末尾换行三项必须原样还回去。
 */
export interface JsonDoc {
  path: string
  text: string
  data: Record<string, unknown>
  indent: string
  eol: '\n' | '\r\n'
  trailingNewline: boolean
}

const MCP_SERVERS_KEY = 'mcpServers'

function detectIndent(text: string): string {
  const match = /^([ \t]+)"/m.exec(text)
  return match?.[1] ?? '  '
}

/**
 * 读文件并解析。文件不存在返回 null；解析失败抛 MalformedConfigError。
 * 抛错而不是返回空文档，是为了让「先解析、后写入」的顺序无法被绕过。
 */
export async function loadJsonDoc(path: string): Promise<JsonDoc | null> {
  const text = await readTextIfExists(path)
  if (text === null) return null

  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (error) {
    throw new MalformedConfigError(path, error instanceof Error ? error.message : 'JSON 解析失败')
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new MalformedConfigError(path, '顶层不是 JSON 对象')
  }

  return {
    path,
    text,
    data: data as Record<string, unknown>,
    indent: detectIndent(text),
    eol: text.includes('\r\n') ? '\r\n' : '\n',
    trailingNewline: text.endsWith('\n'),
  }
}

export function mcpServersOf(doc: JsonDoc): Record<string, unknown> | null {
  const value = doc.data[MCP_SERVERS_KEY]
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

export function readEntry(doc: JsonDoc, name: string): unknown {
  return mcpServersOf(doc)?.[name] ?? null
}

export interface UpsertResult {
  doc: JsonDoc
  action: 'created' | 'updated' | 'unchanged'
}

export function upsertMcpServer(doc: JsonDoc, name: string, entry: McpEntry): UpsertResult {
  const existing = readEntry(doc, name)
  if (entriesEqual(existing, entry)) {
    return { doc, action: 'unchanged' }
  }

  const servers = mcpServersOf(doc)
  const nextServers: Record<string, unknown> = { ...(servers ?? {}) }
  nextServers[name] = { ...entry, headers: { ...entry.headers } }
  const nextData = { ...doc.data, [MCP_SERVERS_KEY]: nextServers }

  return {
    doc: { ...doc, data: nextData },
    action: servers?.[name] === undefined ? 'created' : 'updated',
  }
}

export function removeMcpServer(doc: JsonDoc, name: string): { doc: JsonDoc; removed: boolean } {
  const servers = mcpServersOf(doc)
  if (!servers || servers[name] === undefined) return { doc, removed: false }

  const nextServers = { ...servers }
  delete nextServers[name]
  const nextData = { ...doc.data, [MCP_SERVERS_KEY]: nextServers }
  return { doc: { ...doc, data: nextData }, removed: true }
}

export function serializeJsonDoc(doc: JsonDoc): string {
  const body = JSON.stringify(doc.data, null, doc.indent)
  const withEol = doc.eol === '\n' ? body : body.replace(/\n/g, doc.eol)
  return doc.trailingNewline ? `${withEol}${doc.eol}` : withEol
}

/** 新建一份最小文档（配置文件本来不存在时用）。 */
export function createEmptyJsonDoc(path: string): JsonDoc {
  return {
    path,
    text: '',
    data: {},
    indent: '  ',
    eol: '\n',
    trailingNewline: true,
  }
}
