import type { ConnectOptions, Engine } from '@dblab/shared'
import { sql } from 'drizzle-orm'
import { bigserial, boolean, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

/**
 * 被纳管的数据源。口令只落密文（v1:<iv>:<tag>:<ct>），任何读接口都不回它。
 * engine 用 text + CHECK 而不是 PG enum：加引擎只改一行约束，不用 ALTER TYPE。
 */
export const datasource = pgTable('datasource', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  name: text('name').notNull().unique(),
  engine: text('engine').$type<Engine>().notNull(),
  host: text('host').notNull(),
  port: integer('port').notNull(),
  databaseName: text('database_name').notNull(),
  username: text('username').notNull(),
  passwordCiphertext: text('password_ciphertext').notNull(),
  connectOptions: jsonb('connect_options')
    .$type<ConnectOptions>()
    .notNull()
    .default(sql`'{}'::jsonb`),
  enabled: boolean('enabled').notNull().default(true),
  lastTestAt: timestamp('last_test_at', { withTimezone: true, mode: 'date' }),
  lastTestOk: boolean('last_test_ok'),
  lastTestError: text('last_test_error'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
})
