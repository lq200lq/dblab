import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

/**
 * 管理员口令哈希。scrypt（内存硬化）而不是 bcrypt/argon2：Node 自带、无需编译依赖。
 * 存储格式：scrypt$N$r$p$<salt b64>$<hash b64>
 */

const SALT_BYTES = 16
const KEY_LEN = 32
const PARAMS = { N: 16384, r: 8, p: 1 } as const
const ALGO = 'scrypt'

export function hashPassword(plain: string): string {
  const salt = randomBytes(SALT_BYTES)
  const hash = scryptSync(plain, salt, KEY_LEN, PARAMS)
  return [ALGO, PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64'), hash.toString('base64')].join(
    '$',
  )
}

interface ParsedHash {
  salt: Buffer
  hash: Buffer
  N: number
  r: number
  p: number
}

function parseStored(stored: string): ParsedHash | null {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== ALGO) return null
  const [, n, r, p, saltB64, hashB64] = parts as [string, string, string, string, string, string]
  const N = Number(n)
  const rr = Number(r)
  const pp = Number(p)
  if (!Number.isInteger(N) || !Number.isInteger(rr) || !Number.isInteger(pp)) return null
  try {
    return { salt: Buffer.from(saltB64, 'base64'), hash: Buffer.from(hashB64, 'base64'), N, r: rr, p: pp }
  } catch {
    return null
  }
}

export function verifyPassword(plain: string, stored: string): boolean {
  const parsed = parseStored(stored)
  if (!parsed) return false
  const computed = scryptSync(plain, parsed.salt, parsed.hash.length, {
    N: parsed.N,
    r: parsed.r,
    p: parsed.p,
  })
  return computed.length === parsed.hash.length && timingSafeEqual(computed, parsed.hash)
}

/**
 * 账号不存在时也走一次同参数比对。
 * 否则「立刻返回」与「算完再返回」的时间差可以被用来枚举账号。
 */
export const DUMMY_PASSWORD_HASH = hashPassword(randomBytes(24).toString('hex'))

export function wastePasswordComparison(plain: string): void {
  verifyPassword(plain, DUMMY_PASSWORD_HASH)
}
