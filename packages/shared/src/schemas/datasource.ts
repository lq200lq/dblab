import { z } from 'zod'

import { ERROR_CODES } from '../errors'

import { engineSchema, idSchema, isoDateTimeSchema } from './common'

export const connectOptionsSchema = z.object({
  /** 走 SSL 连接。不同引擎的具体参数由适配器决定。 */
  ssl: z.boolean().optional(),
  /**
   * 是否校验证书链与主机名。**缺省即校验**（安全默认）；
   * 只有内网自签证书才允许显式关掉，且这个开关在界面上是可见的一项，不做静默降级。
   */
  sslVerify: z.boolean().optional(),
  /** 预留给「读授权用只读账号连接」，v1 不使用。 */
  readOnlyRole: z.string().max(128).optional(),
})
export type ConnectOptions = z.infer<typeof connectOptionsSchema>

const connectionFields = {
  name: z.string().min(1, '请填写名称').max(64),
  engine: engineSchema,
  host: z.string().min(1, '请填写主机').max(255),
  port: z.coerce.number().int().min(1).max(65535),
  database: z.string().min(1, '请填写库名').max(128),
  username: z.string().min(1, '请填写账号').max(128),
  connectOptions: connectOptionsSchema.optional(),
}

export const datasourceCreateSchema = z.object({
  ...connectionFields,
  password: z.string().min(1, '请填写口令').max(512),
  enabled: z.boolean().optional(),
})
export type DatasourceCreate = z.infer<typeof datasourceCreateSchema>

/** 口令缺省 = 不改动既有密文，这是「编辑时留空」这一交互的契约层表达。 */
export const datasourceUpdateSchema = z.object({
  name: connectionFields.name.optional(),
  engine: connectionFields.engine.optional(),
  host: connectionFields.host.optional(),
  port: connectionFields.port.optional(),
  database: connectionFields.database.optional(),
  username: connectionFields.username.optional(),
  password: z.string().min(1, '请填写口令').max(512).optional(),
  connectOptions: connectOptionsSchema.optional(),
  enabled: z.boolean().optional(),
})
export type DatasourceUpdate = z.infer<typeof datasourceUpdateSchema>

/**
 * 「先测再存」的探测入参。
 *
 * 口令可以不给，但必须同时给出 `datasourceId`：编辑表单里口令留空的语义是
 * 「沿用已存的那份」，服务端据此从该行取解密后的口令，其余字段一律以请求为准。
 */
export const datasourceProbeSchema = z
  .object({
    ...connectionFields,
    datasourceId: idSchema.optional(),
    // 空串按「没填」处理：否则编辑表单里留空会被当成填了一个空口令。
    password: z
      .string()
      .max(512)
      .optional()
      .transform((value) => (value ? value : undefined)),
  })
  .refine((input) => input.password !== undefined || input.datasourceId !== undefined, {
    message: '请填写口令，或指定要沿用其口令的数据源',
    path: ['password'],
  })
export type DatasourceProbe = z.infer<typeof datasourceProbeSchema>

export const datasourceSchema = z.object({
  id: idSchema,
  name: z.string(),
  engine: engineSchema,
  host: z.string(),
  port: z.number().int(),
  database: z.string(),
  username: z.string(),
  /** 只回「配没配」，任何情况下都不回明文或密文。 */
  passwordConfigured: z.boolean(),
  connectOptions: connectOptionsSchema,
  enabled: z.boolean(),
  lastTestAt: isoDateTimeSchema.nullable(),
  lastTestOk: z.boolean().nullable(),
  lastTestError: z.string().nullable(),
  grantedKeyCount: z.number().int().nonnegative(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
})
export type Datasource = z.infer<typeof datasourceSchema>

export const datasourceTestResultSchema = z.object({
  ok: z.boolean(),
  latencyMs: z.number().int().nonnegative(),
  serverVersion: z.string().nullable(),
  /** 失败原因码与文案；文案里不会出现任何凭据内容。 */
  errorCode: z.enum(ERROR_CODES).nullable(),
  message: z.string().nullable(),
})
export type DatasourceTestResult = z.infer<typeof datasourceTestResultSchema>

export const datasourceListSchema = z.object({
  items: z.array(datasourceSchema),
})
export type DatasourceList = z.infer<typeof datasourceListSchema>
