import { defineConfig } from 'drizzle-kit'

import { loadRepoEnv } from './src/env-file'

// drizzle-kit 不会自己读 .env，必须显式加载。
loadRepoEnv()

export default defineConfig({
  schema: './src/schema/index.ts',
  out: './src/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/dblab',
  },
  strict: true,
  verbose: true,
})
