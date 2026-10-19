import type { PlatformDb } from '@dblab/db'

import type { AppEnv } from '../config/env'
import type { ApiKeyService, ApiKeyRow, GrantPermission } from '../api-key/service'
import type { AuditService } from '../audit/audit.service'
import type { DatasourceService } from '../datasource/service'
import type { PoolRegistry } from '../datasource/pool-registry'

/** MCP 这条路要用的全部依赖。 */
export interface McpDeps {
  db: PlatformDb
  apiKeys: ApiKeyService
  datasources: DatasourceService
  pools: PoolRegistry
  audit: AuditService
  env: AppEnv
}

/**
 * 一次会话的上下文。
 *
 * 这个对象的字段是**就地改写**的：工具回调在建会话时就闭包持有了它，
 * 换一个新对象赋给 `McpSession.context` 不会让回调看到变化。所以只改字段，不换对象。
 *
 * `permissions` 每次请求前从库里重新读，所以管理面改了授权，
 * 已经在跑的会话下一次 tools/list 就能看到变化，不需要重连。
 */
export interface McpSessionContext {
  key: ApiKeyRow
  permissions: Map<number, GrantPermission>
  clientIp: string | null
}
