import { createPlatformDb, describeMasterKeyStatus, loadRepoEnv } from '@dblab/db'

import { buildApp } from './app'
import { parseEnv } from './config/env'

async function main(): Promise<void> {
  // tsx/exec 都不会自动读仓库根 .env，入口显式加载一次。
  loadRepoEnv()

  const { env, warnings } = parseEnv()
  for (const warning of warnings) console.warn(`[启动告警] ${warning}`)

  const masterKey = describeMasterKeyStatus()
  if (masterKey.source === 'env') {
    console.log('[启动] 凭据主密钥来源：环境变量 CREDENTIAL_MASTER_KEY')
  } else if (masterKey.usable) {
    console.log(`[启动] 凭据主密钥来源：文件 ${masterKey.filePath}`)
  } else {
    // 无副作用自检：这里不生成密钥文件，只把问题说清楚。
    console.warn(`[启动告警] ${masterKey.problem}`)
  }

  const { db, pool } = createPlatformDb(env.databaseUrl)
  const app = await buildApp({ env, db, pool })

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[关闭] 收到 ${signal}，正在退出`)
    await app.close()
    await pool.end()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))

  await app.listen({ port: env.port, host: '0.0.0.0' })
  console.log(`[启动] 管理面 http://localhost:${env.port}`)
}

main().catch((err: unknown) => {
  console.error('[启动] 失败：', err instanceof Error ? err.message : err)
  process.exitCode = 1
})
