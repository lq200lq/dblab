import { CliError } from './errors'

/** DbLab 的 MCP 端点固定挂在 `/mcp` 上（apps/server/src/mcp/routes.ts:20）。 */
export const MCP_PATH = '/mcp'

/**
 * 默认按 docker-compose 暴露给宿主机的端口走（`18400:4000`，见 docker-compose.yml）。
 * 用 `pnpm dev` 直接跑源码时是 4000，那种情况显式传 `--url`。
 */
export const DEFAULT_SERVER_ORIGIN = 'http://localhost:18400'

/**
 * 把用户输入归一化成完整的 MCP 地址。
 *
 * 接受 `localhost:4000`、`http://host:4000`、`https://host/mcp/` 这类写法；
 * 统一补 `http://` 与 `/mcp`。路径不是 `/mcp` 时直接拒绝而不是猜——
 * 猜错会得到一个能连上但 404 的地址，比当场报错更难排查。
 */
export function normalizeMcpUrl(input: string): string {
  const trimmed = input.trim()
  if (trimmed.length === 0) {
    throw new CliError('usage', '服务地址不能为空', `例如 ${DEFAULT_SERVER_ORIGIN}`)
  }

  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`

  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    throw new CliError('usage', `服务地址无法解析：${input}`, `例如 ${DEFAULT_SERVER_ORIGIN}`)
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new CliError('usage', `只支持 http/https 地址，收到 ${url.protocol}//`)
  }
  if (url.search.length > 0 || url.hash.length > 0) {
    throw new CliError('usage', '服务地址不要带查询串或片段')
  }

  const path = url.pathname.replace(/\/+$/, '')
  if (path !== '' && path !== MCP_PATH) {
    throw new CliError(
      'usage',
      `服务地址的路径应为 ${MCP_PATH}，收到 ${path || '/'}`,
      `只填到端口即可，例如 ${DEFAULT_SERVER_ORIGIN}`,
    )
  }

  return `${url.origin}${MCP_PATH}`
}

/** 从 MCP 地址取出 `host`（不含端口），用于 403 时给出 MCP_ALLOWED_HOSTS 提示。 */
export function hostOfMcpUrl(mcpUrl: string): string {
  return new URL(mcpUrl).hostname
}

/**
 * 管理端 REST 与 `/mcp` 同源同端口，去掉尾部的 `/mcp` 就是管理面基址。
 * （端口对不上时用户传错了一个，另一个也必然错，所以不给独立的管理面地址参数。）
 */
export function adminBaseUrlOf(mcpUrl: string): string {
  const url = new URL(mcpUrl)
  return url.origin
}
