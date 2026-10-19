import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * API 密钥的签发与校验。
 *
 * 形态：dblab_<8 位定位段>_<43 位秘密段>
 * - 明文只在创建响应里出现一次，库里只留 sha256(秘密段) 与定位段。
 * - 校验按定位段索引到行，再定时安全比摘要；定位段不是秘密，用于展示与排查。
 */

const ROOT = 'dblab'
const LOOKUP_BYTES = 4
const SECRET_BYTES = 32

/** 带捕获组的解析式；base64url 秘密段本身可能含 `_`，所以不能用 split('_') 切。 */
const PLAINTEXT_PARSE = /^dblab_([a-z0-9]{8})_([A-Za-z0-9_-]{43})$/

export interface GeneratedApiKey {
  plaintextKey: string
  lookupId: string
  secret: string
  secretHash: string
}

export function generateApiKey(): GeneratedApiKey {
  // hex 字符集落在 [a-z0-9] 内，天然满足定位段的形态约束。
  const lookupId = randomBytes(LOOKUP_BYTES).toString('hex')
  const secret = randomBytes(SECRET_BYTES).toString('base64url')
  return {
    plaintextKey: `${ROOT}_${lookupId}_${secret}`,
    lookupId,
    secret,
    secretHash: hashApiKeySecret(secret),
  }
}

export function hashApiKeySecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex')
}

export function parseApiKeyPlaintext(plaintext: string): { lookupId: string; secret: string } | null {
  const m = PLAINTEXT_PARSE.exec(plaintext.trim())
  if (!m) return null
  return { lookupId: m[1] as string, secret: m[2] as string }
}

export function verifyApiKeySecret(secret: string, storedHash: string): boolean {
  const computed = Buffer.from(hashApiKeySecret(secret), 'hex')
  const stored = Buffer.from(storedHash, 'hex')
  if (computed.length !== stored.length || stored.length === 0) return false
  return timingSafeEqual(computed, stored)
}

/**
 * 定位段没查到行时也走一次同价比对。
 * 否则「查不到立刻 401」比「查到再算摘要」快，定位段就能被逐字节枚举。
 */
export const DUMMY_API_KEY_HASH = hashApiKeySecret(randomBytes(SECRET_BYTES).toString('base64url'))

export function wasteApiKeyComparison(secret: string): void {
  verifyApiKeySecret(secret, DUMMY_API_KEY_HASH)
}

/** 库里存的展示用前缀：dblab_<定位段>，不含秘密段。 */
export function apiKeyPrefix(lookupId: string): string {
  return `${ROOT}_${lookupId}`
}
