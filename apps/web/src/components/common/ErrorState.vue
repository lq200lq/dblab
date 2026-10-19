<script setup lang="ts">
/** 错误态：把原因写出来，并给一个重试入口——只说「加载失败」等于让人干等。 */
import { Button } from '@/components/ui/button'

defineProps<{
  message: string
  retryLabel?: string
}>()

const emit = defineEmits<{ retry: [] }>()
</script>

<template>
  <div class="flex flex-col items-center gap-3 px-4 py-10 text-center">
    <p class="text-sm font-medium text-danger">{{ message }}</p>
    <Button variant="outline" size="sm" @click="emit('retry')">
      {{ retryLabel ?? '重试' }}
    </Button>
  </div>
</template>
