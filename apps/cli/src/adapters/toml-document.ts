import { parse as parseToml } from 'smol-toml'

import { CliError, MalformedConfigError } from '../core/errors'
import { readTextIfExists } from '../fs/atomic'

import type { McpEntry } from './types'

/**
 * Codex `~/.codex/config.toml` 的定点编辑。
 *
 * 这份文件通常有几百行无关配置与注释，重新序列化会把它整份重排，
 * 因此这里只按「段边界」替换 `[mcp_servers.<name>]` 那一段，其余字节原样保留。
 * smol-toml 只用来判断整份文件是否合法，不参与输出。
 */
export interface TomlDoc {
  path: string
  text: string
  originalText: string
  eol: '\n' | '\r\n'
  trailingNewline: boolean
}

const ROOT_TABLE = 'mcp_servers'

export async function loadTomlDoc(path: string): Promise<TomlDoc | null> {
  const text = await readTextIfExists(path)
  if (text === null) return null

  try {
    parseToml(text)
  } catch (error) {
    throw new MalformedConfigError(path, error instanceof Error ? error.message : 'TOML 解析失败')
  }

  return {
    path,
    text,
    originalText: text,
    eol: text.includes('\r\n') ? '\r\n' : '\n',
    trailingNewline: text.endsWith('\n'),
  }
}

export function createEmptyTomlDoc(path: string): TomlDoc {
  const text = ''
  return { path, text, originalText: text, eol: '\n', trailingNewline: true }
}

/** TOML 基本字符串：JSON 的转义规则对 `"` 与 `\` 与 TOML 兼容，直接复用。 */
function tomlString(value: string): string {
  return JSON.stringify(value)
}

function renderBlock(name: string, entry: McpEntry): string[] {
  const headers = Object.entries(entry.headers)
    .map(([key, value]) => `${tomlString(key)} = ${tomlString(value)}`)
    .join(', ')
  return [`[${ROOT_TABLE}.${name}]`, `url = ${tomlString(entry.url)}`, `http_headers = { ${headers} }`]
}

/** 供 --dry-run 展示的片段（真实写入也走这一份渲染，避免两处格式漂移）。 */
export function renderServerBlock(name: string, entry: McpEntry): string {
  return renderBlock(name, entry).join('\n')
}

function headerNameOf(line: string): { name: string; isArray: boolean } | null {
  const single = /^\s*\[([^[\]]+)\]\s*$/.exec(line)
  if (single?.[1] !== undefined) return { name: normalizeHeaderName(single[1]), isArray: false }
  const array = /^\s*\[\[([^[\]]+)\]\]\s*$/.exec(line)
  if (array?.[1] !== undefined) return { name: normalizeHeaderName(array[1]), isArray: true }
  return null
}

function normalizeHeaderName(raw: string): string {
  return raw
    .split('.')
    .map((segment) => {
      const trimmed = segment.trim()
      const quoted = /^"(.*)"$/.exec(trimmed) ?? /^'(.*)'$/.exec(trimmed)
      return quoted?.[1] ?? trimmed
    })
    .join('.')
}

interface SectionRange {
  start: number
  end: number
}

function findSection(lines: readonly string[], name: string): SectionRange | null {
  const target = `${ROOT_TABLE}.${name}`
  const belongsToTarget = (header: string): boolean =>
    header === target || header.startsWith(`${target}.`)

  let start = -1
  for (let index = 0; index < lines.length; index += 1) {
    const header = headerNameOf(lines[index] ?? '')
    if (!header) continue
    if (start === -1) {
      if (belongsToTarget(header.name)) start = index
      continue
    }
    if (!belongsToTarget(header.name)) return { start, end: index }
  }
  return start === -1 ? null : { start, end: lines.length }
}

function assertAppendAllowed(lines: readonly string[], name: string): void {
  for (const line of lines) {
    if (/^\s*\.?\s*mcp_servers\s*=/.test(line)) {
      throw new CliError(
        'write',
        'config.toml 里的 mcp_servers 是内联表，无法追加子表',
        '请先把 `mcp_servers = { ... }` 改成 `[mcp_servers]` 表头写法，再重试。',
      )
    }
    const header = headerNameOf(line)
    if (header?.isArray && header.name === ROOT_TABLE) {
      throw new CliError(
        'write',
        `config.toml 里的 ${ROOT_TABLE} 是 [[数组表]]，无法追加子表`,
        `请手工添加 [${ROOT_TABLE}.${name}] 段后再重试。`,
      )
    }
  }
}

function contentLinesOf(doc: TomlDoc): string[] {
  const lines = doc.text.split(/\r?\n/)
  if (doc.trailingNewline && lines[lines.length - 1] === '') lines.pop()
  return lines
}

function joinLines(doc: TomlDoc, lines: readonly string[]): string {
  return lines.join(doc.eol) + (doc.trailingNewline ? doc.eol : '')
}

export interface TomlUpsertResult {
  doc: TomlDoc
  action: 'created' | 'updated' | 'unchanged'
}

export function upsertTomlServer(doc: TomlDoc, name: string, entry: McpEntry): TomlUpsertResult {
  const lines = contentLinesOf(doc)
  const block = renderBlock(name, entry)
  const range = findSection(lines, name)

  let next: string[]
  if (range) {
    next = [...lines.slice(0, range.start), ...block, ...lines.slice(range.end)]
  } else {
    assertAppendAllowed(lines, name)
    const prefix = lines.length > 0 ? [...lines, ''] : []
    next = [...prefix, ...block]
  }

  const text = joinLines(doc, next)
  if (text === doc.text) return { doc, action: 'unchanged' }
  return { doc: { ...doc, text }, action: range ? 'updated' : 'created' }
}

export function removeTomlServer(doc: TomlDoc, name: string): { doc: TomlDoc; removed: boolean } {  const lines = contentLinesOf(doc)
  const range = findSection(lines, name)
  if (!range) return { doc, removed: false }

  const next = [...lines.slice(0, range.start), ...lines.slice(range.end)]
  // 段被摘掉后可能留下两行连续空行，收一收。
  if (next[range.start - 1] === '' && next[range.start] === '') next.splice(range.start, 1)
  while (next.length > 0 && next[next.length - 1] === '') next.pop()

  return { doc: { ...doc, text: joinLines(doc, next) }, removed: true }
}

/** 判断 `[mcp_servers.<name>]` 段是否存在。 */
export function hasTomlServer(doc: TomlDoc, name: string): boolean {
  return findSection(contentLinesOf(doc), name) !== null
}
