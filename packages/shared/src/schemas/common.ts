import { z } from 'zod'

/** 数据源引擎。适配器注册表按这个值分派。 */
export const ENGINE_VALUES = ['postgres', 'mysql'] as const
export const engineSchema = z.enum(ENGINE_VALUES)
export type Engine = (typeof ENGINE_VALUES)[number]

export const ENGINE_LABEL: Record<Engine, string> = {
  postgres: 'PostgreSQL',
  mysql: 'MySQL',
}

/** 主键。平台自身表用 bigserial，量级远小于 2^53，仓储层读出来统一 Number() 化。 */
export const idSchema = z.number().int().positive()

export const pageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(20),
})
export type PageQuery = z.infer<typeof pageQuerySchema>

export function paginated<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    total: z.number().int().nonnegative(),
    page: z.number().int().positive(),
    pageSize: z.number().int().positive(),
  })
}

/** ISO 8601 字符串。出参一律走字符串，避免前后端 Date 序列化口径不一。 */
export const isoDateTimeSchema = z.string()

/** 入参用的时间：必须是能解析的 ISO 8601，否则会出现 Invalid Date 一路写进库。 */
export const isoDateTimeInputSchema = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)), '时间格式不正确')
