import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { API_KEY_PLAINTEXT_PATTERN } from '@dblab/shared'

import {
  apiKeyPrefix,
  generateApiKey,
  hashApiKeySecret,
  parseApiKeyPlaintext,
  verifyApiKeySecret,
  wasteApiKeyComparison,
} from '../src/api-key-secret'
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword, wastePasswordComparison } from '../src/password'
import {
  CredentialUndecryptableError,
  MasterKeyUnavailableError,
  decryptSecret,
  describeMasterKeyStatus,
  encryptSecret,
  masterKeyFilePath,
  resetMasterKeyCache,
} from '../src/secret-cipher'

const KEY_A = randomBytes(32).toString('base64')
const KEY_B = randomBytes(32).toString('base64')

const savedMasterKey = process.env.CREDENTIAL_MASTER_KEY
const savedMasterKeyFile = process.env.CREDENTIAL_MASTER_KEY_FILE

function useMasterKey(value: string | undefined, filePath?: string): void {
  if (value === undefined) delete process.env.CREDENTIAL_MASTER_KEY
  else process.env.CREDENTIAL_MASTER_KEY = value
  if (filePath === undefined) delete process.env.CREDENTIAL_MASTER_KEY_FILE
  else process.env.CREDENTIAL_MASTER_KEY_FILE = filePath
  resetMasterKeyCache()
}

beforeEach(() => {
  useMasterKey(KEY_A)
})

afterEach(() => {
  if (savedMasterKey === undefined) delete process.env.CREDENTIAL_MASTER_KEY
  else process.env.CREDENTIAL_MASTER_KEY = savedMasterKey
  if (savedMasterKeyFile === undefined) delete process.env.CREDENTIAL_MASTER_KEY_FILE
  else process.env.CREDENTIAL_MASTER_KEY_FILE = savedMasterKeyFile
  resetMasterKeyCache()
})

describe('secret-cipher', () => {
  test('加解密往返', () => {
    const plain = 'p@ssw0rd:含中文/带@:#?%&符号'
    const cipher = encryptSecret(plain)
    expect(cipher.startsWith('v1:')).toBe(true)
    expect(cipher).not.toContain(plain)
    expect(decryptSecret(cipher)).toBe(plain)
  })

  test('同一明文两次加密结果不同（IV 随机）', () => {
    expect(encryptSecret('same')).not.toBe(encryptSecret('same'))
  })

  test('密文被篡改即报 credential_undecryptable', () => {
    const cipher = encryptSecret('hello')
    const parts = cipher.split(':')
    const data = Buffer.from(parts[3] as string, 'base64')
    data[0] = (data[0] as number) ^ 0xff
    const tampered = [parts[0], parts[1], parts[2], data.toString('base64')].join(':')
    expect(() => decryptSecret(tampered)).toThrow(CredentialUndecryptableError)
  })

  test('换主密钥后解不开，且错误码是 credential_undecryptable', () => {
    const cipher = encryptSecret('hello')
    useMasterKey(KEY_B)
    try {
      decryptSecret(cipher)
      throw new Error('不该成功')
    } catch (err) {
      expect(err).toBeInstanceOf(CredentialUndecryptableError)
      expect((err as CredentialUndecryptableError).code).toBe('CREDENTIAL_UNDECRYPTABLE')
    }
  })

  test('格式不可识别的密文同样抛错，不返回空串', () => {
    expect(() => decryptSecret('garbage')).toThrow(CredentialUndecryptableError)
    expect(() => decryptSecret('v2:a:b:c')).toThrow(CredentialUndecryptableError)
    expect(() => decryptSecret('v1::b:c')).toThrow(CredentialUndecryptableError)
  })

  test('主密钥长度不对时报 master_key_unavailable', () => {
    useMasterKey(Buffer.from('too-short').toString('base64'))
    try {
      encryptSecret('x')
      throw new Error('不该成功')
    } catch (err) {
      expect(err).toBeInstanceOf(MasterKeyUnavailableError)
      expect((err as MasterKeyUnavailableError).code).toBe('MASTER_KEY_UNAVAILABLE')
    }
  })

  test('没有 env 时落到密钥文件：自检先说不可用，生成后可用且密文能解回', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dblab-key-'))
    const file = join(dir, 'nested', 'credential-master.key')
    try {
      useMasterKey(undefined, file)
      const before = describeMasterKeyStatus()
      expect(before.usable).toBe(false)
      expect(before.source).toBe('file')

      const cipher = encryptSecret('落盘密钥')
      expect(existsSync(file)).toBe(true)
      expect(readFileSync(file, 'utf8').trim().length).toBeGreaterThan(0)

      resetMasterKeyCache()
      expect(describeMasterKeyStatus().usable).toBe(true)
      expect(decryptSecret(cipher)).toBe('落盘密钥')
      expect(masterKeyFilePath()).toBe(file)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('密钥文件已存在时不被覆盖（既有密文才解得开）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dblab-key-'))
    try {
      const file = join(dir, 'credential-master.key')
      useMasterKey(undefined, file)
      const cipher = encryptSecret('第一次')
      resetMasterKeyCache()
      expect(decryptSecret(cipher)).toBe('第一次')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('password', () => {
  test('正确口令通过、错误口令不通过', () => {
    const stored = hashPassword('admin123')
    expect(stored.startsWith('scrypt$')).toBe(true)
    expect(stored).not.toContain('admin123')
    expect(verifyPassword('admin123', stored)).toBe(true)
    expect(verifyPassword('admin124', stored)).toBe(false)
    expect(verifyPassword('', stored)).toBe(false)
  })

  test('同一口令两次哈希不同（盐随机）', () => {
    expect(hashPassword('same')).not.toBe(hashPassword('same'))
  })

  test('存储值损坏时不抛异常，只返回 false', () => {
    expect(verifyPassword('x', 'not-a-hash')).toBe(false)
    expect(verifyPassword('x', 'scrypt$1$2$3$4')).toBe(false)
  })

  test('防枚举用的 dummy 比对可用', () => {
    expect(DUMMY_PASSWORD_HASH.startsWith('scrypt$')).toBe(true)
    expect(() => wastePasswordComparison('whatever')).not.toThrow()
  })
})

describe('api-key-secret', () => {
  test('明文形态符合契约（并由 shared 的正则复核）', () => {
    for (let i = 0; i < 50; i++) {
      const key = generateApiKey()
      expect(key.plaintextKey).toMatch(API_KEY_PLAINTEXT_PATTERN)
      expect(key.lookupId).toMatch(/^[a-z0-9]{8}$/)
      expect(key.secret).toHaveLength(43)
      expect(key.secretHash).toHaveLength(64)
      expect(key.plaintextKey).toContain(key.lookupId)
      expect(key.plaintextKey).toContain(key.secret)
    }
  })

  test('一个密钥解析回自己的定位段与秘密段', () => {
    const key = generateApiKey()
    const parsed = parseApiKeyPlaintext(key.plaintextKey)
    expect(parsed).not.toBeNull()
    expect(parsed?.lookupId).toBe(key.lookupId)
    expect(parsed?.secret).toBe(key.secret)
    expect(apiKeyPrefix(key.lookupId)).toBe(`dblab_${key.lookupId}`)
  })

  test('秘密段含下划线时也能正确解析', () => {
    const secret = `a-b_c-d${'x'.repeat(36)}`
    expect(secret).toHaveLength(43)
    const parsed = parseApiKeyPlaintext(`dblab_expand00_${secret}`)
    expect(parsed).not.toBeNull()
    expect(parsed?.secret).toBe(secret)
  })

  test('非法明文一律解析为 null', () => {
    expect(parseApiKeyPlaintext('')).toBeNull()
    expect(parseApiKeyPlaintext('dblab_x_y')).toBeNull()
    expect(parseApiKeyPlaintext('dblab_ABCDEFGH_' + 'a'.repeat(43))).toBeNull()
    expect(parseApiKeyPlaintext('dblab_ab12cd34_' + 'a'.repeat(42))).toBeNull()
  })

  test('摘要比对：命中/不命中/空摘要', () => {
    const key = generateApiKey()
    expect(verifyApiKeySecret(key.secret, key.secretHash)).toBe(true)
    expect(verifyApiKeySecret(key.secret + 'x', key.secretHash)).toBe(false)
    expect(verifyApiKeySecret('', '')).toBe(false)
    expect(verifyApiKeySecret(key.secret, '')).toBe(false)
  })

  test('摘要里不含明文秘密段', () => {
    const key = generateApiKey()
    expect(key.secretHash).not.toContain(key.secret)
    expect(hashApiKeySecret(key.secret)).toBe(key.secretHash)
  })

  test('防枚举用的 dummy 比对可用', () => {
    expect(() => wasteApiKeyComparison('guess')).not.toThrow()
  })
})
