/**
 * 当前管理员的会话状态。只有一处：路由守卫、顶栏、登录页都读它，
 * 不各自记一份，避免「顶栏还显示着用户名但接口已经 401」。
 */
import { ref } from 'vue'

import type { AdminUser } from '@dblab/shared'

import * as api from '@/api'

const user = ref<AdminUser | null>(null)
const resolved = ref(false)
const pending = ref(false)

export function currentUser(): AdminUser | null {
  return user.value
}

/** 首次进入应用时问一次「我是谁」。失败即视为未登录。 */
export async function bootstrapSession(): Promise<AdminUser | null> {
  if (resolved.value) return user.value
  try {
    user.value = await api.getSession()
  } catch {
    user.value = null
  } finally {
    resolved.value = true
  }
  return user.value
}

export async function signIn(username: string, password: string): Promise<void> {
  pending.value = true
  try {
    user.value = await api.login({ username, password })
    resolved.value = true
  } finally {
    pending.value = false
  }
}

export async function signOut(): Promise<void> {
  try {
    await api.logout()
  } finally {
    user.value = null
    resolved.value = true
  }
}

/** 401 时由 api 层回调：把本地状态清干净，路由守卫会把页面打回登录。 */
export function clearSession(): void {
  user.value = null
  resolved.value = true
}

export function useAuth() {
  return { user, resolved, pending, signIn, signOut }
}
