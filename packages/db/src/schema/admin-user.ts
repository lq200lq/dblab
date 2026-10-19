import { bigserial, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

/** 管理员。首版只有一个 admin，但表结构按多用户设计，后续加人无需改表。 */
export const adminUser = pgTable('admin_user', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  displayName: text('display_name'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
})
