import { join } from 'node:path'

import { createJsonAdapter } from './json-adapter'

/** Claude Code：用户级 MCP 配置在 `~/.claude.json` 顶层 `mcpServers`。 */
export const claudeCodeAdapter = createJsonAdapter({
  id: 'claude-code',
  displayName: 'Claude Code',
  configPath: (homeDir) => join(homeDir, '.claude.json'),
  installCandidates: (homeDir) => [join(homeDir, '.claude')],
})
