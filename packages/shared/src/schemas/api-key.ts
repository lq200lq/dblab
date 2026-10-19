import { z } from 'zod'

import { isValidCidrInput } from '../net/cidr'

import { idSchema, isoDateTimeInputSchema, isoDateTimeSchema } from './common'

export const API_KEY_STATUSES = ['active', 'disabled', 'revoked'] as const
export const apiKeyStatusSchema = z.enum(API_KEY_STATUSES)
export type ApiKeyStatus = (typeof API_KEY_STATUSES)[number]

export const API_KEY_STATUS_LABEL: Record<ApiKeyStatus, string> = {
  active: '启用',
  disabled: '停用',
  revoked: '已吊销',
}

/** 密钥明文形态：dblab_<8 位定位段>_<43 位 base64url 秘密段>。仅创建时返回一次。 */
export const API_KEY_PLAINTEXT_PATTERN = /^dblab_[a-z0-9]{8}_[A-Za-z0-9_-]{43}$/

export const ipAllowlistSchema = z
  .array(z.string().refine(isValidCidrInput, 'IP 或网段格式不正确（如 10.0.0.0/8、127.0.0.1）'))
  .max(64, '白名单最多 64 条')

/** 一条授权：密钥 × 数据源 × 读/写。两项都关掉的授权没有意义，直接挡在契约层。 */
export const grantInputSchema = z
  .object({
    datasourceId: idSchema,
    canRead: z.boolean(),
    canWrite: z.boolean(),
  })
  .refine((g) => g.canRead || g.canWrite, '授权至少要给出读或写其中一项')

export const apiKeyCreateSchema = z.object({
  name: z.string().min(1, '请填写名称').max(64),
  /** 为空表示永不过期。 */
  expiresAt: isoDateTimeInputSchema.nullable().optional(),
  ipAllowlist: ipAllowlistSchema.optional(),
  grants: z.array(grantInputSchema).optional(),
})
export type ApiKeyCreate = z.infer<typeof apiKeyCreateSchema>

export const apiKeyUpdateSchema = z.object({
  name: z.string().min(1, '请填写名称').max(64).optional(),
  expiresAt: isoDateTimeInputSchema.nullable().optional(),
  ipAllowlist: ipAllowlistSchema.optional(),
  /** 吊销不经这里，走 DELETE。 */
  status: z.enum(['active', 'disabled']).optional(),
})
export type ApiKeyUpdate = z.infer<typeof apiKeyUpdateSchema>

export const apiKeyGrantsUpdateSchema = z.object({
  grants: z.array(grantInputSchema),
})
export type ApiKeyGrantsUpdate = z.infer<typeof apiKeyGrantsUpdateSchema>

export const apiKeyGrantSchema = z.object({
  datasourceId: idSchema,
  datasourceName: z.string(),
  canRead: z.boolean(),
  canWrite: z.boolean(),
})
export type ApiKeyGrant = z.infer<typeof apiKeyGrantSchema>

export const apiKeySchema = z.object({
  id: idSchema,
  name: z.string(),
  prefix: z.string(),
  status: apiKeyStatusSchema,
  expiresAt: isoDateTimeSchema.nullable(),
  ipAllowlist: z.array(z.string()),
  lastUsedAt: isoDateTimeSchema.nullable(),
  datasourceCount: z.number().int().nonnegative(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
})
export type ApiKey = z.infer<typeof apiKeySchema>

export const apiKeyDetailSchema = apiKeySchema.extend({
  grants: z.array(apiKeyGrantSchema),
})
export type ApiKeyDetail = z.infer<typeof apiKeyDetailSchema>

/** 创建响应：唯一会带明文密钥的地方。 */
export const apiKeyCreatedSchema = apiKeyDetailSchema.extend({
  plaintextKey: z.string().regex(API_KEY_PLAINTEXT_PATTERN),
})
export type ApiKeyCreated = z.infer<typeof apiKeyCreatedSchema>
