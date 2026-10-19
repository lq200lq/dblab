<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import type { ApiKeyDetail, Datasource, DatasourceTestResult, DatasourceUpdate } from '@dblab/shared'

import {
  deleteDatasource,
  getApiKey,
  getDatasource,
  listApiKeys,
  testDatasource,
  updateDatasource,
} from '@/api'
import { errorMessage } from '@/api/http'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import ErrorState from '@/components/common/ErrorState.vue'
import KeyValueList from '@/components/common/KeyValueList.vue'
import LoadingSkeleton from '@/components/common/LoadingSkeleton.vue'
import PageHeader from '@/components/common/PageHeader.vue'
import StatusBadge from '@/components/common/StatusBadge.vue'
import type { KeyValueItem } from '@/components/common/types'
import DatasourceForm from '@/components/domain/DatasourceForm.vue'
import TestResultPanel from '@/components/domain/TestResultPanel.vue'
import { Button } from '@/components/ui/button'
import { useConfirm } from '@/composables/useConfirm'
import { useMutation } from '@/composables/useMutation'
import { formatDateTime } from '@/utils/date'
import { engineLabel } from '@/utils/labels'
import { notifyFailure, notifySuccess } from '@/utils/notify'

const route = useRoute()
const router = useRouter()
const id = Number(route.params.id)

const datasource = ref<Datasource | null>(null)
const loading = ref(true)
const loadError = ref<string | null>(null)

const editOpen = ref(false)
const testResult = ref<DatasourceTestResult | null>(null)
const confirmingDelete = ref(false)

/** 该库上的授权清单。v1 的密钥量级是「几十把以内」，逐把取详情可接受。 */
const grants = ref<Array<{ id: number; name: string; prefix: string; canRead: boolean; canWrite: boolean }>>([])

const {
  open: confirmOpen,
  options: confirmOptions,
  confirm: askConfirm,
  resolve: settleConfirm,
} = useConfirm()

async function load(): Promise<void> {
  loading.value = true
  loadError.value = null
  try {
    const [row, keys] = await Promise.all([getDatasource(id), listApiKeys()])
    datasource.value = row
    const details = await Promise.all(keys.map((key) => getApiKey(key.id)))
    grants.value = details
      .map((detail: ApiKeyDetail) => {
        const grant = detail.grants.find((entry) => entry.datasourceId === id)
        return grant
          ? {
              id: detail.id,
              name: detail.name,
              prefix: detail.prefix,
              canRead: grant.canRead,
              canWrite: grant.canWrite,
            }
          : null
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
  } catch (error) {
    loadError.value = errorMessage(error)
    datasource.value = null
  } finally {
    loading.value = false
  }
}

const items = computed<KeyValueItem[]>(() => {
  const row = datasource.value
  if (!row) return []
  return [
    { label: '引擎', value: engineLabel(row.engine), mono: true },
    { label: '地址', value: `${row.host}:${row.port}/${row.database}`, mono: true },
    { label: '账号', value: row.username, mono: true },
    { label: '口令', value: row.passwordConfigured ? '已配置' : '未配置' },
    { label: 'TLS', value: row.connectOptions.ssl ? (row.connectOptions.sslVerify === false ? '开启（不校验证书）' : '开启（校验证书）') : '关闭' },
    { label: '状态', value: row.enabled ? '启用' : '停用' },
    { label: '上次测试', value: row.lastTestAt ? formatDateTime(row.lastTestAt) : '未测试' },
    { label: '创建时间', value: formatDateTime(row.createdAt) },
  ]
})

const update = useMutation(updateDatasource, {
  successMessage: '已保存数据源',
  failureAction: '保存数据源',
  onSuccess: async () => {
    editOpen.value = false
    await load()
  },
})

const tester = useMutation(testDatasource, { failureAction: '测试连接' })

async function onTest(): Promise<void> {
  const result = await tester.run(id)
  if (result) {
    testResult.value = result
    // 测试结果落库在 last_test_*，列表与详情都要跟着刷新才不打架。
    await load()
  }
}

async function onUpdate(input: DatasourceUpdate): Promise<void> {
  await update.run(id, input)
}

async function onDelete(): Promise<void> {
  const row = datasource.value
  if (!row) return
  const accepted = await askConfirm({
    title: '删除数据源',
    description: '该库上的所有授权会一并撤销，正在使用这些密钥的 Agent 立刻失效。',
    confirmLabel: '删除',
    danger: true,
    requiredText: row.name,
  })
  if (!accepted) return

  confirmingDelete.value = true
  try {
    await deleteDatasource(id)
    notifySuccess('已删除数据源')
    await router.push({ name: 'datasources' })
  } catch (error) {
    notifyFailure('删除数据源', error)
  } finally {
    confirmingDelete.value = false
  }
}

watch(() => route.params.id, load)
void load()
</script>

<template>
  <LoadingSkeleton v-if="loading" :rows="6" />
  <ErrorState v-else-if="loadError || !datasource" :message="loadError ?? '数据源不存在'" @retry="load" />

  <template v-else>
    <PageHeader :title="datasource.name" :description="`${engineLabel(datasource.engine)} · ${datasource.host}:${datasource.port}/${datasource.database}`">
      <template #actions>
        <Button variant="outline" size="sm" :disabled="tester.pending.value" @click="onTest">
          {{ tester.pending.value ? '测试中…' : '测试连接' }}
        </Button>
        <Button variant="outline" size="sm" @click="editOpen = true">编辑</Button>
        <Button variant="destructive" size="sm" @click="onDelete">删除</Button>
      </template>
    </PageHeader>

    <div class="grid gap-5 lg:grid-cols-2">
      <section class="card-pad space-y-3">
        <h2 class="section-title">连接配置</h2>
        <KeyValueList :items="items" />
      </section>

      <section class="space-y-3">
        <h2 class="section-title">连通性</h2>
        <TestResultPanel v-if="testResult" :result="testResult" />
        <div v-else-if="datasource.lastTestError" class="card-pad space-y-1">
          <StatusBadge label="上次测试失败" tone="danger" />
          <p class="hint">{{ datasource.lastTestError }}</p>
        </div>
        <p v-else class="hint">还没有测试过连接。点上方「测试连接」探一次。</p>
      </section>
    </div>

    <section class="space-y-3">
      <h2 class="section-title">授权到该库的密钥</h2>
      <div v-if="grants.length === 0" class="card-pad">
        <p class="hint">还没有密钥能访问这个库。在密钥详情页的授权矩阵里勾上它。</p>
      </div>
      <div v-else class="card divide-y divide-line">
        <RouterLink
          v-for="entry in grants"
          :key="entry.id"
          :to="{ name: 'api-key-detail', params: { id: entry.id } }"
          class="flex items-center justify-between gap-3 px-3 py-2.5 transition-colors hover:bg-muted"
        >
          <div class="min-w-0">
            <p class="truncate text-sm text-ink">{{ entry.name }}</p>
            <p class="chip mt-1 inline-flex">{{ entry.prefix }}</p>
          </div>
          <div class="flex shrink-0 gap-1.5">
            <StatusBadge v-if="entry.canRead" label="读" tone="accent" />
            <StatusBadge v-if="entry.canWrite" label="写" tone="warn" />
          </div>
        </RouterLink>
      </div>
    </section>

    <DatasourceForm
      v-model:open="editOpen"
      mode="update"
      :datasource="datasource"
      :pending="update.pending.value"
      @update="onUpdate"
    />

    <ConfirmDialog
      v-model:open="confirmOpen"
      v-bind="confirmOptions"
      :pending="confirmingDelete"
      @confirm="settleConfirm(true)"
      @cancel="settleConfirm(false)"
    />
  </template>
</template>
