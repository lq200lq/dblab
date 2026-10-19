import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import { repoRoot } from './env-file'

/**
 * 数据源口令加解密。
 *
 * 口令本体落库但只落密文：主密钥在 env（CREDENTIAL_MASTER_KEY，32 字节 base64）
 * 或本地密钥文件里，库与备份即使整表泄露也拿不到可用口令。
 *
 * 主密钥变更或丢失会让既有密文解不开（属配置事故）。此时按「不可用」处理并分码告警，
 * **绝不返回空串或 null**——空口令会被读成「没配口令」，排查方向就错了。
 */

const ALGORITHM = 'aes-256-gcm'
const KEY_BYTES = 32
const IV_BYTES = 12
const VERSION = 'v1'

/** 与 @dblab/shared 的 ErrorCode 对齐，服务端可直接透出。 */
export class MasterKeyUnavailableError extends Error {
  readonly code = 'MASTER_KEY_UNAVAILABLE'
  constructor(message: string) {
    super(message)
    this.name = 'MasterKeyUnavailableError'
  }
}

export class CredentialUndecryptableError extends Error {
  readonly code = 'CREDENTIAL_UNDECRYPTABLE'
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'CredentialUndecryptableError'
  }
}

let cachedKey: Buffer | null = null

export function masterKeyFilePath(): string {
  return (
    process.env.CREDENTIAL_MASTER_KEY_FILE || resolve(repoRoot(), '.data', 'credential-master.key')
  )
}

/** 进程内缓存，避免每请求读盘。解密失败时会被 reset，好让运维改完密钥不必重启。 */
export function masterKey(): Buffer {
  if (cachedKey) return cachedKey
  cachedKey = fromEnv() ?? fromKeyFile()
  return cachedKey
}

function fromEnv(): Buffer | null {
  const raw = process.env.CREDENTIAL_MASTER_KEY
  if (!raw) return null
  const key = Buffer.from(raw, 'base64')
  if (key.length !== KEY_BYTES) {
    throw new MasterKeyUnavailableError(
      'CREDENTIAL_MASTER_KEY 需为 32 字节的 base64（例如 openssl rand -base64 32）',
    )
  }
  return key
}

function fromKeyFile(): Buffer {
  const file = masterKeyFilePath()
  try {
    const key = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64')
    if (key.length !== KEY_BYTES) throw new Error(`长度不是 ${KEY_BYTES} 字节`)
    return key
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      // 文件在但不可用（长度不对等）：不覆盖，直接报错，免得把既有密文全废掉。
      throw new MasterKeyUnavailableError(
        `主密钥文件不可用（${file}）：${(err as Error).message}`,
      )
    }
  }

  const key = randomBytes(KEY_BYTES)
  mkdirSync(dirname(file), { recursive: true })
  try {
    // wx：并发起服务时只让一个进程写成，其余读既有文件。
    writeFileSync(file, `${key.toString('base64')}\n`, { flag: 'wx', mode: 0o600 })
    console.log(`[secret-cipher] 已生成凭据主密钥：${file}（可用 CREDENTIAL_MASTER_KEY 覆盖）`)
    return key
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    const existing = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64')
    if (existing.length !== KEY_BYTES) {
      throw new MasterKeyUnavailableError(`主密钥文件不可用（${file}）`)
    }
    return existing
  }
}

export type MasterKeyStatus =
  | { source: 'env'; usable: true }
  | { source: 'env'; usable: false; problem: string }
  | { source: 'file'; filePath: string; fileExists: boolean; usable: true }
  | { source: 'file'; filePath: string; fileExists: boolean; usable: false; problem: string }

/**
 * 启动自检用，**无副作用**（不会顺手生成密钥文件）。
 * usable 为 false 时由调用方决定怎么告警。
 */
export function describeMasterKeyStatus(): MasterKeyStatus {
  const raw = process.env.CREDENTIAL_MASTER_KEY
  if (raw) {
    const key = Buffer.from(raw, 'base64')
    return key.length === KEY_BYTES
      ? { source: 'env', usable: true }
      : {
          source: 'env',
          usable: false,
          problem: `CREDENTIAL_MASTER_KEY 需为 32 字节 base64，实际 ${key.length} 字节`,
        }
  }

  const filePath = masterKeyFilePath()
  const fileExists = existsSync(filePath)
  if (!fileExists) {
    return {
      source: 'file',
      filePath,
      fileExists,
      usable: false,
      problem: `主密钥文件不存在（${filePath}）：若已有加密口令，本进程将解不开`,
    }
  }
  try {
    const key = Buffer.from(readFileSync(filePath, 'utf8').trim(), 'base64')
    if (key.length !== KEY_BYTES) throw new Error(`长度不是 ${KEY_BYTES} 字节`)
    return { source: 'file', filePath, fileExists, usable: true }
  } catch (err) {
    return {
      source: 'file',
      filePath,
      fileExists,
      usable: false,
      problem: `主密钥文件不可用：${(err as Error).message}`,
    }
  }
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, masterKey(), iv)
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [
    VERSION,
    iv.toString('base64'),
    tag.toString('base64'),
    ciphertext.toString('base64'),
  ].join(':')
}

/** 解密失败（密文被改、主密钥不一致）一律抛错，且错误文案里不含明文与密文。 */
export function decryptSecret(payload: string): string {
  const parts = payload.split(':')
  const [version, ivB64, tagB64, dataB64] = parts
  if (parts.length !== 4 || version !== VERSION || !ivB64 || !tagB64 || !dataB64) {
    throw new CredentialUndecryptableError('密文格式不可识别')
  }

  let key: Buffer
  try {
    key = masterKey()
  } catch (err) {
    if (err instanceof MasterKeyUnavailableError) throw err
    throw new MasterKeyUnavailableError((err as Error).message)
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64'))
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64')),
      decipher.final(),
    ]).toString('utf8')
  } catch (err) {
    throw new CredentialUndecryptableError('数据源口令解不开，可能是主密钥已变更', { cause: err })
  }
}

/** 仅供测试使用：清掉进程内缓存的主密钥。 */
export function resetMasterKeyCache(): void {
  cachedKey = null
}
