/**
 * 反馈文案的唯一出口。成功/失败句式只在这里拼，页面与 composable 不直接调 toast，
 * 否则同一个动作在不同页面会说出不同的话。
 */
import { toast } from 'vue-sonner'

import { errorMessage } from '@/api/http'

export function notifySuccess(message: string): void {
  toast.success(message)
}

/** 失败一律带上原因：只报「失败」会让人不知道该改什么。 */
export function notifyFailure(action: string, error: unknown): void {
  toast.error(`${action}失败：${errorMessage(error)}`)
}

export function notifyInfo(message: string): void {
  toast(message)
}
