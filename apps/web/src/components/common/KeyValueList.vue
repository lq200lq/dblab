<script setup lang="ts">
/**
 * 只读详情字段：抽屉与详情页共用同一套键值排版。
 * 字段类型见 ./types.ts（`<script setup>` 不导出类型）。
 */
import type { KeyValueItem } from './types'

defineProps<{
  items: KeyValueItem[]
  /** 1 = 单列（抽屉），2 = 宽屏两列（详情卡片）。 */
  columns?: 1 | 2
}>()
</script>

<template>
  <dl :class="columns === 2 ? 'grid gap-x-8 md:grid-cols-2' : ''">
    <div v-for="item in items" :key="item.label" class="kv-row">
      <dt class="kv-label">{{ item.label }}</dt>
      <dd class="kv-value" :class="item.mono ? 'mono' : ''">{{ item.value }}</dd>
    </div>
  </dl>
</template>
