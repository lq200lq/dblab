<script setup lang="ts">
/**
 * 弹窗表单壳。调用方只给 zod schema + 字段描述，控件布局、字段级错误、
 * 提交态禁用都在这儿做一次，页面不重复实现。
 *
 * 校验不过不会 emit：错误直接贴在字段上；提交由父组件负责（它才知道成功后关不关）。
 */
import { watch } from 'vue'
import type { ZodType } from 'zod'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import { useForm } from '@/composables/useForm'

import FormField from './FormField.vue'
import type { FormFieldSpec } from './types'

const props = withDefaults(
  defineProps<{
    title: string
    description?: string
    schema: ZodType
    fields: FormFieldSpec[]
    initial: Record<string, unknown>
    submitLabel?: string
    /** 次要动作的文案（例如「测试连接」）；不传就不渲染这个按钮。 */
    secondaryLabel?: string
    /** 次要动作的进行态由父组件持有：它才知道请求什么时候回来。 */
    secondaryPending?: boolean
    pending?: boolean
    width?: string
  }>(),
  {
    description: undefined,
    submitLabel: '保存',
    secondaryLabel: undefined,
    secondaryPending: false,
    pending: false,
    width: 'sm:max-w-lg',
  },
)

const emit = defineEmits<{
  submit: [values: Record<string, unknown>]
  secondary: [values: Record<string, unknown>]
  change: []
}>()
const open = defineModel<boolean>('open', { default: false })

const form = useForm(props.schema, props.initial)

// 每次打开都从 initial 重来：上一次输到一半的内容不该带到下一次。
watch(open, (value) => {
  if (value) form.reset()
})

// 值一变，父组件先前的次要动作结论（比如一次连接探测）就不再代表当前配置了。
watch(form.values, () => emit('change'), { deep: true })

function textOf(name: string): string {
  const value = form.values[name]
  return value === null || value === undefined ? '' : String(value)
}

function setText(name: string, event: Event): void {
  const target = event.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
  form.values[name] = target.value
}

function setNumber(name: string, event: Event): void {
  const raw = (event.target as HTMLInputElement).value
  form.values[name] = raw === '' ? undefined : Number(raw)
}

async function onSubmit(): Promise<void> {
  await form.submit(async (parsed) => {
    emit('submit', parsed as Record<string, unknown>)
  })
}

/** 次要动作也先过一遍校验：拿半填的表单去连库，只会返回一个没意义的失败。 */
async function onSecondary(): Promise<void> {
  await form.submit(async (parsed) => {
    emit('secondary', parsed as Record<string, unknown>)
  })
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent :class="width">
      <DialogHeader>
        <DialogTitle>{{ title }}</DialogTitle>
        <DialogDescription v-if="description" class="hint">{{ description }}</DialogDescription>
      </DialogHeader>

      <form class="grid gap-4 md:grid-cols-2" @submit.prevent="onSubmit">
        <FormField
          v-for="field in fields"
          :key="field.name"
          :label="field.label"
          :error="form.errorOf(field.name)"
          :hint="field.hint"
          :required="field.required"
          :html-for="`field-${field.name}`"
          :class="field.full || fields.length === 1 || field.kind === 'textarea' ? 'md:col-span-2' : ''"
        >
          <textarea
            v-if="field.kind === 'textarea'"
            :id="`field-${field.name}`"
            class="input min-h-20"
            :class="field.mono ? 'mono' : ''"
            :placeholder="field.placeholder"
            :disabled="field.disabled"
            :value="textOf(field.name)"
            @input="setText(field.name, $event)"
          />

          <select
            v-else-if="field.kind === 'select'"
            :id="`field-${field.name}`"
            class="input"
            :disabled="field.disabled"
            :value="textOf(field.name)"
            @change="setText(field.name, $event)"
          >
            <option value="">{{ field.placeholder ?? '请选择' }}</option>
            <option v-for="option in field.options ?? []" :key="option.value" :value="option.value">
              {{ option.label }}
            </option>
          </select>

          <div v-else-if="field.kind === 'switch'" class="pt-1">
            <Switch
              :model-value="form.values[field.name] === true"
              :disabled="field.disabled"
              @update:model-value="(value: boolean) => (form.values[field.name] = value)"
            />
          </div>

          <input
            v-else
            :id="`field-${field.name}`"
            class="input"
            :class="field.mono ? 'mono' : ''"
            :type="field.kind === 'password' ? 'password' : field.kind === 'date' ? 'date' : field.kind === 'number' ? 'number' : 'text'"
            :placeholder="field.placeholder"
            :disabled="field.disabled"
            autocomplete="off"
            :value="textOf(field.name)"
            @input="field.kind === 'number' ? setNumber(field.name, $event) : setText(field.name, $event)"
          />
        </FormField>
      </form>

      <slot name="extra" />

      <DialogFooter>
        <Button
          v-if="secondaryLabel"
          variant="outline"
          size="sm"
          :disabled="pending || secondaryPending"
          @click="onSecondary"
        >
          {{ secondaryPending ? '进行中…' : secondaryLabel }}
        </Button>
        <Button variant="outline" size="sm" :disabled="pending" @click="open = false">取消</Button>
        <Button size="sm" :disabled="pending" @click="onSubmit">
          {{ pending ? '提交中…' : submitLabel }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
