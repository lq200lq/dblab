import { CliError } from './errors'

/**
 * 密钥明文形态：`dblab_<8 位定位段>_<43 位 base64url 秘密段>`。
 *
 * 与 packages/shared/src/schemas/api-key.ts:18 同源，但这里刻意复制一份：
 * CLI 要作为独立 npm 包发布，不能依赖私有工作区包。服务端才是权威校验，
 * 这里只做「明显不是一把密钥」的快速拦截。
 */
export const API_KEY_SHAPE = /^dblab_[a-z0-9]{8}_[A-Za-z0-9_-]{43}$/

export function isValidApiKeyShape(value: string): boolean {
  return API_KEY_SHAPE.test(value.trim())
}

export function assertApiKeyShape(value: string): string {
  const trimmed = value.trim()
  if (!isValidApiKeyShape(trimmed)) {
    throw new CliError(
      'usage',
      '密钥形态不对',
      '应为 dblab_ 开头的完整明文（管控台签发时只显示一次），不要只复制前半段。',
    )
  }
  return trimmed
}

/**
 * 库里存的定位前缀是 `dblab_<8 位定位段>`（packages/db/src/api-key-secret.ts:65）。
 * 秘密段本身可能含 `_`，所以必须用捕获组取，不能 split('_')。
 */
const PLAINTEXT_PARSE = /^dblab_([a-z0-9]{8})_/

export function apiKeyPrefixOf(plaintext: string): string {
  const match = PLAINTEXT_PARSE.exec(plaintext.trim())
  if (!match) return ''
  return `dblab_${match[1]}`
}

/**
 * 脱敏展示：定位段本身不是秘密（库里也只存它的明文），秘密段一律遮掉。
 * 任何输出路径都必须先过这里，避免密钥进日志。
 *
 * 秘密段是 base64url，本身可能含 `_`，所以按前两段定位而不是 split('_')。
 */
export function maskKey(value: string): string {
  const trimmed = value.trim()
  const match = /^dblab_([a-z0-9]{8})_/.exec(trimmed)
  if (!match) return 'dblab_••••'
  return `dblab_${match[1]}_••••`
}
