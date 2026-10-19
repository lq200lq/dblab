import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { config } from 'dotenv'

/** 本文件位于 <仓库根>/packages/db/src，向上一级是包、再上一级是 packages、第三级是仓库根。 */
const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * 仓库根按文件位置解析，**不用 process.cwd()**：
 * 主密钥文件与 .env 的路径都挂在这里，若按 cwd 解析，
 * 换个目录起进程就会各生成一把主密钥、既有密文全部解不开。
 */
export function repoRoot(): string {
  return resolve(HERE, '../../..')
}

export function envFilePath(): string {
  return process.env.ENV_FILE || resolve(repoRoot(), '.env')
}

let loaded = false

/**
 * 显式加载仓库根 .env。
 * drizzle-kit / tsx 脚本都不会自动读它，所以由入口自己调一次。
 * 已存在的真实环境变量优先（dotenv 默认不覆盖）。
 */
export function loadRepoEnv(): void {
  if (loaded) return
  loaded = true
  const file = envFilePath()
  if (existsSync(file)) config({ path: file, quiet: true })
}
