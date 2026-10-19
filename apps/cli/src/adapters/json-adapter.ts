import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

import { backupOnce, pathExists, writeAtomic } from '../fs/atomic'

import {
  createEmptyJsonDoc,
  loadJsonDoc,
  readEntry,
  removeMcpServer,
  serializeJsonDoc,
  upsertMcpServer,
} from './json-document'
import type {
  AgentAdapter,
  AgentId,
  DetectResult,
  McpEntry,
  RemoveResult,
  WriteResult,
} from './types'

/** 各客户端里这条 MCP 服务器的名字，统一用它，重复执行才是原地更新。 */
export const DBLAB_SERVER_NAME = 'dblab'

export interface JsonAdapterSpec {
  id: AgentId
  displayName: string
  configPath: (homeDir: string, env: NodeJS.ProcessEnv) => string
  /** 判定「装了没」的候选路径：配置目录、应用目录等。 */
  installCandidates?: (homeDir: string, env: NodeJS.ProcessEnv) => string[]
}

/**
 * `mcpServers` 形态客户端的公共实现：Claude Code / Cursor / Qoder 只差路径。
 */
export function createJsonAdapter(spec: JsonAdapterSpec): AgentAdapter {
  return {
    id: spec.id,
    displayName: spec.displayName,

    renderEntry(entry: McpEntry): string {
      return JSON.stringify({ mcpServers: { [DBLAB_SERVER_NAME]: entry } }, null, 2)
    },

    async detect(homeDir: string): Promise<DetectResult> {
      const configPath = spec.configPath(homeDir, process.env)
      const candidates = [configPath, ...(spec.installCandidates?.(homeDir, process.env) ?? [])]
      const flags = await Promise.all(candidates.map(pathExists))
      const configExists = await pathExists(configPath)

      const base: DetectResult = {
        installed: flags.some(Boolean),
        configPath,
        configExists,
        hasDblabEntry: false,
      }
      if (!configExists) return base

      try {
        const doc = await loadJsonDoc(configPath)
        return { ...base, hasDblabEntry: doc !== null && readEntry(doc, DBLAB_SERVER_NAME) !== null }
      } catch (error) {
        return { ...base, malformed: error instanceof Error ? error.message : '解析失败' }
      }
    },

    async write(homeDir: string, entry: McpEntry): Promise<WriteResult> {
      const path = spec.configPath(homeDir, process.env)
      const loaded = await loadJsonDoc(path)
      const doc = loaded ?? createEmptyJsonDoc(path)
      const { doc: next, action } = upsertMcpServer(doc, DBLAB_SERVER_NAME, entry)
      if (action === 'unchanged') return { path, action }

      await mkdir(dirname(path), { recursive: true })
      const backupPath = loaded ? await backupOnce(path) : null
      await writeAtomic(path, serializeJsonDoc(next))
      return backupPath ? { path, action, backupPath } : { path, action }
    },

    async remove(homeDir: string): Promise<RemoveResult> {
      const path = spec.configPath(homeDir, process.env)
      const loaded = await loadJsonDoc(path)
      if (loaded === null) return { path, removed: false }

      const { doc: next, removed } = removeMcpServer(loaded, DBLAB_SERVER_NAME)
      if (!removed) return { path, removed: false }

      const backupPath = await backupOnce(path)
      await writeAtomic(path, serializeJsonDoc(next))
      return { path, removed: true, backupPath: backupPath ?? undefined }
    },
  }
}
