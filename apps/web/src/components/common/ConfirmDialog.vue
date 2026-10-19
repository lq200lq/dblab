<script setup lang="ts">
/**
 * 危险操作确认。**不可逆操作的护栏**：
 * 传了 requiredText 就必须一字不差地抄出来才放行，防止顺手回车。
 */
import { computed, ref, watch } from 'vue'

import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'

const props = withDefaults(
  defineProps<{
    title: string
    description?: string
    confirmLabel?: string
    cancelLabel?: string
    danger?: boolean
    requiredText?: string
    pending?: boolean
  }>(),
  {
    description: undefined,
    confirmLabel: '确认',
    cancelLabel: '取消',
    danger: false,
    requiredText: undefined,
    pending: false,
  },
)

const emit = defineEmits<{ confirm: []; cancel: [] }>()
const open = defineModel<boolean>('open', { default: false })

const typed = ref('')

watch(open, (value) => {
  if (value) typed.value = ''
})

const canConfirm = computed(
  () => !props.pending && (!props.requiredText || typed.value.trim() === props.requiredText),
)
</script>

<template>
  <AlertDialog :open="open" @update:open="(value: boolean) => (open = value)">
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>{{ title }}</AlertDialogTitle>
        <AlertDialogDescription v-if="description" class="hint">
          {{ description }}
        </AlertDialogDescription>
      </AlertDialogHeader>

      <div v-if="requiredText" class="space-y-1">
        <p class="hint">
          请输入 <span class="mono text-ink">{{ requiredText }}</span> 以确认
        </p>
        <input v-model="typed" class="input" autocomplete="off" />
      </div>

      <AlertDialogFooter>
        <Button variant="outline" size="sm" :disabled="pending" @click="emit('cancel')">
          {{ cancelLabel }}
        </Button>
        <Button
          :variant="danger ? 'destructive' : 'default'"
          size="sm"
          :disabled="!canConfirm"
          @click="emit('confirm')"
        >
          {{ pending ? '处理中…' : confirmLabel }}
        </Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>
