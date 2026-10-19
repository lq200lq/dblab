/**
 * 表单封装：zod 校验、字段级错误、提交态，三件事只在这里做一次。
 * 校验错误贴在字段上（不放 toast）——用户要一边看字段一边改。
 */
import { reactive, ref, type Ref } from 'vue'
import type { ZodType } from 'zod'

export interface UseFormResult<Output> {
  values: Record<string, unknown>
  errors: Ref<Record<string, string>>
  submitting: Ref<boolean>
  errorOf: (field: string) => string | undefined
  submit: (handler: (parsed: Output) => Promise<void>) => Promise<boolean>
  reset: (next?: Record<string, unknown>) => void
}

export function useForm<Output = Record<string, unknown>>(
  schema: ZodType<Output>,
  initial: Record<string, unknown>,
): UseFormResult<Output> {
  const values = reactive<Record<string, unknown>>({ ...initial })
  const errors = ref<Record<string, string>>({})
  const submitting = ref(false)

  function errorOf(field: string): string | undefined {
    return errors.value[field]
  }

  function reset(next?: Record<string, unknown>): void {
    for (const key of Object.keys(values)) {
      if (!next || !(key in next)) delete values[key]
    }
    Object.assign(values, initial, next ?? {})
    errors.value = {}
  }

  async function submit(handler: (parsed: Output) => Promise<void>): Promise<boolean> {
    errors.value = {}
    const parsed = schema.safeParse({ ...values })
    if (!parsed.success) {
      const collected: Record<string, string> = {}
      for (const issue of parsed.error.issues) {
        const field = issue.path.join('.') || '_'
        // 每个字段只展示第一条：多行错误会把表单撑高，用户也只看得到最先要改的那条。
        if (!(field in collected)) collected[field] = issue.message
      }
      errors.value = collected
      return false
    }

    submitting.value = true
    try {
      await handler(parsed.data)
      return true
    } finally {
      submitting.value = false
    }
  }

  return { values, errors, submitting, errorOf, submit, reset }
}
