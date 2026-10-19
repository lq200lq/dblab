<script setup lang="ts">
/** 连通性探测结果。成功说清延迟与版本，失败说清原因码——都不含任何凭据内容。 */
import { computed } from 'vue'

import type { DatasourceTestResult } from '@dblab/shared'

import KeyValueList from '@/components/common/KeyValueList.vue'
import StatusBadge from '@/components/common/StatusBadge.vue'
import type { KeyValueItem } from '@/components/common/types'
import { formatDuration } from '@/utils/date'

const props = defineProps<{
  result: DatasourceTestResult
}>()

const items = computed<KeyValueItem[]>(() => {
  const rows: KeyValueItem[] = [
    { label: '耗时', value: formatDuration(props.result.latencyMs), mono: true },
    { label: '服务端版本', value: props.result.serverVersion ?? '—', mono: true },
  ]
  if (!props.result.ok) {
    rows.push({ label: '错误码', value: props.result.errorCode ?? '未知', mono: true })
    rows.push({ label: '原因', value: props.result.message ?? '—' })
  }
  return rows
})
</script>

<template>
  <div class="card-pad space-y-3">
    <div class="flex items-center gap-2">
      <StatusBadge
        :label="result.ok ? '连接正常' : '连接失败'"
        :tone="result.ok ? 'ok' : 'danger'"
      />
    </div>
    <KeyValueList :items="items" />
  </div>
</template>
