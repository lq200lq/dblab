/**
 * API 接口签名的唯一定义处。页面只认这里的名字与形状，
 * 换实现（HTTP / 将来的其它通道）时页面一行都不用改。
 */
import type {
  AdminUser,
  ApiKey,
  ApiKeyCreate,
  ApiKeyCreated,
  ApiKeyDetail,
  ApiKeyGrantsUpdate,
  ApiKeyUpdate,
  AuditLogPage,
  AuditLogQuery,
  Datasource,
  DatasourceCreate,
  DatasourceProbe,
  DatasourceTestResult,
  DatasourceUpdate,
  LoginRequest,
} from '@dblab/shared'

export interface ApiImpl {
  // 会话
  login(input: LoginRequest): Promise<AdminUser>
  logout(): Promise<void>
  getSession(): Promise<AdminUser>

  // 数据源
  listDatasources(): Promise<Datasource[]>
  getDatasource(id: number): Promise<Datasource>
  createDatasource(input: DatasourceCreate): Promise<Datasource>
  updateDatasource(id: number, input: DatasourceUpdate): Promise<Datasource>
  deleteDatasource(id: number): Promise<void>
  testDatasource(id: number): Promise<DatasourceTestResult>
  /** 探测未保存的配置（新建表单里的「测试连接」）。 */
  probeDatasource(input: DatasourceProbe): Promise<DatasourceTestResult>

  // API 密钥
  listApiKeys(): Promise<ApiKey[]>
  getApiKey(id: number): Promise<ApiKeyDetail>
  createApiKey(input: ApiKeyCreate): Promise<ApiKeyCreated>
  updateApiKey(id: number, input: ApiKeyUpdate): Promise<ApiKeyDetail>
  replaceApiKeyGrants(id: number, input: ApiKeyGrantsUpdate): Promise<ApiKeyDetail>
  revokeApiKey(id: number): Promise<void>

  // 审计
  listAuditLogs(query: AuditLogQuery): Promise<AuditLogPage>
}
