<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'

import type { Datasource, DatasourceCreate } from '@dblab/shared'

import { createDatasource, listDatasources } from '@/api'
import DataTable from '@/components/common/DataTable.vue'
import PageHeader from '@/components/common/PageHeader.vue'
import StatusBadge from '@/components/common/StatusBadge.vue'
import TableToolbar from '@/components/common/TableToolbar.vue'
import type { TableColumn } from '@/components/common/types'
import DatasourceForm from '@/components/domain/DatasourceForm.vue'
import { Button } from '@/components/ui/button'
import { useAsyncList } from '@/composables/useAsyncList'
import { useMutation } from '@/composables/useMutation'
import { formatRelative } from '@/utils/date'
import { engineLabel } from '@/utils/labels'

const router = useRouter()
const list = useAsyncList<Datasource>({
  fetcher: async ({ page, pageSize }) => {
    // 数据源数量是人工维护的量级，接口不分页：一次取回后本地切页。
    const all = await listDatasources()
    return { items: all.slice((page - 1) * pageSize, page * pageSize), total: all.length }
  },
  pageSize: 20,
})

const createOpen = ref(false)

const columns = computed<TableColumn<Datasource>[]>(() => [
  { key: 'name', label: '名称' },
  { key: 'engine', label: '引擎', formatter: (row) => engineLabel(row.engine) },
  { key: 'target', label: '地址', mono: true, formatter: (row) => `${row.host}:${row.port}/${row.database}` },
  { key: 'grantedKeyCount', label: '已授权密钥', align: 'right', mono: true },
  { key: 'lastTestAt', label: '上次测试' },
])

const create = useMutation(createDatasource, {
  successMessage: '已创建数据源',
  failureAction: '创建数据源',
  onSuccess: () => {
    createOpen.value = false
    void list.refresh()
  },
})

function onCreate(input: DatasourceCreate): void {
  void create.run(input)
}
</script>

<template>
  <PageHeader title="数据源" description="接入被纳管的数据库；Agent 只能通过密钥访问这里已授权的库。" />

  <TableToolbar>
    <span class="text-muted-foreground">共 {{ list.total.value }} 个数据源</span>
    <template #actions>
      <Button size="sm" @click="createOpen = true">新建数据源</Button>
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
    empty-title="还没有数据源"
    empty-description="先接入一个 PostgreSQL 或 MySQL，再签发密钥给 Agent。"
    @retry="list.refresh()"
    @update:page="list.setPage($event)"
    @row-click="router.push({ name: 'datasource-detail', params: { id: $event.id } })"
  >
    <template #cell-engine="{ row }">
      <StatusBadge :label="engineLabel(row.engine)" tone="neutral" mono />
    </template>

    <template #cell-lastTestAt="{ row }">
      <div class="flex items-center justify-end gap-2">
        <StatusBadge v-if="row.lastTestOk === true" label="正常" tone="ok" />
        <StatusBadge v-else-if="row.lastTestOk === false" label="异常" tone="danger" />
        <span class="hint">{{ formatRelative(row.lastTestAt) }}</span>
      </div>
    </template>

    <template #row-actions="{ row }">
      <Button
        variant="ghost"
        size="sm"
        @click="router.push({ name: 'datasource-detail', params: { id: row.id } })"
      >
        详情
      </Button>
    </template>
  </DataTable>

  <DatasourceForm v-model:open="createOpen" mode="create" :pending="create.pending.value" @create="onCreate" />
</template>
