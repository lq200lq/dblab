import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'

import { setUnauthorizedHandler } from '@/api'
import { bootstrapSession, clearSession } from '@/stores/auth'

import AppShell from '@/layouts/AppShell.vue'

const routes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'login',
    component: () => import('@/views/LoginView.vue'),
    meta: { public: true, layout: false },
  },
  {
    path: '/',
    component: AppShell,
    children: [
      { path: '', redirect: '/datasources' },
      {
        path: 'datasources',
        name: 'datasources',
        component: () => import('@/views/DatasourceListView.vue'),
      },
      {
        path: 'datasources/:id',
        name: 'datasource-detail',
        component: () => import('@/views/DatasourceDetailView.vue'),
      },
      { path: 'api-keys', name: 'api-keys', component: () => import('@/views/ApiKeyListView.vue') },
      {
        path: 'api-keys/:id',
        name: 'api-key-detail',
        component: () => import('@/views/ApiKeyDetailView.vue'),
      },
      { path: 'audit', name: 'audit', component: () => import('@/views/AuditLogView.vue') },
    ],
  },
  { path: '/:pathMatch(.*)*', name: 'not-found', component: () => import('@/views/NotFoundView.vue') },
]

export const router = createRouter({
  history: createWebHistory(),
  routes,
})

let redirecting = false

/** 会话失效时的统一动作：清状态 → 回登录页，并记住原来要去哪。 */
setUnauthorizedHandler(() => {
  clearSession()
  if (redirecting || router.currentRoute.value.name === 'login') return
  redirecting = true
  void router
    .replace({ name: 'login', query: { redirect: router.currentRoute.value.fullPath } })
    .finally(() => {
      redirecting = false
    })
})

router.beforeEach(async (to) => {
  if (to.meta.public === true) return true

  // 首次进入先问一次会话；之后全靠内存里的状态，不再每跳一次问一次。
  const user = await bootstrapSession()
  if (user) return true

  return { name: 'login', query: to.fullPath === '/' ? {} : { redirect: to.fullPath } }
})

router.afterEach((to) => {
  document.title = to.name ? `DbLab · ${String(to.name)}` : 'DbLab'
})
