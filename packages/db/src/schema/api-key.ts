import type { ApiKeyStatus } from '@dblab/shared'
import { sql } from 'drizzle-orm'
import {
  bigint,
  bigserial,
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

import { adminUser } from './admin-user'
import { datasource } from './datasource'

/**
 * Agent 用的 API 密钥。
 * prefix 是可展示的定位段（dblab_<8 位>），key_hash 是秘密段的 sha256——明文不落库。
 */
export const apiKey = pgTable(
  'api_key',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    name: text('name').notNull(),
    prefix: text('prefix').notNull().unique(),
    keyHash: text('key_hash').notNull(),
    status: text('status').$type<ApiKeyStatus>().notNull().default('active'),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
    ipAllowlist: jsonb('ip_allowlist')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' }),
    createdBy: bigint('created_by', { mode: 'number' }).references(() => adminUser.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [index('api_key_status_idx').on(t.status)],
)

/** 密钥 × 数据源 × 读/写。授权变更按「整表替换」处理，靠这个唯一约束兜底。 */
export const apiKeyGrant = pgTable(
  'api_key_grant',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    apiKeyId: bigint('api_key_id', { mode: 'number' })
      .notNull()
      .references(() => apiKey.id, { onDelete: 'cascade' }),
    datasourceId: bigint('datasource_id', { mode: 'number' })
      .notNull()
      .references(() => datasource.id, { onDelete: 'cascade' }),
    canRead: boolean('can_read').notNull().default(false),
    canWrite: boolean('can_write').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('api_key_grant_key_datasource_uq').on(t.apiKeyId, t.datasourceId),
    index('api_key_grant_datasource_idx').on(t.datasourceId),
  ],
)
