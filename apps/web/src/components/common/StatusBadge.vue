<script setup lang="ts">
/**
 * 状态 / 分类 / 决策的统一色板与中文标签。颜色只在这个文件里定义，
 * 页面与领域组件都通过它渲染，避免同一状态在不同页面是两种颜色。
 */
import { computed } from 'vue'

import type { Tone } from '@/utils/labels'

const props = withDefaults(
  defineProps<{
    label: string
    tone?: Tone
    /** 等宽（例如密钥前缀、引擎名）。 */
    mono?: boolean
  }>(),
  { tone: 'neutral', mono: false },
)

const TONE_CLASS: Record<Tone, string> = {
  ok: 'bg-wash-ok text-ok',
  warn: 'bg-wash-warn text-warn',
  danger: 'bg-wash-danger text-danger',
  accent: 'bg-accent text-accent-foreground',
  neutral: 'bg-wash-neutral text-neutral',
}

const classes = computed(() => TONE_CLASS[props.tone])
</script>

<template>
  <span
    class="inline-flex items-center gap-1 whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-medium"
    :class="[classes, mono ? 'font-mono' : '']"
  >
    {{ label }}
  </span>
</template>
