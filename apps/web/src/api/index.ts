/**
 * API 层入口。页面从这里具名导入，看不到 fetch、路径与错误码；
 * 实现体在 impl-http.ts，签名契约在 types.ts。
 */
import { api } from './impl-http'

export { ApiError, errorCodeOf, errorMessage, http, setUnauthorizedHandler } from './http'
export type { ApiImpl } from './types'

export const login = api.login
export const logout = api.logout
export const getSession = api.getSession

export const listDatasources = api.listDatasources
export const getDatasource = api.getDatasource
export const createDatasource = api.createDatasource
export const updateDatasource = api.updateDatasource
export const deleteDatasource = api.deleteDatasource
export const testDatasource = api.testDatasource
export const probeDatasource = api.probeDatasource

export const listApiKeys = api.listApiKeys
export const getApiKey = api.getApiKey
export const createApiKey = api.createApiKey
export const updateApiKey = api.updateApiKey
export const replaceApiKeyGrants = api.replaceApiKeyGrants
export const revokeApiKey = api.revokeApiKey

export const listAuditLogs = api.listAuditLogs
