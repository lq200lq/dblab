<script setup lang="ts">
/**
 * 只读文本的复制按钮（密钥前缀、配置片段这类）。
 * 自带 @click.stop：它常落在可点的表格行里，复制不该顺手打开详情。
 */
import { onBeforeUnmount, ref } from 'vue'

import { CheckIcon, CopyIcon } from '@lucide/vue'

import { Button } from '@/components/ui/button'
import { copyToClipboard } from '@/utils/clipboard'

const props = withDefaults(
  defineProps<{
    text: string
    /** 提示要说清复制的是什么：前缀不是完整密钥，标签含糊会让人贴错东西。 */
    label?: string
  }>(),
  { label: '复制' },
)

const done = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined

async function onClick(): Promise<void> {
  if (!(await copyToClipboard(props.text))) return
  done.value = true
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    done.value = false
  }, 1_200)
}

onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
})
</script>

<template>
  <Button
    variant="ghost"
    size="icon-sm"
    :aria-label="label"
    :title="label"
    @click.stop="onClick"
  >
    <CheckIcon v-if="done" class="text-ok" />
    <CopyIcon v-else />
  </Button>
</template>
