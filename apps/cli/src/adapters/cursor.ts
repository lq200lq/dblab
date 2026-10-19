import { join } from 'node:path'

import { createJsonAdapter } from './json-adapter'

/** Cursor：全局 MCP 配置在 `~/.cursor/mcp.json`。 */
export const cursorAdapter = createJsonAdapter({
  id: 'cursor',
  displayName: 'Cursor',
  configPath: (homeDir) => join(homeDir, '.cursor', 'mcp.json'),
  installCandidates: (homeDir, env) => [
    join(homeDir, '.cursor'),
    ...(env.APPDATA ? [join(env.APPDATA, 'Cursor')] : []),
  ],
})
