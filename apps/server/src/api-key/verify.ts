import type { ErrorCode } from '@dblab/shared'
import { isIpAllowed } from '@dblab/shared'
import {
  apiKey,
  apiKeyPrefix,
  parseApiKeyPlaintext,
  verifyApiKeySecret,
  wasteApiKeyComparison,
  type PlatformDb,
} from '@dblab/db'
import { eq } from 'drizzle-orm'

import type { ApiKeyRow } from './service'

export type ApiKeyAuthResult = { ok: true; key: ApiKeyRow } | { ok: false; code: ErrorCode }

/** `Authorization: Bearer dblab_...`。方案名大小写不敏感。 */
export function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null
  const match = /^\s*Bearer\s+(\S+)\s*$/i.exec(header)
  return match ? (match[1] as string) : null
}

/**
 * 解析 Bearer 密钥 → 可用上下文。
 *
 * 检查顺序是刻意的：**先验秘密段，再看状态与期限**。
 * 否则没有秘密段的人也能靠返回码把某把密钥的状态问出来。
 */
export async function resolveApiKeyContext(
  db: PlatformDb,
  plaintextKey: string | null,
  clientIp: string | null,
): Promise<ApiKeyAuthResult> {
  if (!plaintextKey) return { ok: false, code: 'API_KEY_INVALID' }

  const parsed = parseApiKeyPlaintext(plaintextKey)
  if (!parsed) return { ok: false, code: 'API_KEY_INVALID' }

  const rows = await db
    .select()
    .from(apiKey)
    .where(eq(apiKey.prefix, apiKeyPrefix(parsed.lookupId)))
    .limit(1)

  const row = rows[0]
  if (!row) {
    // 定位段不存在也要走一次同价比对，否则「查不到」比「查到再算」快，定位段能被枚举。
    wasteApiKeyComparison(parsed.secret)
    return { ok: false, code: 'API_KEY_INVALID' }
  }

  if (!verifyApiKeySecret(parsed.secret, row.keyHash)) {
    return { ok: false, code: 'API_KEY_INVALID' }
  }

  if (row.status === 'revoked') return { ok: false, code: 'API_KEY_REVOKED' }
  if (row.status === 'disabled') return { ok: false, code: 'API_KEY_DISABLED' }
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
    return { ok: false, code: 'API_KEY_EXPIRED' }
  }

  // 白名单为空表示不限制来源；非空时无法确定调用方 IP 一律不放行（fail-closed）。
  if (!isIpAllowed(clientIp ?? '', row.ipAllowlist)) {
    return { ok: false, code: 'IP_NOT_ALLOWED' }
  }

  return { ok: true, key: row }
}
