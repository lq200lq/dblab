<script setup lang="ts">
/** 应用外壳：左侧导航 + 顶栏（当前管理员 / 登出）。 */
import { computed } from 'vue'
import { RouterLink, RouterView, useRouter } from 'vue-router'

import { Button } from '@/components/ui/button'
import { signOut, useAuth } from '@/stores/auth'

const router = useRouter()
const { user } = useAuth()

const displayName = computed(() => user.value?.displayName || user.value?.username || '')

const NAV = [
  { to: '/datasources', label: '数据源' },
  { to: '/api-keys', label: '密钥' },
  { to: '/audit', label: '审计' },
]

async function onSignOut(): Promise<void> {
  await signOut()
  await router.replace({ name: 'login' })
}
</script>

<template>
  <div class="flex min-h-screen bg-canvas">
    <aside class="flex w-52 shrink-0 flex-col border-r border-line bg-surface">
      <div class="px-4 py-4">
        <p class="text-sm font-semibold text-ink">DbLab</p>
        <p class="hint">数据库 MCP 管控台</p>
      </div>

      <nav class="flex flex-col gap-0.5 px-2">
        <RouterLink
          v-for="item in NAV"
          :key="item.to"
          :to="item.to"
          class="rounded-md px-3 py-2 text-sm text-ink transition-colors hover:bg-muted"
          active-class="bg-accent text-accent-foreground font-medium"
        >
          {{ item.label }}
        </RouterLink>
      </nav>
    </aside>

    <div class="flex min-w-0 flex-1 flex-col">
      <header class="flex h-14 shrink-0 items-center justify-end gap-3 border-b border-line bg-surface px-4 md:px-8">
        <span class="text-sm text-ink">{{ displayName }}</span>
        <Button variant="outline" size="sm" @click="onSignOut">登出</Button>
      </header>

      <main class="page-main">
        <RouterView />
      </main>
    </div>
  </div>
</template>
