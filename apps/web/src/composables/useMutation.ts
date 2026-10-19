/**
 * 变更封装：提交态 + 失败提示（错误码 → 中文）只在这里拼。
 * 页面不直接调 toast，也不各写一遍 try/catch。
 */
import { ref, type Ref } from 'vue'

import { notifyFailure, notifySuccess } from '@/utils/notify'

export interface UseMutationOptions<TResult> {
  /** 成功后的文案；不传就不提示（例如静默刷新）。 */
  successMessage?: string | ((result: TResult) => string)
  /** 失败文案的动作名，拼成「<动作>失败：<原因>」。 */
  failureAction?: string
  onSuccess?: (result: TResult) => void | Promise<void>
  onFailure?: (error: unknown) => void
}

export interface UseMutationResult<TArgs extends unknown[], TResult> {
  pending: Ref<boolean>
  run: (...args: TArgs) => Promise<TResult | null>
}

export function useMutation<TArgs extends unknown[], TResult>(
  action: (...args: TArgs) => Promise<TResult>,
  options: UseMutationOptions<TResult> = {},
): UseMutationResult<TArgs, TResult> {
  const pending = ref(false)

  async function run(...args: TArgs): Promise<TResult | null> {
    pending.value = true
    try {
      const result = await action(...args)
      const message = typeof options.successMessage === 'function'
        ? options.successMessage(result)
        : options.successMessage
      if (message) notifySuccess(message)
      await options.onSuccess?.(result)
      return result
    } catch (error) {
      notifyFailure(options.failureAction ?? '操作', error)
      options.onFailure?.(error)
      return null
    } finally {
      pending.value = false
    }
  }

  return { pending, run }
}
