<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'

import type { ApiKey, ApiKeyCreate, Datasource } from '@dblab/shared'

import { createApiKey, listApiKeys, listDatasources } from '@/api'
import CopyButton from '@/components/common/CopyButton.vue'
import DataTable from '@/components/common/DataTable.vue'
import PageHeader from '@/components/common/PageHeader.vue'
import SecretReveal from '@/components/common/SecretReveal.vue'
import StatusBadge from '@/components/common/StatusBadge.vue'
import TableToolbar from '@/components/common/TableToolbar.vue'
import type { TableColumn } from '@/components/common/types'
import ApiKeyForm from '@/components/domain/ApiKeyForm.vue'
import { Button } from '@/components/ui/button'
import { useAsyncList } from '@/composables/useAsyncList'
import { useMutation } from '@/composables/useMutation'
import { formatRelative, toDateInputValue } from '@/utils/date'
import { apiKeyStatusLabel, apiKeyStatusTone } from '@/utils/labels'

const router = useRouter()
const list = useAsyncList<ApiKey>({
  fetcher: async ({ page, pageSize }) => {
    const all = await listApiKeys()
    return { items: all.slice((page - 1) * pageSize, page * pageSize), total: all.length }
  },
  pageSize: 20,
})

/** 授权矩阵要的数据源清单：建一次取一份即可（数量是人工维护的量级）。 */
const datasources = ref<Datasource[]>([])

onMounted(async () => {
  datasources.value = await listDatasources().catch(() => [])
})

const createOpen = ref(false)
const revealOpen = ref(false)
/** 明文只活在这一个 ref 里，关闭即清空。 */
const plaintext = ref('')

const columns = computed<TableColumn<ApiKey>[]>(() => [
  { key: 'name', label: '名称' },
  { key: 'prefix', label: '前缀' },
  { key: 'status', label: '状态' },
  { key: 'expiresAt', label: '有效期' },
  { key: 'datasourceCount', label: '数据源', align: 'right', mono: true },
  { key: 'lastUsedAt', label: '最近使用' },
])

const create = useMutation(createApiKey, {
  failureAction: '创建密钥',
  onSuccess: (result) => {
    createOpen.value = false
    plaintext.value = result.plaintextKey
    revealOpen.value = true
    void list.refresh()
  },
})

function onCreate(input: ApiKeyCreate): void {
  void create.run(input)
}

function onClosed(): void {
  plaintext.value = ''
}

/** 已过期的密钥在列表上要看得出来：Agent 那边只会得到 401，界面上先给出原因。 */
function isExpired(row: ApiKey): boolean {
  return row.status === 'active' && row.expiresAt !== null && Date.parse(row.expiresAt) <= Date.now()
}
</script>

<template>
  <PageHeader title="密钥" description="发给 Agent 的凭据。每把密钥只能访问它被授权的数据源，且只有授权允许的读写。" />

  <TableToolbar>
    <span class="text-muted-foreground">共 {{ list.total.value }} 把密钥</span>
    <template #actions>
      <Button size="sm" @click="createOpen = true">新建密钥</Button>
    </template>
  </TableToolbar>

  <DataTable
    :columns="columns"
    :rows="list.items.value"
    :loading="list.loading.value"
    :error="list.error.value"
    :page="list.page.value"
    :page-size="list.pageSize.value"
    :total="list.total.value"
    row-clickable
    empty-title="还没有密钥"
    empty-description="新建一把密钥，把它配到 Agent 的 MCP 客户端里。"
    @retry="list.refresh()"
    @update:page="list.setPage($event)"
    @row-click="router.push({ name: 'api-key-detail', params: { id: $event.id } })"
  >
    <template #cell-prefix="{ row }">
      <span class="inline-flex items-center gap-1">
        <span class="chip">{{ row.prefix }}</span>
        <CopyButton :text="row.prefix" label="复制前缀（不是完整密钥）" />
      </span>
    </template>

    <template #cell-status="{ row }">
      <StatusBadge
        :label="isExpired(row) ? '已过期' : apiKeyStatusLabel(row.status)"
        :tone="isExpired(row) ? 'warn' : apiKeyStatusTone(row.status)"
      />
    </template>

    <template #cell-expiresAt="{ row }">
      <span :class="row.expiresAt ? '' : 'hint'">
        {{ row.expiresAt ? toDateInputValue(row.expiresAt) : '永不过期' }}
      </span>
    </template>

    <template #cell-lastUsedAt="{ row }">
      <span class="hint">{{ formatRelative(row.lastUsedAt) }}</span>
    </template>

    <template #row-actions="{ row }">
      <Button variant="ghost" size="sm" @click="router.push({ name: 'api-key-detail', params: { id: row.id } })">
        详情
      </Button>
    </template>
  </DataTable>

  <ApiKeyForm
    v-model:open="createOpen"
    :datasources="datasources"
    :pending="create.pending.value"
    @submit="onCreate"
  />

  <SecretReveal
    v-model:open="revealOpen"
    :secret="plaintext"
    @closed="onClosed"
  />
</template>
