import { join } from 'node:path'

import { createJsonAdapter } from './json-adapter'

/** Qoder 国内版：与 Qoder 同构，只是配置根目录是 `~/.qoder-cn`。 */
export const qoderCnAdapter = createJsonAdapter({
  id: 'qoder-cn',
  displayName: 'Qoder CN',
  configPath: (homeDir) => join(homeDir, '.qoder-cn', 'settings.json'),
  installCandidates: (homeDir, env) => [
    join(homeDir, '.qoder-cn'),
    ...(env.APPDATA ? [join(env.APPDATA, 'QoderCN')] : []),
  ],
})
