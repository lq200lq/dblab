/**
 * 复制到剪贴板的唯一出口：写入 + 回执文案。
 * 浏览器拒绝授权时不假装成功，改成提示手动选中。
 */
import { notifyInfo, notifySuccess } from '@/utils/notify'

export async function copyToClipboard(text: string): Promise<boolean> {
  const ok = await navigator.clipboard.writeText(text).then(
    () => true,
    () => false,
  )
  if (ok) notifySuccess('已复制到剪贴板')
  else notifyInfo('复制失败，请手动选中复制')
  return ok
}
