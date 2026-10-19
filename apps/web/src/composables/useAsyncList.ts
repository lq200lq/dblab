/**
 * 列表数据源：把「拉取 + 三态 + 分页」收敛成一处，与 DataTable 的 props 一一对应。
 * 页面不再自己写 loading/error/empty，也不自己算分页。
 */
import { computed, ref, watch, type Ref } from 'vue'

import { errorMessage } from '@/api/http'

export interface ListPage<T> {
  items: T[]
  total: number
}

export interface UseAsyncListOptions<T> {
  fetcher: (query: { page: number; pageSize: number }) => Promise<ListPage<T>>
  pageSize?: number
  /** 过滤条件；变化时自动回到第一页并重取。 */
  filters?: () => Record<string, unknown>
  /** 挂载即取一次。 */
  immediate?: boolean
}

export interface AsyncList<T> {
  items: Ref<T[]>
  total: Ref<number>
  page: Ref<number>
  pageSize: Ref<number>
  totalPages: Ref<number>
  loading: Ref<boolean>
  error: Ref<string | null>
  refresh: () => Promise<void>
  setPage: (next: number) => Promise<void>
}

export function useAsyncList<T>(options: UseAsyncListOptions<T>): AsyncList<T> {
  const items = ref([]) as Ref<T[]>
  const total = ref(0)
  const page = ref(1)
  const pageSize = ref(options.pageSize ?? 20)
  const loading = ref(false)
  const error = ref<string | null>(null)

  const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)))

  let requestId = 0

  async function refresh(): Promise<void> {
    const current = ++requestId
    loading.value = true
    error.value = null
    try {
      const result = await options.fetcher({ page: page.value, pageSize: pageSize.value })
      // 晚到的响应不能覆盖新结果：过滤器连点两次时尤其明显。
      if (current !== requestId) return
      items.value = result.items
      total.value = result.total
    } catch (err) {
      if (current !== requestId) return
      error.value = errorMessage(err)
      items.value = []
      total.value = 0
    } finally {
      if (current === requestId) loading.value = false
    }
  }

  async function setPage(next: number): Promise<void> {
    const bounded = Math.min(Math.max(1, next), totalPages.value)
    if (bounded === page.value) return
    page.value = bounded
    await refresh()
  }

  if (options.filters) {
    watch(options.filters, () => {
      page.value = 1
      void refresh()
    })
  }

  if (options.immediate !== false) void refresh()

  return { items, total, page, pageSize, totalPages, loading, error, refresh, setPage }
}
