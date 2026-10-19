import { adminUser } from './admin-user'
import { apiKey, apiKeyGrant } from './api-key'
import { auditLog } from './audit-log'
import { datasource } from './datasource'
import { session } from './session'

export { adminUser, apiKey, apiKeyGrant, auditLog, datasource, session }

/** 迁移与测试里按名字遍历用。 */
export const allTables = { adminUser, session, datasource, apiKey, apiKeyGrant, auditLog }
