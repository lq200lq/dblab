import { claudeCodeAdapter } from './claude-code'
import { codexAdapter } from './codex'
import { cursorAdapter } from './cursor'
import { qoderAdapter } from './qoder'
import { qoderCnAdapter } from './qoder-cn'
import type { AgentAdapter, AgentId } from './types'

/** 新增客户端只需在这里加一项。顺序即展示顺序。 */
export const adapters: readonly AgentAdapter[] = [
  claudeCodeAdapter,
  cursorAdapter,
  codexAdapter,
  qoderAdapter,
  qoderCnAdapter,
]

export function findAdapter(id: string): AgentAdapter | undefined {
  return adapters.find((adapter) => adapter.id === id)
}

export function isAgentId(value: string): value is AgentId {
  return adapters.some((adapter) => adapter.id === value)
}

export const AGENT_IDS: readonly AgentId[] = adapters.map((adapter) => adapter.id)
