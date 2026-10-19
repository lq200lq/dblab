<script setup lang="ts">
/** 表格上方的一条：左侧说明/计数，右侧主操作。 */
</script>

<template>
  <div class="flex flex-wrap items-center justify-between gap-3">
    <div class="min-w-0 text-sm text-ink">
      <slot />
    </div>
    <div class="flex shrink-0 items-center gap-2">
      <slot name="actions" />
    </div>
  </div>
</template>
