<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import type {
  ApiKeyDetail,
  ApiKeyGrant,
  ApiKeyGrantsUpdate,
  Datasource,
} from '@dblab/shared'

import { getApiKey, listDatasources, replaceApiKeyGrants, revokeApiKey, updateApiKey } from '@/api'
import { errorMessage } from '@/api/http'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import ErrorState from '@/components/common/ErrorState.vue'
import FormField from '@/components/common/FormField.vue'
import KeyValueList from '@/components/common/KeyValueList.vue'
import LoadingSkeleton from '@/components/common/LoadingSkeleton.vue'
import PageHeader from '@/components/common/PageHeader.vue'
import StatusBadge from '@/components/common/StatusBadge.vue'
import type { KeyValueItem } from '@/components/common/types'
import GrantMatrix from '@/components/domain/GrantMatrix.vue'
import IpAllowlistEditor from '@/components/domain/IpAllowlistEditor.vue'
import type { GrantRow } from '@/components/domain/types'
import { Button } from '@/components/ui/button'
import { useConfirm } from '@/composables/useConfirm'
import { useMutation } from '@/composables/useMutation'
import { formatDateTime, formatRelative, toDateInputValue } from '@/utils/date'
import { apiKeyStatusLabel, apiKeyStatusTone } from '@/utils/labels'

const route = useRoute()
const router = useRouter()
const id = Number(route.params.id)

const detail = ref<ApiKeyDetail | null>(null)
const datasources = ref<Datasource[]>([])
const loading = ref(true)
const loadError = ref<string | null>(null)

const expiresAt = ref('')
const ipAllowlist = ref<string[]>([])
const grants = ref<GrantRow[]>([])

const revoking = ref(false)
const { open: confirmOpen, options: confirmOptions, confirm: askConfirm, resolve: settleConfirm } = useConfirm()

async function load(): Promise<void> {
  loading.value = true
  loadError.value = null
  try {
    const [row, sources] = await Promise.all([getApiKey(id), listDatasources()])
    detail.value = row
    datasources.value = sources
    expiresAt.value = toDateInputValue(row.expiresAt)
    ipAllowlist.value = [...row.ipAllowlist]
    grants.value = row.grants.map(toGrantRow)
  } catch (error) {
    loadError.value = errorMessage(error)
    detail.value = null
  } finally {
    loading.value = false
  }
}

const saveExpiry = useMutation(updateApiKey, {
  successMessage: '已更新有效期',
  failureAction: '更新有效期',
  onSuccess: load,
})

const saveAllowlist = useMutation(updateApiKey, {
  successMessage: '已更新 IP 白名单',
  failureAction: '更新 IP 白名单',
  onSuccess: load,
})

const saveGrants = useMutation(replaceApiKeyGrants, {
  successMessage: '已更新授权',
  failureAction: '更新授权',
  onSuccess: load,
})

const saveStatus = useMutation(updateApiKey, { failureAction: '变更密钥状态', onSuccess: load })

const items = computed<KeyValueItem[]>(() => {
  const row = detail.value
  if (!row) return []
  return [
    { label: '前缀', value: row.prefix, mono: true },
    { label: '状态', value: apiKeyStatusLabel(row.status) },
    { label: '有效期', value: row.expiresAt ? formatDateTime(row.expiresAt) : '永不过期' },
    { label: '数据源授权', value: `${row.grants.length} 个` },
    { label: '最近使用', value: row.lastUsedAt ? `${formatRelative(row.lastUsedAt)}（${formatDateTime(row.lastUsedAt)}）` : '从未使用' },
    { label: '创建时间', value: formatDateTime(row.createdAt) },
  ]
})

const isWritable = computed(() => grants.value.some((row) => row.canWrite))

/** 已吊销/已过期的密钥不再接受任何编辑：改授权或改白名单都没有意义了。 */
const locked = computed(() => {
  const row = detail.value
  if (!row) return true
  if (row.status === 'revoked') return true
  return row.expiresAt !== null && Date.parse(row.expiresAt) <= Date.now()
})

function toGrantRow(grant: ApiKeyGrant): GrantRow {
  return { datasourceId: grant.datasourceId, canRead: grant.canRead, canWrite: grant.canWrite }
}

async function onSaveExpiry(): Promise<void> {
  // 空 = 永不过期，必须显式传 null：不传字段服务端不会动它。
  const value = expiresAt.value ? new Date(`${expiresAt.value}T23:59:59`).toISOString() : null
  await saveExpiry.run(id, { expiresAt: value })
}

async function onSaveAllowlist(): Promise<void> {
  await saveAllowlist.run(id, { ipAllowlist: ipAllowlist.value })
}

async function onSaveGrants(): Promise<void> {
  const payload: ApiKeyGrantsUpdate = {
    grants: grants.value.map((row) => ({
      datasourceId: row.datasourceId,
      canRead: row.canRead,
      canWrite: row.canWrite,
    })),
  }
  await saveGrants.run(id, payload)
}

async function onToggleStatus(): Promise<void> {
  const row = detail.value
  if (!row) return
  await saveStatus.run(id, { status: row.status === 'active' ? 'disabled' : 'active' })
}

async function onRevoke(): Promise<void> {
  const row = detail.value
  if (!row) return
  const accepted = await askConfirm({
    title: '吊销密钥',
    description: '吊销后这把密钥立刻失效，且无法恢复。使用它的 Agent 会全部被拒。',
    confirmLabel: '吊销',
    danger: true,
    requiredText: row.name,
  })
  if (!accepted) return

  revoking.value = true
  try {
    await revokeApiKey(id)
    await load()
  } catch (error) {
    loadError.value = errorMessage(error)
  } finally {
    revoking.value = false
  }
}

watch(() => route.params.id, load)
void load()
</script>

<template>
  <LoadingSkeleton v-if="loading" :rows="6" />
  <ErrorState v-else-if="loadError || !detail" :message="loadError ?? '密钥不存在'" @retry="load" />

  <template v-else>
    <PageHeader :title="detail.name" :description="`密钥 ${detail.prefix} · Agent 用 Authorization: Bearer <明文> 访问 /mcp`">
      <template #actions>
        <Button variant="outline" size="sm" @click="router.push({ name: 'api-keys' })">返回列表</Button>
        <Button v-if="detail.status !== 'revoked'" variant="outline" size="sm" :disabled="locked" @click="onToggleStatus">
          {{ detail.status === 'active' ? '停用' : '启用' }}
        </Button>
        <Button v-if="detail.status !== 'revoked'" variant="destructive" size="sm" @click="onRevoke">吊销</Button>
      </template>
    </PageHeader>

    <div class="grid gap-5 lg:grid-cols-2">
      <section class="card-pad space-y-3">
        <h2 class="section-title">概览</h2>
        <KeyValueList :items="items" />
        <div class="flex items-center gap-2">
          <StatusBadge :label="apiKeyStatusLabel(detail.status)" :tone="apiKeyStatusTone(detail.status)" />
          <StatusBadge v-if="isWritable" label="含写授权" tone="warn" />
        </div>
      </section>

      <section class="card-pad space-y-4">
        <h2 class="section-title">有效期与来源限制</h2>

        <FormField label="有效期" hint="留空表示永不过期" html-for="expiry">
          <div class="flex items-end gap-2">
            <input id="expiry" v-model="expiresAt" type="date" class="input min-w-0 flex-1" :disabled="locked" />
            <Button size="sm" :disabled="locked || saveExpiry.pending.value" @click="onSaveExpiry">
              {{ saveExpiry.pending.value ? '保存中…' : '保存' }}
            </Button>
          </div>
        </FormField>

        <FormField label="IP 白名单" hint="留空表示不限制来源">
          <div class="space-y-2">
            <IpAllowlistEditor v-model="ipAllowlist" />
            <Button size="sm" :disabled="locked || saveAllowlist.pending.value" @click="onSaveAllowlist">
              {{ saveAllowlist.pending.value ? '保存中…' : '保存白名单' }}
            </Button>
          </div>
        </FormField>
      </section>
    </div>

    <section class="space-y-3">
      <div class="flex items-center justify-between">
        <h2 class="section-title">授权矩阵</h2>
        <Button
          size="sm"
          :disabled="locked || saveGrants.pending.value"
          @click="onSaveGrants"
        >
          {{ saveGrants.pending.value ? '提交中…' : '提交授权' }}
        </Button>
      </div>
      <p class="hint">
        一次提交整张表：勾掉一项即撤销一项。改完无需 Agent 重连，下一次 tools/list 就会看到变化。
      </p>
      <GrantMatrix v-model="grants" :datasources="datasources" :disabled="locked" />
    </section>

    <ConfirmDialog
      v-model:open="confirmOpen"
      v-bind="confirmOptions"
      :pending="revoking"
      @confirm="settleConfirm(true)"
      @cancel="settleConfirm(false)"
    />
  </template>
</template>
