/**
 * 危险操作的确认流：调用方 `await confirm({...})`，拿到 true/false 再动手。
 * 弹窗本身是 ConfirmDialog（统一文案与样式），这里只管状态与 Promise。
 *
 * open/options 是两个独立 ref：视图里解构到 setup 顶层后才能被模板自动解包。
 */
import { ref, type Ref } from 'vue'

export interface ConfirmOptions {
  title: string
  description?: string
  confirmLabel?: string
  cancelLabel?: string
  /** 危险操作统一红色按钮。 */
  danger?: boolean
  /** 要求手抄资源名才放行，用于不可逆的删除/吊销。 */
  requiredText?: string
}

export interface UseConfirmResult {
  open: Ref<boolean>
  options: Ref<ConfirmOptions>
  confirm: (options: ConfirmOptions) => Promise<boolean>
  resolve: (accepted: boolean) => void
}

export function useConfirm(): UseConfirmResult {
  const open = ref(false)
  const options = ref<ConfirmOptions>({ title: '' })
  let settle: ((accepted: boolean) => void) | null = null

  function confirm(next: ConfirmOptions): Promise<boolean> {
    // 上一个还没关就又开一个：按取消处理，避免悬挂的 Promise。
    settle?.(false)
    options.value = next
    open.value = true
    return new Promise<boolean>((resolve) => {
      settle = resolve
    })
  }

  function resolve(accepted: boolean): void {
    open.value = false
    settle?.(accepted)
    settle = null
  }

  return { open, options, confirm, resolve }
}
