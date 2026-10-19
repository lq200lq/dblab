<script setup lang="ts">
/** 时间范围过滤。用原生的 date 输入，不引日历组件（首版够用且没有额外依赖）。 */
defineProps<{ label: string }>()

const from = defineModel<string | undefined>('from', { default: undefined })
const to = defineModel<string | undefined>('to', { default: undefined })
</script>

<template>
  <div class="flex flex-col gap-1">
    <span class="text-xs text-muted-foreground">{{ label }}</span>
    <div class="flex items-center gap-1">
      <input v-model="from" type="date" class="input" style="width: 9.5rem" />
      <span class="text-xs text-muted-foreground">至</span>
      <input v-model="to" type="date" class="input" style="width: 9.5rem" />
    </div>
  </div>
</template>
