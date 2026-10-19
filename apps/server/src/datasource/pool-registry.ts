import { AppError } from '../common/errors'

import { adapterFactoryFor } from './adapters/registry'
import type { DriverAdapter } from './adapters/types'
import { resolveDriverConfig, type DatasourceRow } from './driver-config'

interface PoolEntry {
  adapter: DriverAdapter
  /** 连接参数指纹：变了就把旧池关掉重建，不拿旧口令继续连。 */
  signature: string
  lastUsedAt: number
}

export interface PoolRegistryOptions {
  poolMax: number
  idleEvictMinutes: number
  now?: () => number
}

/**
 * 按数据源维护连接池。
 *
 * 惰性创建（不预热）、配置变更即失效、空闲回收、退出统一关闭——
 * 四条都必要：PostgreSQL 默认 max_connections 只有 100，
 * 每源 4 条连接的话，二十几个数据源就能把平台自己饿死。
 */
export class PoolRegistry {
  private readonly entries = new Map<number, PoolEntry>()
  private sweeper: NodeJS.Timeout | undefined

  constructor(private readonly options: PoolRegistryOptions) {}

  get size(): number {
    return this.entries.size
  }

  async adapterFor(row: DatasourceRow): Promise<DriverAdapter> {
    // 停用的数据源不许拿到连接：这里是所有执行路径唯一的收口处，拦在这里最稳。
    if (!row.enabled) throw new AppError('DATASOURCE_DISABLED')

    const signature = signatureOf(row)
    const existing = this.entries.get(row.id)

    if (existing && existing.signature === signature) {
      existing.lastUsedAt = this.now()
      return existing.adapter
    }

    if (existing) await this.evict(row.id)

    const adapter = adapterFactoryFor(row.engine)(
      resolveDriverConfig(row),
      this.options.poolMax,
    )
    this.entries.set(row.id, { adapter, signature, lastUsedAt: this.now() })
    return adapter
  }

  /** 数据源被改/删后调用；配置指纹变了也会自动失效，这里是显式路径。 */
  async evict(datasourceId: number): Promise<void> {
    const entry = this.entries.get(datasourceId)
    if (!entry) return
    this.entries.delete(datasourceId)
    await entry.adapter.close().catch(() => {})
  }

  async closeAll(): Promise<void> {
    const entries = [...this.entries.values()]
    this.entries.clear()
    await Promise.all(entries.map((entry) => entry.adapter.close().catch(() => {})))
  }

  /** 空闲池回收。unref 掉，免得定时器把进程吊着不退。 */
  startSweeper(): void {
    if (this.sweeper) return
    this.sweeper = setInterval(() => void this.sweepIdle(), 60_000)
    this.sweeper.unref()
  }

  stopSweeper(): void {
    if (!this.sweeper) return
    clearInterval(this.sweeper)
    this.sweeper = undefined
  }

  private async sweepIdle(): Promise<void> {
    const idleMs = this.options.idleEvictMinutes * 60_000
    const now = this.now()
    const stale = [...this.entries.entries()]
      .filter(([, entry]) => now - entry.lastUsedAt > idleMs)
      .map(([id]) => id)
    for (const id of stale) {
      await this.evict(id)
    }
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now()
  }
}

/**
 * 指纹里带密文：口令一改，密文必变，池就会自动重建。
 * 密文含随机 IV，所以「同一个口令重新加密」也会导致重建——偏保守，但不会拿旧口令继续连。
 */
function signatureOf(row: DatasourceRow): string {
  return [
    row.engine,
    row.host,
    String(row.port),
    row.databaseName,
    row.username,
    row.passwordCiphertext,
    JSON.stringify(row.connectOptions ?? {}),
    String(row.enabled),
  ].join('|')
}
