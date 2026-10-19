<script setup lang="ts">
/**
 * 授权矩阵：数据源行 × 读/写开关。
 * 「一行」（两个开关都关）等于不给这个数据源授权——服务端契约也是这么定义的。
 */
import { computed } from 'vue'

import type { Datasource } from '@dblab/shared'

import EmptyState from '@/components/common/EmptyState.vue'
import { Switch } from '@/components/ui/switch'
import { engineLabel } from '@/utils/labels'

import type { GrantRow } from './types'

const props = defineProps<{
  datasources: Datasource[]
  disabled?: boolean
}>()

/** 只保留「至少给了一项」的行，服务端契约不接受全关的授权。 */
const model = defineModel<GrantRow[]>({ default: () => [] })

const byId = computed(() => new Map(model.value.map((row) => [row.datasourceId, row])))

function stateOf(id: number): GrantRow {
  return byId.value.get(id) ?? { datasourceId: id, canRead: false, canWrite: false }
}

function patch(id: number, change: Partial<Pick<GrantRow, 'canRead' | 'canWrite'>>): void {
  const current = stateOf(id)
  const next = { ...current, ...change }
  const others = model.value.filter((row) => row.datasourceId !== id)
  model.value = next.canRead || next.canWrite ? [...others, next] : others
}
</script>

<template>
  <EmptyState
    v-if="datasources.length === 0"
    title="还没有数据源"
    description="先在数据源页面接入一个库，再回来授权。"
  />

  <div v-else class="card overflow-hidden">
    <div class="grid grid-cols-[1fr_4rem_4rem] items-center gap-2 border-b border-line px-3 py-2 text-xs text-muted-foreground">
      <span>数据源</span>
      <span class="text-center">读</span>
      <span class="text-center">写</span>
    </div>

    <div
      v-for="datasource in datasources"
      :key="datasource.id"
      class="grid grid-cols-[1fr_4rem_4rem] items-center gap-2 border-b border-line px-3 py-2 last:border-b-0"
    >
      <div class="min-w-0">
        <p class="truncate text-sm text-ink">{{ datasource.name }}</p>
        <p class="hint truncate">{{ engineLabel(datasource.engine) }} · {{ datasource.database }}</p>
      </div>

      <div class="flex justify-center">
        <Switch
          size="sm"
          :model-value="stateOf(datasource.id).canRead"
          :disabled="disabled"
          @update:model-value="(value: boolean) => patch(datasource.id, { canRead: value })"
        />
      </div>
      <div class="flex justify-center">
        <Switch
          size="sm"
          :model-value="stateOf(datasource.id).canWrite"
          :disabled="disabled"
          @update:model-value="(value: boolean) => patch(datasource.id, { canWrite: value })"
        />
      </div>
    </div>
  </div>
</template>
