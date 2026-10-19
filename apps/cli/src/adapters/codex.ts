import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { backupOnce, pathExists, writeAtomic } from '../fs/atomic'

import { DBLAB_SERVER_NAME } from './json-adapter'
import {
  createEmptyTomlDoc,
  hasTomlServer,
  loadTomlDoc,
  removeTomlServer,
  renderServerBlock,
  upsertTomlServer,
} from './toml-document'
import type { AgentAdapter, DetectResult, McpEntry, RemoveResult, WriteResult } from './types'

/** Codex CLI：`~/.codex/config.toml`，远程 MCP 条目是 `[mcp_servers.<name>]`。 */
export const codexAdapter: AgentAdapter = {
  id: 'codex',
  displayName: 'Codex CLI',

  renderEntry(entry: McpEntry): string {
    return renderServerBlock(DBLAB_SERVER_NAME, entry)
  },

  async detect(homeDir: string): Promise<DetectResult> {
    const configPath = join(homeDir, '.codex', 'config.toml')
    const configExists = await pathExists(configPath)
    const installed = configExists || (await pathExists(join(homeDir, '.codex')))

    const base: DetectResult = { installed, configPath, configExists, hasDblabEntry: false }
    if (!configExists) return base

    try {
      const doc = await loadTomlDoc(configPath)
      return { ...base, hasDblabEntry: doc !== null && hasTomlServer(doc, DBLAB_SERVER_NAME) }
    } catch (error) {
      return { ...base, malformed: error instanceof Error ? error.message : '解析失败' }
    }
  },

  async write(homeDir: string, entry: McpEntry): Promise<WriteResult> {
    const path = join(homeDir, '.codex', 'config.toml')
    const loaded = await loadTomlDoc(path)
    const doc = loaded ?? createEmptyTomlDoc(path)
    const { doc: next, action } = upsertTomlServer(doc, DBLAB_SERVER_NAME, entry)
    if (action === 'unchanged') return { path, action }

    await mkdir(dirname(path), { recursive: true })
    const backupPath = loaded ? await backupOnce(path) : null
    await writeAtomic(path, next.text)
    return backupPath ? { path, action, backupPath } : { path, action }
  },

  async remove(homeDir: string): Promise<RemoveResult> {
    const path = join(homeDir, '.codex', 'config.toml')
    const loaded = await loadTomlDoc(path)
    if (loaded === null) return { path, removed: false }

    const { doc: next, removed } = removeTomlServer(loaded, DBLAB_SERVER_NAME)
    if (!removed) return { path, removed: false }

    const backupPath = await backupOnce(path)
    await writeAtomic(path, next.text)
    return { path, removed: true, backupPath: backupPath ?? undefined }
  },
}
