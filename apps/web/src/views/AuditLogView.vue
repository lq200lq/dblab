<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import type { ApiKey, AuditLog, AuditLogQuery, Datasource } from '@dblab/shared'
import {
  AUDIT_ACTION_LABEL,
  AUDIT_ACTIONS,
  AUDIT_DECISION_LABEL,
  AUDIT_DECISIONS,
  SQL_CLASS_LABEL,
  SQL_CLASSES,
} from '@dblab/shared'

import { listApiKeys, listAuditLogs, listDatasources } from '@/api'
import DataTable from '@/components/common/DataTable.vue'
import DetailDrawer from '@/components/common/DetailDrawer.vue'
import FilterBar from '@/components/common/FilterBar.vue'
import FilterDateRange from '@/components/common/FilterDateRange.vue'
import FilterSelect from '@/components/common/FilterSelect.vue'
import KeyValueList from '@/components/common/KeyValueList.vue'
import PageHeader from '@/components/common/PageHeader.vue'
import StatusBadge from '@/components/common/StatusBadge.vue'
import type { KeyValueItem, TableColumn } from '@/components/common/types'
import { Button } from '@/components/ui/button'
import { useAsyncList } from '@/composables/useAsyncList'
import { formatClock, formatDateTime, formatDuration } from '@/utils/date'
import {
  actorKindLabel,
  auditActionLabel,
  decisionLabel,
  decisionTone,
  sqlClassLabel,
  sqlClassTone,
} from '@/utils/labels'

interface Filters {
  apiKeyId?: string
  datasourceId?: string
  decision?: string
  classification?: string
  action?: string
  from?: string
  to?: string
}

const filters = reactive<Filters>({})
const keys = ref<ApiKey[]>([])
const datasources = ref<Datasource[]>([])

const list = useAsyncList<AuditLog>({
  fetcher: (query) => listAuditLogs(buildQuery(query.page, query.pageSize)),
  pageSize: 50,
  filters: () => ({ ...filters }),
})

const selected = ref<AuditLog | null>(null)

/** 抽屉的开关用可写 computed 桥到 selected：关掉抽屉就是把选中清空。 */
const drawerOpen = computed({
  get: () => selected.value !== null,
  set: (value: boolean) => {
    if (!value) selected.value = null
  },
})

const columns: TableColumn<AuditLog>[] = [
  { key: 'createdAt', label: '时间', mono: true, width: '11rem' },
  { key: 'actorKind', label: '调用方', width: '6rem' },
  { key: 'actorName', label: '身份' },
  { key: 'datasourceName', label: '数据源' },
  { key: 'action', label: '动作' },
  { key: 'sqlText', label: '语句', mono: true },
  { key: 'decision', label: '判定', width: '5rem' },
  { key: 'rowCount', label: '行数', align: 'right', width: '4rem' },
  { key: 'durationMs', label: '耗时', align: 'right', width: '6rem' },
]

/** 空值不渲染成「—」占行：一次放行的调用没必要带三行无效字段。 */
function kv(rows: Array<[string, string | null | undefined, boolean?]>): KeyValueItem[] {
  return rows
    .map(([label, value, mono]) => ({ label, value: (value ?? '').trim(), mono: mono ?? false }))
    .filter((row) => row.value.length > 0 && row.value !== '—')
}

const callerItems = computed(() => {
  const row = selected.value
  if (!row) return []
  return kv([
    ['调用方', actorKindLabel(row.actorKind)],
    ['身份', row.actorName],
    ['密钥前缀', row.apiKeyPrefix],
    ['客户端 IP', row.clientIp],
  ])
})

const targetItems = computed(() => {
  const row = selected.value
  if (!row) return []
  return kv([
    ['数据源', row.datasourceName],
    ['引擎', row.engine],
    ['工具', row.toolName, true],
  ])
})

const problemItems = computed(() => {
  const row = selected.value
  if (!row) return []
  return kv([
    ['拒绝原因', row.denialReason],
    ['错误码', row.errorCode],
    ['错误信息', row.errorMessage],
  ])
})

const metricLine = computed(() => {
  const row = selected.value
  if (!row) return ''
  const parts: string[] = []
  if (row.rowCount !== null) parts.push(`行数 ${row.rowCount}`)
  const duration = formatDuration(row.durationMs)
  if (duration !== '—') parts.push(`耗时 ${duration}`)
  return parts.join(' · ')
})

const DECISION_OPTIONS = AUDIT_DECISIONS.map((value) => ({ value, label: AUDIT_DECISION_LABEL[value] }))
const CLASS_OPTIONS = SQL_CLASSES.map((value) => ({ value, label: SQL_CLASS_LABEL[value] }))
const ACTION_OPTIONS = AUDIT_ACTIONS.map((value) => ({ value, label: AUDIT_ACTION_LABEL[value] }))
const KEY_OPTIONS = computed(() => keys.value.map((key) => ({ value: String(key.id), label: key.name })))
const DATASOURCE_OPTIONS = computed(() =>
  datasources.value.map((row) => ({ value: String(row.id), label: row.name })),
)

function buildQuery(page: number, pageSize: number): AuditLogQuery {
  return {
    page,
    pageSize,
    apiKeyId: positiveId(filters.apiKeyId),
    datasourceId: positiveId(filters.datasourceId),
    decision: filters.decision as AuditLogQuery['decision'],
    classification: filters.classification as AuditLogQuery['classification'],
    action: filters.action as AuditLogQuery['action'],
    from: filters.from ? new Date(`${filters.from}T00:00:00`).toISOString() : undefined,
    // 结束日取当天最后一秒：只填日期不填时分的话，「至今天」不该把今天的调用漏掉。
    to: filters.to ? new Date(`${filters.to}T23:59:59`).toISOString() : undefined,
  }
}

function positiveId(value: string | undefined): number | undefined {
  const parsed = Number(value)
  return value && Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

function oneLine(sql: string | null): string {
  if (!sql) return '—'
  const flat = sql.replace(/\s+/g, ' ').trim()
  return flat.length > 72 ? `${flat.slice(0, 72)}…` : flat
}

function resetFilters(): void {
  for (const key of Object.keys(filters)) delete (filters as Record<string, unknown>)[key]
}

onMounted(async () => {
  // 过滤项要显示名字而不是裸 ID，所以顺手把两张清单取回来。
  const [keyRows, sourceRows] = await Promise.all([listApiKeys(), listDatasources()])
  keys.value = keyRows
  datasources.value = sourceRows
})
</script>

<template>
  <PageHeader title="审计" description="每一次调用一行：通过与被拒都在，拒绝写清原因。点任意一行看完整语句。" />

  <FilterBar>
    <FilterSelect v-model="filters.apiKeyId" label="密钥" :options="KEY_OPTIONS" width="11rem" />
    <FilterSelect v-model="filters.datasourceId" label="数据源" :options="DATASOURCE_OPTIONS" width="11rem" />
    <FilterSelect v-model="filters.decision" label="判定" :options="DECISION_OPTIONS" width="7rem" />
    <FilterSelect v-model="filters.classification" label="分类" :options="CLASS_OPTIONS" width="7rem" />
    <FilterSelect v-model="filters.action" label="动作" :options="ACTION_OPTIONS" width="11rem" />
    <FilterDateRange v-model:from="filters.from" v-model:to="filters.to" label="时间范围" />
    <template #actions>
      <Button variant="outline" size="sm" @click="resetFilters">重置</Button>
      <Button variant="outline" size="sm" @click="list.refresh()">刷新</Button>
    </template>
  </FilterBar>

  <DataTable
    :columns="columns"
    :rows="list.items.value"
    :loading="list.loading.value"
    :error="list.error.value"
    :page="list.page.value"
    :page-size="list.pageSize.value"
    :total="list.total.value"
    :skeleton-rows="8"
    row-clickable
    empty-title="没有符合条件的调用"
    empty-description="Agent 还没连上来，或者过滤器太严了。"
    @retry="list.refresh()"
    @update:page="list.setPage($event)"
    @row-click="selected = $event"
  >
    <template #cell-createdAt="{ row }">{{ formatClock(row.createdAt) }}</template>
    <template #cell-actorKind="{ row }">{{ actorKindLabel(row.actorKind) }}</template>
    <template #cell-action="{ row }">{{ auditActionLabel(row.action) }}</template>
    <template #cell-durationMs="{ row }">{{ formatDuration(row.durationMs) }}</template>
    <template #cell-rowCount="{ row }">{{ row.rowCount ?? '—' }}</template>

    <template #cell-sqlText="{ row }">
      <span class="mono text-xs">{{ oneLine(row.sqlText) }}</span>
    </template>

    <template #cell-decision="{ row }">
      <StatusBadge :label="decisionLabel(row.decision)" :tone="decisionTone(row.decision)" />
    </template>
  </DataTable>

  <DetailDrawer
    v-model:open="drawerOpen"
    :title="selected ? auditActionLabel(selected.action) : ''"
    description="单次调用的完整记录"
  >
    <div v-if="selected" class="space-y-4">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex flex-wrap gap-1.5">
          <StatusBadge :label="decisionLabel(selected.decision)" :tone="decisionTone(selected.decision)" />
          <StatusBadge
            v-if="selected.classification"
            :label="sqlClassLabel(selected.classification)"
            :tone="sqlClassTone(selected.classification)"
          />
        </div>
        <div class="text-right">
          <p class="mono text-sm text-ink">{{ formatDateTime(selected.createdAt) }}</p>
          <p v-if="metricLine" class="mono text-xs text-muted-foreground">{{ metricLine }}</p>
        </div>
      </div>

      <div v-if="selected.sqlText">
        <p class="hint mb-1">语句</p>
        <pre
          class="mono max-h-64 overflow-auto rounded-md border border-line bg-muted p-3 text-xs text-ink break-words whitespace-pre-wrap"
        >{{ selected.sqlText }}</pre>
      </div>

      <div v-if="callerItems.length">
        <p class="hint mb-1">调用方</p>
        <KeyValueList :items="callerItems" />
      </div>

      <div v-if="targetItems.length">
        <p class="hint mb-1">目标</p>
        <KeyValueList :items="targetItems" />
      </div>

      <div v-if="problemItems.length">
        <p class="hint mb-1">未通过的原因</p>
        <KeyValueList :items="problemItems" />
      </div>

      <div v-if="selected.detail">
        <p class="hint mb-1">细节</p>
        <pre
          class="mono max-h-40 overflow-auto rounded-md border border-line bg-muted p-3 text-xs text-ink whitespace-pre-wrap"
        >{{ JSON.stringify(selected.detail, null, 2) }}</pre>
      </div>
    </div>
  </DetailDrawer>
</template>
