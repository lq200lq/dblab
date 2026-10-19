<script setup lang="ts">
/** 右侧抽屉外壳：审计详情、数据源摘要、密钥摘要共用。 */
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'

const open = defineModel<boolean>('open', { default: false })

defineProps<{
  title: string
  description?: string
}>()
</script>

<template>
  <Sheet v-model:open="open">
    <SheetContent side="right" class="w-full gap-0 p-0 sm:max-w-xl">
      <SheetHeader class="border-b border-line px-5 py-4">
        <SheetTitle class="text-sm font-semibold">{{ title }}</SheetTitle>
        <SheetDescription v-if="description" class="hint">{{ description }}</SheetDescription>
      </SheetHeader>

      <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <slot />
      </div>

      <div v-if="$slots.footer" class="flex items-center justify-end gap-2 border-t border-line px-5 py-3">
        <slot name="footer" />
      </div>
    </SheetContent>
  </Sheet>
</template>
