<script setup lang="ts">
/** 空态：说明「这里为什么是空的」，必要时给一个开始动作。 */
defineProps<{
  title: string
  description?: string
}>()
</script>

<template>
  <div class="flex flex-col items-center gap-2 px-4 py-10 text-center">
    <p class="text-sm font-medium text-ink">{{ title }}</p>
    <p v-if="description" class="hint max-w-md">{{ description }}</p>
    <div class="pt-1">
      <slot />
    </div>
  </div>
</template>
