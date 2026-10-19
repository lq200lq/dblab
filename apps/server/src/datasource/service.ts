import type {
  Datasource,
  DatasourceCreate,
  DatasourceProbe,
  DatasourceTestResult,
  DatasourceUpdate,
} from '@dblab/shared'
import { apiKeyGrant, datasource, encryptSecret, type PlatformDb } from '@dblab/db'
import { eq, sql } from 'drizzle-orm'

import { AppError } from '../common/errors'
import { isUniqueViolation } from '../common/pg-errors'

import { connectionTesterFor } from './adapters/registry'
import { resolveDriverConfig, sslFlagsOf, type DatasourceRow, type ResolvedDriverConfig } from './driver-config'
import type { PoolRegistry } from './pool-registry'

/**
 * 数据源管理。对外只回 `passwordConfigured`，明文与密文都不出这个服务。
 * 带上 pools 后，改配置或停用会顺手清掉对应的连接池。
 */
export class DatasourceService {
  constructor(
    private readonly db: PlatformDb,
    private readonly pools?: PoolRegistry,
    private readonly probeTimeoutMs = 8_000,
  ) {}

  async list(): Promise<Datasource[]> {
    const rows = await this.db.select().from(datasource).orderBy(datasource.id)
    const counts = await this.grantCounts()
    return rows.map((row) => toDto(row, counts.get(row.id) ?? 0))
  }

  async get(id: number): Promise<Datasource> {
    const row = await this.getRow(id)
    const counts = await this.grantCounts(id)
    return toDto(row, counts.get(row.id) ?? 0)
  }

  /** 需要原始行（密文）时用这个；路由层不要直接用它去拼响应。 */
  async getRow(id: number): Promise<DatasourceRow> {
    const rows = await this.db.select().from(datasource).where(eq(datasource.id, id)).limit(1)
    const row = rows[0]
    if (!row) throw new AppError('DATASOURCE_NOT_FOUND')
    return row
  }

  /** MCP 侧按名字解析数据源：名字是 Agent 给的，查不到很正常，返回 null 而不是抛。 */
  async findByName(name: string): Promise<DatasourceRow | null> {
    const rows = await this.db.select().from(datasource).where(eq(datasource.name, name)).limit(1)
    return rows[0] ?? null
  }

  async create(input: DatasourceCreate): Promise<Datasource> {
    try {
      const rows = await this.db
        .insert(datasource)
        .values({
          name: input.name,
          engine: input.engine,
          host: input.host,
          port: input.port,
          databaseName: input.database,
          username: input.username,
          passwordCiphertext: encryptSecret(input.password),
          connectOptions: input.connectOptions ?? {},
          enabled: input.enabled ?? true,
        })
        .returning()
      const row = rows[0] as DatasourceRow
      return toDto(row, 0)
    } catch (error) {
      if (isUniqueViolation(error)) throw new AppError('DATASOURCE_NAME_TAKEN')
      throw error
    }
  }

  /** 不带 password 表示「不改口令」：既有密文逐字节保留，不做无意义的重新加密。 */
  async update(id: number, input: DatasourceUpdate): Promise<Datasource> {
    await this.getRow(id)

    const patch: Partial<DatasourceRow> = { updatedAt: new Date() }
    if (input.name !== undefined) patch.name = input.name
    if (input.engine !== undefined) patch.engine = input.engine
    if (input.host !== undefined) patch.host = input.host
    if (input.port !== undefined) patch.port = input.port
    if (input.database !== undefined) patch.databaseName = input.database
    if (input.username !== undefined) patch.username = input.username
    if (input.connectOptions !== undefined) patch.connectOptions = input.connectOptions
    if (input.enabled !== undefined) patch.enabled = input.enabled
    if (input.password !== undefined) patch.passwordCiphertext = encryptSecret(input.password)

    try {
      await this.db.update(datasource).set(patch).where(eq(datasource.id, id))
    } catch (error) {
      if (isUniqueViolation(error)) throw new AppError('DATASOURCE_NAME_TAKEN')
      throw error
    }

    // 连接参数变了由池指纹自动兜住；停用则要立刻把连接放掉。
    if (input.enabled === false) await this.pools?.evict(id)

    return this.get(id)
  }

  async remove(id: number): Promise<void> {
    await this.getRow(id)
    // 授权行靠外键级联删除；审计里保留反范式的数据源名，历史记录不会因此断线。
    await this.db.delete(datasource).where(eq(datasource.id, id))
    await this.pools?.evict(id)
  }

  /** 连通性探测，并把结果落到 last_test_*，界面上不必每次现测。 */
  async testConnection(id: number): Promise<DatasourceTestResult> {
    const row = await this.getRow(id)
    const tester = connectionTesterFor(row.engine)

    const result = await withTimeout(tester(resolveDriverConfig(row)), this.probeTimeoutMs)

    await this.db
      .update(datasource)
      .set({
        lastTestAt: new Date(),
        lastTestOk: result.ok,
        lastTestError: result.ok ? null : result.message,
        updatedAt: new Date(),
      })
      .where(eq(datasource.id, id))

    return result
  }

  /**
   * 探测一份配置，**不写库、也不碰 last_test_***：表单里的试连不代表这份配置已生效。
   * 口令留空时沿用 `datasourceId` 那行已存的密文，其余字段以请求为准。
   */
  async probe(input: DatasourceProbe): Promise<DatasourceTestResult> {
    const config: ResolvedDriverConfig = {
      engine: input.engine,
      host: input.host,
      port: input.port,
      database: input.database,
      user: input.username,
      password: input.password ?? (await this.storedPassword(input.datasourceId)),
      ...sslFlagsOf(input.connectOptions ?? {}),
    }
    return withTimeout(connectionTesterFor(input.engine)(config), this.probeTimeoutMs)
  }

  /** 契约层已经保证「无口令必带 id」，这里只是把那条不变式落成代码。 */
  private async storedPassword(id: number | undefined): Promise<string> {
    if (id === undefined) throw new AppError('VALIDATION_FAILED')
    return resolveDriverConfig(await this.getRow(id)).password
  }

  private async grantCounts(datasourceId?: number): Promise<Map<number, number>> {
    const query = this.db
      .select({
        datasourceId: apiKeyGrant.datasourceId,
        value: sql<number>`cast(count(*) as int)`,
      })
      .from(apiKeyGrant)
      .groupBy(apiKeyGrant.datasourceId)

    const rows = datasourceId === undefined
      ? await query
      : await query.where(eq(apiKeyGrant.datasourceId, datasourceId))

    return new Map(rows.map((row) => [row.datasourceId, row.value]))
  }
}

function toDto(row: DatasourceRow, grantedKeyCount: number): Datasource {
  return {
    id: row.id,
    name: row.name,
    engine: row.engine,
    host: row.host,
    port: row.port,
    database: row.databaseName,
    username: row.username,
    passwordConfigured: row.passwordCiphertext.length > 0,
    connectOptions: row.connectOptions,
    enabled: row.enabled,
    lastTestAt: row.lastTestAt ? row.lastTestAt.toISOString() : null,
    lastTestOk: row.lastTestOk,
    lastTestError: row.lastTestError,
    grantedKeyCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/** 探测超时兜一层：驱动自己的连接超时之外，防止某个库把请求挂死。 */
async function withTimeout(
  promise: Promise<DatasourceTestResult>,
  timeoutMs: number,
): Promise<DatasourceTestResult> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<DatasourceTestResult>((resolve) => {
    timer = setTimeout(() => {
      resolve({
        ok: false,
        latencyMs: timeoutMs,
        serverVersion: null,
        errorCode: 'DATASOURCE_UNREACHABLE',
        message: `连通性探测超过 ${timeoutMs}ms 未返回`,
      })
    }, timeoutMs)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
