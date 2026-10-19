import { z } from 'zod'

/** 表/列内省的结果形态。MCP 的 list_tables / describe_table 直接回这些。 */

export const tableSummarySchema = z.object({
  schema: z.string(),
  name: z.string(),
  /** 表 / 视图 / 物化视图。 */
  kind: z.string(),
})
export type TableSummary = z.infer<typeof tableSummarySchema>

export const columnInfoSchema = z.object({
  name: z.string(),
  dataType: z.string(),
  nullable: z.boolean(),
  defaultValue: z.string().nullable(),
  /** 是否属于主键。 */
  primaryKey: z.boolean(),
})
export type ColumnInfo = z.infer<typeof columnInfoSchema>

export const tableDescriptionSchema = z.object({
  schema: z.string(),
  name: z.string(),
  columns: z.array(columnInfoSchema),
  primaryKey: z.array(z.string()),
})
export type TableDescription = z.infer<typeof tableDescriptionSchema>

/**
 * 查询结果。行数据在结构化输出里是**规范化过**的：
 * BigInt → 十进制字符串、Date → ISO、二进制 → 占位描述，见服务端的 normalize。
 */
export const queryResultSchema = z.object({
  columns: z.array(z.string()),
  rows: z.array(z.record(z.string(), z.unknown())),
  /** 返回或影响的行数。查询被 maxRows 截断时这里是**已返回**的行数。 */
  rowCount: z.number().int().nonnegative(),
  /** 命中行数上限而截断。 */
  truncated: z.boolean(),
})
export type QueryResult = z.infer<typeof queryResultSchema>
