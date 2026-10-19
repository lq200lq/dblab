import { bigint, bigserial, index, inet, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

import { adminUser } from './admin-user'

/**
 * 管理端会话。没有 Redis，会话落库。
 * 库里只存 cookie 令牌的 sha256：即使库被读走，也无法反推出可用的 cookie 值。
 */
export const session = pgTable(
  'session',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tokenHash: text('token_hash').notNull().unique(),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => adminUser.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    clientIp: inet('client_ip'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    index('session_user_expires_idx').on(t.userId, t.expiresAt),
    index('session_expires_idx').on(t.expiresAt),
  ],
)
