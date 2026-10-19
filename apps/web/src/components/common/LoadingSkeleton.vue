<script setup lang="ts">
/** 加载态：骨架行数与目标表格的密度一致，避免加载完成时页面高度跳一下。 */
withDefaults(defineProps<{ rows?: number }>(), { rows: 5 })
</script>

<template>
  <div class="space-y-2 p-3">
    <div v-for="index in rows" :key="index" class="h-8 animate-pulse rounded-md bg-muted" />
  </div>
</template>
