import type { ApiKey, ApiKeyCreate, ApiKeyDetail, ApiKeyGrant, ApiKeyUpdate } from '@dblab/shared'
import {
  apiKey,
  apiKeyGrant,
  apiKeyPrefix,
  datasource,
  generateApiKey,
  type PlatformDb,
} from '@dblab/db'
import { asc, eq, sql } from 'drizzle-orm'

import { AppError } from '../common/errors'
import { isForeignKeyViolation } from '../common/pg-errors'

export type ApiKeyRow = typeof apiKey.$inferSelect
export type ApiKeyGrantRow = typeof apiKeyGrant.$inferSelect

export interface ApiKeyCreateResult {
  detail: ApiKeyDetail
  /** 唯一一次出现明文的地方。库里只有定位段与秘密段的摘要。 */
  plaintextKey: string
}

export interface GrantPermission {
  canRead: boolean
  canWrite: boolean
}

/** lastUsedAt 的写入节流：一个高频 Agent 不该把每次调用都变成一次写库。 */
const LAST_USED_THROTTLE_MS = 60_000

export class ApiKeyService {
  private readonly lastUsedWrites = new Map<number, number>()

  constructor(private readonly db: PlatformDb) {}

  async list(): Promise<ApiKey[]> {
    const rows = await this.db.select().from(apiKey).orderBy(apiKey.id)
    const counts = await this.grantCounts()
    return rows.map((row) => toApiKey(row, counts.get(row.id) ?? 0))
  }

  async getRow(id: number): Promise<ApiKeyRow> {
    const rows = await this.db.select().from(apiKey).where(eq(apiKey.id, id)).limit(1)
    const row = rows[0]
    if (!row) throw new AppError('API_KEY_NOT_FOUND')
    return row
  }

  async detail(id: number): Promise<ApiKeyDetail> {
    const row = await this.getRow(id)
    const grants = await this.grantsOf(id)
    return toDetail(row, grants)
  }

  async create(input: ApiKeyCreate, createdBy: number | null): Promise<ApiKeyCreateResult> {
    assertNoDuplicateDatasources(input.grants ?? [])

    const generated = generateApiKey()
    const expiresAt = toDate(input.expiresAt)

    let createdId: number
    try {
      createdId = await this.db.transaction(async (tx) => {
        const inserted = await tx
          .insert(apiKey)
          .values({
            name: input.name,
            prefix: apiKeyPrefix(generated.lookupId),
            keyHash: generated.secretHash,
            status: 'active',
            expiresAt,
            ipAllowlist: input.ipAllowlist ?? [],
            createdBy,
          })
          .returning()
        const row = inserted[0] as ApiKeyRow

        // 密钥与它的初始授权必须一起成功，否则会留下「建了密钥但没授权」的半成品。
        if (input.grants && input.grants.length > 0) {
          await tx.insert(apiKeyGrant).values(
            input.grants.map((grant) => ({
              apiKeyId: row.id,
              datasourceId: grant.datasourceId,
              canRead: grant.canRead,
              canWrite: grant.canWrite,
            })),
          )
        }
        return row.id
      })
    } catch (error) {
      if (isForeignKeyViolation(error)) {
        throw new AppError('DATASOURCE_NOT_FOUND', '授权里有不存在的数据源')
      }
      throw error
    }

    return { detail: await this.detail(createdId), plaintextKey: generated.plaintextKey }
  }

  async update(id: number, input: ApiKeyUpdate): Promise<ApiKeyDetail> {
    await this.getRow(id)

    const patch: Partial<ApiKeyRow> = { updatedAt: new Date() }
    if (input.name !== undefined) patch.name = input.name
    if (input.expiresAt !== undefined) patch.expiresAt = toDate(input.expiresAt)
    if (input.ipAllowlist !== undefined) patch.ipAllowlist = input.ipAllowlist
    if (input.status !== undefined) patch.status = input.status

    await this.db.update(apiKey).set(patch).where(eq(apiKey.id, id))
    return this.detail(id)
  }

  /** 吊销是软删除：审计里引用的是密钥 id，记录不能凭空消失。 */
  async revoke(id: number): Promise<void> {
    await this.getRow(id)
    await this.db
      .update(apiKey)
      .set({ status: 'revoked', updatedAt: new Date() })
      .where(eq(apiKey.id, id))
  }

  /** 授权按整表替换：先删后插，在一个事务里，避免出现「删完了但没插上」的空窗。 */
  async replaceGrants(
    id: number,
    grants: ReadonlyArray<{ datasourceId: number } & GrantPermission>,
  ): Promise<ApiKeyDetail> {
    await this.getRow(id)
    assertNoDuplicateDatasources(grants)

    try {
      await this.db.transaction(async (tx) => {
        await tx.delete(apiKeyGrant).where(eq(apiKeyGrant.apiKeyId, id))
        if (grants.length > 0) {
          await tx.insert(apiKeyGrant).values(
            grants.map((grant) => ({
              apiKeyId: id,
              datasourceId: grant.datasourceId,
              canRead: grant.canRead,
              canWrite: grant.canWrite,
            })),
          )
        }
      })
    } catch (error) {
      if (isForeignKeyViolation(error)) {
        throw new AppError('DATASOURCE_NOT_FOUND', '授权里有不存在的数据源')
      }
      throw error
    }

    return this.detail(id)
  }

  async grantsOf(id: number): Promise<ApiKeyGrant[]> {
    const rows = await this.db
      .select({
        datasourceId: apiKeyGrant.datasourceId,
        canRead: apiKeyGrant.canRead,
        canWrite: apiKeyGrant.canWrite,
        datasourceName: datasource.name,
      })
      .from(apiKeyGrant)
      .innerJoin(datasource, eq(datasource.id, apiKeyGrant.datasourceId))
      .where(eq(apiKeyGrant.apiKeyId, id))
      .orderBy(asc(datasource.name))

    return rows.map((row) => ({
      datasourceId: row.datasourceId,
      datasourceName: row.datasourceName,
      canRead: row.canRead,
      canWrite: row.canWrite,
    }))
  }

  /** MCP 侧按数据源判权用：一次查完，不在每次工具调用里再回库。 */
  async permissionMap(id: number): Promise<Map<number, GrantPermission>> {
    const rows = await this.db
      .select({
        datasourceId: apiKeyGrant.datasourceId,
        canRead: apiKeyGrant.canRead,
        canWrite: apiKeyGrant.canWrite,
      })
      .from(apiKeyGrant)
      .where(eq(apiKeyGrant.apiKeyId, id))

    return new Map(rows.map((row) => [row.datasourceId, { canRead: row.canRead, canWrite: row.canWrite }]))
  }

  async touchLastUsed(id: number, now: Date = new Date()): Promise<void> {
    const lastWrite = this.lastUsedWrites.get(id) ?? 0
    if (now.getTime() - lastWrite < LAST_USED_THROTTLE_MS) return
    this.lastUsedWrites.set(id, now.getTime())
    await this.db.update(apiKey).set({ lastUsedAt: now }).where(eq(apiKey.id, id))
  }

  private async grantCounts(): Promise<Map<number, number>> {
    const rows = await this.db
      .select({ apiKeyId: apiKeyGrant.apiKeyId, value: sql<number>`cast(count(*) as int)` })
      .from(apiKeyGrant)
      .groupBy(apiKeyGrant.apiKeyId)
    return new Map(rows.map((row) => [row.apiKeyId, row.value]))
  }
}

function assertNoDuplicateDatasources(
  grants: ReadonlyArray<{ datasourceId: number }>,
): void {
  const seen = new Set<number>()
  for (const grant of grants) {
    if (seen.has(grant.datasourceId)) {
      throw new AppError('VALIDATION_FAILED', '同一个数据源不能重复授权')
    }
    seen.add(grant.datasourceId)
  }
}

function toDate(value: string | null | undefined): Date | null {
  if (value === undefined || value === null) return null
  return new Date(value)
}

function toApiKey(row: ApiKeyRow, datasourceCount: number): ApiKey {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    status: row.status,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    ipAllowlist: row.ipAllowlist,
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    datasourceCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

function toDetail(row: ApiKeyRow, grants: ApiKeyGrant[]): ApiKeyDetail {
  return { ...toApiKey(row, grants.length), grants }
}
