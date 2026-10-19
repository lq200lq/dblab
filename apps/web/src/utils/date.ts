/** 时间展示统一走这里：详情与列表用不同的精度，直接 toLocaleString 会到处不一致。 */

function toDate(value: string | null | undefined): Date | null {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** 详情页用：完整日期时间。 */
export function formatDateTime(value: string | null | undefined): string {
  const date = toDate(value)
  if (!date) return '—'
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** 审计列表用：MM-DD HH:MM:SS，跨年时才带上年份。 */
export function formatClock(value: string | null | undefined, now: number = Date.now()): string {
  const date = toDate(value)
  if (!date) return '—'
  const time = `${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  return new Date(now).getFullYear() === date.getFullYear() ? time : `${date.getFullYear()}-${time}`
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** 「最近使用」这类字段用：只说过去了多久。 */
export function formatRelative(value: string | null | undefined, now: number = Date.now()): string {
  const date = toDate(value)
  if (!date) return '从未使用'
  const elapsed = Math.max(0, now - date.getTime())
  if (elapsed < MINUTE) return '刚刚'
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} 分钟前`
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)} 小时前`
  return `${Math.floor(elapsed / DAY)} 天前`
}

/** 毫秒耗时：给一个扫一眼就有量级感的写法。 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—'
  if (ms < 1_000) return `${ms} ms`
  return `${(ms / 1_000).toFixed(2)} s`
}

/** `<input type="date">` 的取值：只到日。 */
export function toDateInputValue(value: string | null | undefined): string {
  const date = toDate(value)
  return date ? `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` : ''
}
