<script setup lang="ts">
/** 页面开口：所有页面都用它，标题区高度才一致。 */
defineProps<{
  title: string
  description?: string
}>()
</script>

<template>
  <header class="flex items-start justify-between gap-4">
    <div class="min-w-0 space-y-1">
      <h1 class="text-base font-semibold text-ink">{{ title }}</h1>
      <p v-if="description" class="hint">{{ description }}</p>
    </div>
    <div class="flex shrink-0 items-center gap-2">
      <slot name="actions" />
    </div>
  </header>
</template>
