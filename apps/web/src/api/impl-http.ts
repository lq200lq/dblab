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

import { http } from './http'
import type { ApiImpl } from './types'

/** 服务端返回的形状见 apps/server/src/routes/*：列表一律包一层 items。 */
interface Items<T> {
  items: T[]
}

export const api: ApiImpl = {
  async login(input: LoginRequest): Promise<AdminUser> {
    const { user } = await http.post<{ user: AdminUser }>('/auth/login', input)
    return user
  },

  async logout(): Promise<void> {
    await http.post<void>('/auth/logout')
  },

  async getSession(): Promise<AdminUser> {
    const { user } = await http.get<{ user: AdminUser }>('/auth/session')
    return user
  },

  async listDatasources(): Promise<Datasource[]> {
    return (await http.get<Items<Datasource>>('/datasources')).items
  },

  getDatasource(id: number): Promise<Datasource> {
    return http.get<Datasource>(`/datasources/${id}`)
  },

  createDatasource(input: DatasourceCreate): Promise<Datasource> {
    return http.post<Datasource>('/datasources', input)
  },

  updateDatasource(id: number, input: DatasourceUpdate): Promise<Datasource> {
    return http.patch<Datasource>(`/datasources/${id}`, input)
  },

  async deleteDatasource(id: number): Promise<void> {
    await http.delete<void>(`/datasources/${id}`)
  },

  testDatasource(id: number): Promise<DatasourceTestResult> {
    return http.post<DatasourceTestResult>(`/datasources/${id}/test`)
  },

  probeDatasource(input: DatasourceProbe): Promise<DatasourceTestResult> {
    return http.post<DatasourceTestResult>('/datasources/test', input)
  },

  async listApiKeys(): Promise<ApiKey[]> {
    return (await http.get<Items<ApiKey>>('/api-keys')).items
  },

  getApiKey(id: number): Promise<ApiKeyDetail> {
    return http.get<ApiKeyDetail>(`/api-keys/${id}`)
  },

  createApiKey(input: ApiKeyCreate): Promise<ApiKeyCreated> {
    return http.post<ApiKeyCreated>('/api-keys', input)
  },

  updateApiKey(id: number, input: ApiKeyUpdate): Promise<ApiKeyDetail> {
    return http.patch<ApiKeyDetail>(`/api-keys/${id}`, input)
  },

  replaceApiKeyGrants(id: number, input: ApiKeyGrantsUpdate): Promise<ApiKeyDetail> {
    return http.put<ApiKeyDetail>(`/api-keys/${id}/grants`, input)
  },

  async revokeApiKey(id: number): Promise<void> {
    await http.delete<void>(`/api-keys/${id}`)
  },

  listAuditLogs(query: AuditLogQuery): Promise<AuditLogPage> {
    return http.get<AuditLogPage>('/audit-logs', query as Record<string, unknown>)
  },
}
