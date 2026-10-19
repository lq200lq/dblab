<script setup lang="ts">
/**
 * 新建密钥：名称 + 有效期 + IP 白名单 + 授权矩阵。
 * 授权矩阵不是通用表单控件，所以这里直接用 Dialog 组装，表单校验仍走 useForm。
 */
import { computed, ref, watch } from 'vue'

import type { ApiKeyCreate, Datasource } from '@dblab/shared'
import { apiKeyCreateSchema } from '@dblab/shared'

import FormField from '@/components/common/FormField.vue'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useForm } from '@/composables/useForm'

import GrantMatrix from './GrantMatrix.vue'
import IpAllowlistEditor from './IpAllowlistEditor.vue'
import type { GrantRow } from './types'

const props = defineProps<{
  datasources: Datasource[]
  pending?: boolean
}>()

const emit = defineEmits<{ submit: [input: ApiKeyCreate] }>()
const open = defineModel<boolean>('open', { default: false })

const grants = ref<GrantRow[]>([])
const ipAllowlist = ref<string[]>([])

const form = useForm(apiKeyCreateSchema, { name: '', expiresAt: undefined })

watch(open, (value) => {
  if (value) {
    form.reset()
    grants.value = []
    ipAllowlist.value = []
  }
})

const grantSummary = computed(() => {
  const writable = grants.value.filter((row) => row.canWrite).length
  return `${grants.value.length} 个数据源（其中 ${writable} 个可写）`
})

async function onSubmit(): Promise<void> {
  await form.submit(async () => {
    // 界面填的是日期，到期时刻取当天最后一秒：选「10 月 20 日」不该让密钥在 20 号零点就失效。
    const expiresAt = typeof form.values.expiresAt === 'string' && form.values.expiresAt
      ? new Date(`${form.values.expiresAt}T23:59:59`).toISOString()
      : null
    emit('submit', {
      name: String(form.values.name ?? ''),
      expiresAt,
      ipAllowlist: ipAllowlist.value,
      grants: grants.value,
    })
  })
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle>新建密钥</DialogTitle>
        <DialogDescription class="hint">
          明文只在创建后显示一次；请按需给出最小授权。
        </DialogDescription>
      </DialogHeader>

      <div class="space-y-4">
        <div class="grid gap-4 md:grid-cols-2">
          <FormField label="名称" :error="form.errorOf('name')" html-for="key-name" required>
            <input
              id="key-name"
              class="input"
              placeholder="例如 analytics-agent"
              autocomplete="off"
              :value="String(form.values.name ?? '')"
              @input="form.values.name = ($event.target as HTMLInputElement).value"
            />
          </FormField>

          <FormField
            label="有效期"
            :error="form.errorOf('expiresAt')"
            hint="留空表示永不过期"
            html-for="key-expires"
          >
            <input
              id="key-expires"
              class="input"
              type="date"
              :value="String(form.values.expiresAt ?? '')"
              @input="form.values.expiresAt = ($event.target as HTMLInputElement).value"
            />
          </FormField>
        </div>

        <FormField label="IP 白名单" :error="form.errorOf('ipAllowlist')">
          <IpAllowlistEditor v-model="ipAllowlist" />
        </FormField>

        <div class="space-y-2">
          <p class="text-xs font-medium text-ink">授权（{{ grantSummary }}）</p>
          <GrantMatrix v-model="grants" :datasources="props.datasources" />
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" size="sm" :disabled="pending" @click="open = false">取消</Button>
        <Button size="sm" :disabled="pending" @click="onSubmit">
          {{ pending ? '创建中…' : '创建' }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
