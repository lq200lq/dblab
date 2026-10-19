import type { DatasourceTestResult, Engine } from '@dblab/shared'

import type { ResolvedDriverConfig } from '../driver-config'

import { MysqlAdapter, testMysqlConnection } from './mysql'
import { PostgresAdapter, testPostgresConnection } from './postgres'
import type { DriverAdapter } from './types'

type ConnectionTester = (config: ResolvedDriverConfig) => Promise<DatasourceTestResult>
type AdapterFactory = (config: ResolvedDriverConfig, poolMax: number) => DriverAdapter

const CONNECTION_TESTERS: Record<Engine, ConnectionTester> = {
  postgres: testPostgresConnection,
  mysql: testMysqlConnection,
}

const ADAPTER_FACTORIES: Record<Engine, AdapterFactory> = {
  postgres: (config, poolMax) => new PostgresAdapter(config, poolMax),
  mysql: (config, poolMax) => new MysqlAdapter(config, poolMax),
}

/** 管理面「测试连接」用：一次性连接，不碰操作池。 */
export function connectionTesterFor(engine: Engine): ConnectionTester {
  return CONNECTION_TESTERS[engine]
}

/** 查询与内省用：带池的常驻适配器。加引擎只需要在上面两张表各登记一行。 */
export function adapterFactoryFor(engine: Engine): AdapterFactory {
  return ADAPTER_FACTORIES[engine]
}

export const SUPPORTED_ENGINES = Object.keys(ADAPTER_FACTORIES) as Engine[]
