import { join } from 'node:path'

import { createJsonAdapter } from './json-adapter'

/** Qoder：设置文件 `~/.qoder/settings.json`，顶层 `mcpServers`。 */
export const qoderAdapter = createJsonAdapter({
  id: 'qoder',
  displayName: 'Qoder',
  configPath: (homeDir) => join(homeDir, '.qoder', 'settings.json'),
  installCandidates: (homeDir, env) => [
    join(homeDir, '.qoder'),
    ...(env.APPDATA ? [join(env.APPDATA, 'Qoder')] : []),
  ],
})
