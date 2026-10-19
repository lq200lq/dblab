<script setup lang="ts">
/**
 * 明文密钥的一次性展示。
 *
 * 两个约束写死在组件里：
 * 1. **只有创建流程能到达这里**——它不在任何「查看」入口上，因为它拿的就是明文本身；
 * 2. 关闭时把组件内的副本清掉（不只是清 DOM），并且通知父组件丢弃它那份。
 */
import { ref, watch } from 'vue'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { copyToClipboard } from '@/utils/clipboard'

const props = withDefaults(
  defineProps<{
    title?: string
    secret: string
    hint?: string
  }>(),
  { title: '密钥已创建', hint: '请立即复制保存，关闭后无法再次查看' },
)

const emit = defineEmits<{ closed: [] }>()
const open = defineModel<boolean>('open', { default: false })

const shown = ref('')

watch(open, (value) => {
  // 打开时拷一份到本地，关闭时清空：值不留在组件状态里。
  shown.value = value ? props.secret : ''
})

watch(
  () => props.secret,
  (value) => {
    if (open.value) shown.value = value
  },
)

function onOpenChange(value: boolean): void {
  open.value = value
  if (!value) {
    shown.value = ''
    emit('closed')
  }
}

async function copy(): Promise<void> {
  await copyToClipboard(shown.value)
}
</script>

<template>
  <Dialog :open="open" @update:open="onOpenChange">
    <DialogContent class="sm:max-w-xl">
      <DialogHeader>
        <DialogTitle>{{ title }}</DialogTitle>
        <DialogDescription class="hint">{{ hint }}</DialogDescription>
      </DialogHeader>

      <div class="space-y-2">
        <pre
          class="mono max-h-32 overflow-auto rounded-md border border-line bg-muted p-3 text-xs break-all whitespace-pre-wrap"
        >{{ shown }}</pre>
        <div class="flex items-center justify-between">
          <p class="hint">服务端只保存它的摘要，无法再次还原。</p>
          <Button variant="outline" size="sm" @click="copy">复制</Button>
        </div>
      </div>

      <DialogFooter>
        <Button size="sm" @click="onOpenChange(false)">我已保存</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
